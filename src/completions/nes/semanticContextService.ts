import * as vscode from 'vscode';
import { INeighborFileSnippet } from './similarFilesContextService';
import { cachedLexicalLines, selectLexicalWindow } from '../ghost/lexicalContext';
import { selectNeighborDocuments } from '../ghost/neighborFileAccess';
import { detectLanguage } from '../shared/languageDetection';

const STOP_WORDS = new Set([
    'const', 'let', 'var', 'function', 'return', 'class', 'interface', 'type', 'import', 'from',
    'export', 'default', 'async', 'await', 'true', 'false', 'null', 'undefined', 'new', 'this',
    'if', 'else', 'for', 'while', 'switch', 'case', 'try', 'catch', 'throw', 'private', 'public',
]);

const IMPORT_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.go', '.rs', '.yaml', '.yml', '.json', '.jsonc'];
const IMPORT_DIRECTORY_ENTRIES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs', 'index.cjs', '__init__.py'];
const UNRESOLVED_IMPORT_RETRY_MS = 2_000;
const WEAK_CONTEXT_RETRY_MS = 2_000;

/** Keep the document's URI scheme and authority when resolving an import. */
export function relativeImportCandidates(documentUri: vscode.Uri, specifier: string, languageId?: string): vscode.Uri[] {
    if (!specifier.startsWith('.') || !['file', 'vscode-remote', 'vscode-vfs'].includes(documentUri.scheme)) {
        return [];
    }
    const pythonModule = languageId === 'python' && /^(\.+)([\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*)?$/u.exec(specifier);
    const importPath = pythonModule
        ? `${pythonModule[1].length === 1 ? './' : '../'.repeat(pythonModule[1].length - 1)}${(pythonModule[2] ?? '').replace(/\./g, '/')}`
        : specifier;
    const base = vscode.Uri.joinPath(documentUri, '..', importPath);
    if (/\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|yaml|yml|json|jsonc)$/i.test(base.path)) {
        return [base];
    }
    if (languageId === 'python') {
        // Python checks a package before a same-named module. Do not stat
        // unrelated language extensions for every relative import on remote FS.
        return [
            vscode.Uri.joinPath(base, '__init__.py'),
            base.with({ path: base.path + '.py' }),
            vscode.Uri.joinPath(base, '__init__.pyi'),
            base.with({ path: base.path + '.pyi' }),
        ];
    }
    return [
        ...IMPORT_EXTENSIONS.map(extension => extension ? base.with({ path: base.path + extension }) : base),
        ...IMPORT_DIRECTORY_ENTRIES.map(entry => vscode.Uri.joinPath(base, entry)),
    ];
}

export interface SemanticContextTimeouts {
    providerMs: number;
    importMs: number;
    documentMs: number;
}

/** Collects language-server-backed context without making the model infer project structure alone. */
export class SemanticContextService {
    private static readonly _cache = new Map<string, { expires: number; snippets: INeighborFileSnippet[] }>();
    private static readonly _documentIdentities = new WeakMap<vscode.TextDocument, number>();
    private static _nextDocumentIdentity = 0;
    private static readonly _importLookups = new Map<string, {
        expires: number;
        promise: Promise<vscode.Uri[]>;
        partial: vscode.Uri[];
    }>();

    constructor(private readonly _timeouts: SemanticContextTimeouts = {
        providerMs: 300, importMs: 200, documentMs: 200,
    }) {}

    async collect(
        document: vscode.TextDocument,
        position: vscode.Position,
        token?: vscode.CancellationToken,
    ): Promise<INeighborFileSnippet[]> {
        return this._collect(document, position, token, true);
    }

    private async _collect(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken | undefined,
        retryOnContextChange: boolean,
    ): Promise<INeighborFileSnippet[]> {
        if (token?.isCancellationRequested) return [];
        const sourceVersion = document.version;
        const openDocumentSnapshots = vscode.workspace.textDocuments.map(open => ({
            document: open, version: open.version, languageId: open.languageId,
        }));
        const symbols = this._candidateSymbols(document, position);
        const imports = this._importSpecifiers(document);
        const text = document.getText();
        // Untitled documents can be recreated with the same URI and version.
        // Include a small content fingerprint so semantic facts from an older
        // buffer can never leak into a newly opened editor.
        const fingerprint = `${text.length}:${text.slice(0, 160)}:${text.slice(-160)}`;
        // A definition, hover, or import can come from another open buffer.
        // Its version must invalidate this cache even when the active file did
        // not change, or NES will keep prompting with stale declarations.
        const openDocumentVersions = openDocumentSnapshots
            .map(({ document: open, version, languageId }) =>
                `${open.uri.toString()}@${SemanticContextService._documentIdentity(open)}:${version}:${languageId}`)
            .sort()
            .join('|');
        const cacheKey = `${this._timeouts.providerMs}:${this._timeouts.importMs}:${this._timeouts.documentMs}:${document.uri.toString()}:${SemanticContextService._documentIdentity(document)}:${detectLanguage(document).languageId}:${sourceVersion}:${fingerprint}:${position.line}:${position.character}:${symbols.map(symbol => document.getText(document.getWordRangeAtPosition(symbol.position) ?? new vscode.Range(symbol.position, symbol.position))).join(',')}:${imports.join(',')}:${openDocumentVersions}`;
        const cached = SemanticContextService._cache.get(cacheKey);
        if (cached && cached.expires > Date.now()) return cached.snippets;
        const locations: Array<{ uri: vscode.Uri; range: vscode.Range; score: number }> = [];
        // These providers depend only on the current snapshot. Start them
        // together so a slow language server costs one bounded wait instead
        // of several consecutive waits before the completion request.
        const directFactsPromise = this._collectCursorFacts(document, position, token);
        // Document symbols are useful even when the language server cannot resolve
        // a reference at the cursor (for example while a file is still being typed).
        // Prefer declarations close to the cursor so the model sees the active
        // function/class contract before unrelated workspace matches.
        const documentSymbolsPromise = this._execute<vscode.DocumentSymbol[] | vscode.SymbolInformation[]>(
            'vscode.executeDocumentSymbolProvider', document.uri, token,
        );
        const queries = symbols.filter(symbol => document.getWordRangeAtPosition(symbol.position)).map(async symbol => {
            const name = document.getText(document.getWordRangeAtPosition(symbol.position) ?? new vscode.Range(symbol.position, symbol.position));
            const [definitions, references, typeDefinitions, implementations, workspaceMatches] = await Promise.all([
                this._execute<vscode.Location | vscode.LocationLink[]>('vscode.executeDefinitionProvider', document.uri, symbol.position, token),
                this._execute<vscode.Location[]>('vscode.executeReferenceProvider', document.uri, symbol.position, token),
                this._execute<vscode.Location | vscode.LocationLink[]>('vscode.executeTypeDefinitionProvider', document.uri, symbol.position, token),
                this._execute<vscode.Location | vscode.LocationLink[]>('vscode.executeImplementationProvider', document.uri, symbol.position, token),
                this._execute<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', name, token),
            ]);
            const workspaceSymbols = !definitions && (!references || references.length === 0)
                ? workspaceMatches : undefined;
            return { symbol, definitions, references, typeDefinitions, implementations, workspaceSymbols };
        });
        const importUrisPromise = this._resolveImportsWithTimeout(document, imports, token);
        const [directFacts, documentSymbols, responses, importResult] = await Promise.all([
            directFactsPromise,
            documentSymbolsPromise,
            Promise.all(queries),
            importUrisPromise,
        ]);
        for (const symbol of this._flattenSymbols(documentSymbols)) {
            const distance = Math.abs(symbol.range.start.line - position.line);
            if (distance <= 80) {
                locations.push({
                    uri: document.uri,
                    range: symbol.range,
                    score: Math.max(1, 10 - distance / 12) + (symbol.range.start.line <= position.line ? 1 : 0),
                });
            }
        }
        for (const { symbol, definitions, references, typeDefinitions, implementations, workspaceSymbols } of responses) {
            for (const location of this._locations(definitions)) {
                locations.push({ uri: location.uri, range: location.range, score: symbol.score + 4 });
            }
            for (const location of (references ?? []).slice(0, 4)) {
                locations.push({ uri: location.uri, range: location.range, score: symbol.score });
            }
            for (const location of this._locations(typeDefinitions)) {
                locations.push({ uri: location.uri, range: location.range, score: symbol.score + 3 });
            }
            for (const location of this._locations(implementations)) {
                locations.push({ uri: location.uri, range: location.range, score: symbol.score + 2 });
            }
            for (const symbolInfo of (workspaceSymbols ?? []).slice(0, 3)) {
                locations.push({ uri: symbolInfo.location.uri, range: symbolInfo.location.range, score: symbol.score + 2 });
            }
        }

        // Imports are a high-signal relationship even when a language server is not
        // running (for example in a newly opened workspace or an unsupported language).
        for (const uri of importResult.uris) {
            locations.push({ uri, range: new vscode.Range(0, 0, 0, 0), score: 11 });
        }

        // Local document symbols do not establish a cross-file relationship.
        // Search open buffers when providers cannot resolve an external target.
        const sourceUri = document.uri.toString();
        const usedLexicalFallback = !locations.some(location => location.uri.toString() !== sourceUri);
        if (usedLexicalFallback) {
            const names = symbols.map(symbol => document.getText(document.getWordRangeAtPosition(symbol.position) ?? new vscode.Range(symbol.position, symbol.position)))
                .filter(name => name.length >= 3);
            const focus = [...new Set(names.map(name => name.toLowerCase()))];
            // Document symbols may also be unavailable while a provider starts.
            // Preserve the nearby in-file definition in that case.
            if (!locations.some(location => location.uri.toString() === sourceUri)
                && document.getText().length <= 200_000) {
                const selected = selectLexicalWindow(cachedLexicalLines(document), focus);
                if (selected) {
                    const line = selected.anchorLine;
                    locations.push({
                        uri: document.uri,
                        range: new vscode.Range(line, 0, line, document.lineAt(line).text.length),
                        score: 2 + Math.min(3, selected.score / 3),
                    });
                }
            }
            for (const target of selectNeighborDocuments(document, [...vscode.workspace.textDocuments].reverse())) {
                const selected = selectLexicalWindow(cachedLexicalLines(target), focus);
                if (selected) {
                    const line = selected.anchorLine;
                    locations.push({
                        uri: target.uri,
                        range: new vscode.Range(line, 0, line, target.lineAt(line).text.length),
                        score: 2 + Math.min(3, selected.score / 3),
                    });
                }
            }
        }

        const deduped = new Map<string, { uri: vscode.Uri; range: vscode.Range; score: number }>();
        for (const item of locations) {
            const key = `${item.uri.toString()}:${item.range.start.line}:${item.range.end.line}:${item.range.start.character}:${item.range.end.character}`;
            const existing = deduped.get(key);
            if (!existing || item.score > existing.score) deduped.set(key, item);
        }
        const result: INeighborFileSnippet[] = [...directFacts];
        let remainingChars = Math.max(0, 7_000 - directFacts.reduce((sum, fact) => sum + fact.snippet.length, 0));
        // A document symbol tree commonly returns a class, its method, and a
        // nested function as separate candidates. Their expanded snippets can
        // be almost identical, so select high-signal ranges before spending
        // the prompt budget. Keep disjoint ranges and allow a more specific
        // range to replace a weak enclosing range when it scores materially
        // higher (for example, a definition over a nearby file symbol).
        const selected = this._selectNonOverlappingLocations([...deduped.values()]);
        const chosen = remainingChars > 0 && !token?.isCancellationRequested ? selected.slice(0, 6) : [];
        // Give the fallback hit space early in the prompt budget. Six nearby
        // declarations can otherwise hide it or consume all 7,000 characters.
        if (usedLexicalFallback) {
            const external = selected.find(item => item.uri.toString() !== sourceUri);
            if (external) {
                const existingIndex = chosen.indexOf(external);
                if (existingIndex >= 0) chosen.splice(existingIndex, 1);
                chosen.splice(Math.min(1, chosen.length), 0, external);
                if (chosen.length > 6) chosen.pop();
            }
        }
        const pendingDocuments = new Map<string, Promise<vscode.TextDocument | undefined>>();
        const targetDocuments = await Promise.all(chosen.map(item => {
            const key = item.uri.toString();
            let pending = pendingDocuments.get(key);
            if (!pending) {
                pending = key === document.uri.toString()
                    ? Promise.resolve(document)
                    : this._openDocumentWithin(item.uri, this._timeouts.documentMs);
                pendingDocuments.set(key, pending);
            }
            return pending;
        }));
        for (const [index, item] of chosen.entries()) {
            if (token?.isCancellationRequested) break;
            if (remainingChars <= 0) break;
            try {
                const target = targetDocuments[index];
                if (!target) continue;
                const start = item.range.isEmpty ? 0 : Math.max(0, item.range.start.line - 6);
                const end = item.range.isEmpty ? Math.min(target.lineCount, 70) : Math.min(target.lineCount, item.range.end.line + 7);
                if (end <= start) continue;
                const snippet = target.getText(new vscode.Range(start, 0, end - 1, target.lineAt(end - 1).text.length));
                if (!snippet.trim()) continue;
                const clippedSnippet = snippet.slice(0, Math.min(1800, remainingChars));
                if (!clippedSnippet.trim()) continue;
                result.push({
                    uri: target.uri.toString(),
                    relativePath: vscode.workspace.asRelativePath(target.uri),
                    // The prompt formatter already labels the file and line
                    // range. A synthetic comment shifts every source line by
                    // one and is invalid syntax in several languages.
                    snippet: clippedSnippet,
                    lineRange: { startLine: start, endLineExclusive: end },
                    score: item.score,
                });
                remainingChars -= clippedSnippet.length;
            } catch {
                // A definition can point to an unavailable virtual or remote document.
            }
        }
        // A language server may return a definition in a file that cannot be
        // opened within the prompt budget. In that case its location alone is
        // not useful context; recover from an already open related buffer.
        if (!usedLexicalFallback && !token?.isCancellationRequested
            && !result.some(snippet => snippet.uri !== sourceUri)) {
            const focus = [...new Set(symbols.map(symbol => document.getText(
                document.getWordRangeAtPosition(symbol.position) ?? new vscode.Range(symbol.position, symbol.position),
            ).toLowerCase()).filter(name => name.length >= 3))];
            for (const target of selectNeighborDocuments(document, [...vscode.workspace.textDocuments].reverse())) {
                const selected = selectLexicalWindow(cachedLexicalLines(target), focus);
                if (!selected) continue;
                const start = Math.max(0, selected.anchorLine - 6);
                const end = Math.min(target.lineCount, selected.anchorLine + 7);
                if (end <= start) continue;
                const snippet = target.getText(new vscode.Range(start, 0, end - 1, target.lineAt(end - 1).text.length))
                    .slice(0, 1200);
                if (!snippet.trim()) continue;
                // Local declarations can fill the budget before a provider's
                // inaccessible external target is discovered. Give the open
                // related buffer one slot while retaining hover facts.
                while (remainingChars < snippet.length) {
                    let localIndex = -1;
                    for (let index = result.length - 1; index >= 0; index--) {
                        if (result[index].uri === sourceUri && result[index].kind !== 'facts') {
                            localIndex = index;
                            break;
                        }
                    }
                    if (localIndex < 0) break;
                    remainingChars += result[localIndex].snippet.length;
                    result.splice(localIndex, 1);
                }
                const clippedSnippet = snippet.slice(0, remainingChars);
                if (!clippedSnippet.trim()) continue;
                result.push({
                    uri: target.uri.toString(), relativePath: vscode.workspace.asRelativePath(target.uri),
                    snippet: clippedSnippet, lineRange: { startLine: start, endLineExclusive: end }, score: 2 + Math.min(3, selected.score / 3),
                });
                remainingChars -= clippedSnippet.length;
                break;
            }
        }
        // Language providers can finish after another editor buffer changes.
        // Never return facts from that older snapshot to a completion prompt.
        if (token?.isCancellationRequested || document.version !== sourceVersion) return [];
        const currentDocuments = new Map(vscode.workspace.textDocuments.map(open => [open.uri.toString(), open]));
        const contextChanged = openDocumentSnapshots.some(({ document: open, version, languageId }) =>
            currentDocuments.get(open.uri.toString()) !== open
                || open.version !== version || open.languageId !== languageId);
        if (contextChanged) {
            return retryOnContextChange ? this._collect(document, position, token, false) : [];
        }
        // Timed-out imports or document reads may become available shortly.
        // Retry soon instead of keeping an incomplete prompt context for 8s.
        if (!token?.isCancellationRequested) {
            SemanticContextService._cache.set(cacheKey, {
                expires: Date.now() + (importResult.timedOut || targetDocuments.some(target => !target)
                    ? 500 : imports.length > 0 && importResult.uris.length === 0 ? UNRESOLVED_IMPORT_RETRY_MS
                        : usedLexicalFallback ? WEAK_CONTEXT_RETRY_MS : 8_000),
                snippets: result,
            });
            if (SemanticContextService._cache.size > 128) {
                const first = SemanticContextService._cache.keys().next().value;
                if (first) SemanticContextService._cache.delete(first);
            }
        }
        return result;
    }

    private static _documentIdentity(document: vscode.TextDocument): number {
        let identity = this._documentIdentities.get(document);
        if (identity === undefined) {
            identity = ++this._nextDocumentIdentity;
            this._documentIdentities.set(document, identity);
        }
        return identity;
    }

    private async _openDocumentWithin(uri: vscode.Uri, timeoutMs: number): Promise<vscode.TextDocument | undefined> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                vscode.workspace.openTextDocument(uri),
                new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
            ]);
        } catch {
            return undefined;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private _selectNonOverlappingLocations(
        locations: Array<{ uri: vscode.Uri; range: vscode.Range; score: number }>,
    ): Array<{ uri: vscode.Uri; range: vscode.Range; score: number }> {
        const selected: Array<{ uri: vscode.Uri; range: vscode.Range; score: number }> = [];
        for (const candidate of locations.sort((a, b) => b.score - a.score)) {
            if (candidate.range.isEmpty) {
                selected.push(candidate);
                continue;
            }
            const candidateStart = candidate.range.start.line;
            const candidateEnd = Math.max(candidateStart + 1, candidate.range.end.line + 1);
            const overlaps = selected.find(existing => {
                if (existing.uri.toString() !== candidate.uri.toString() || existing.range.isEmpty) return false;
                const existingStart = existing.range.start.line;
                const existingEnd = Math.max(existingStart + 1, existing.range.end.line + 1);
                const overlap = Math.max(0, Math.min(candidateEnd, existingEnd) - Math.max(candidateStart, existingStart));
                const smaller = Math.min(candidateEnd - candidateStart, existingEnd - existingStart);
                return overlap / Math.max(1, smaller) >= 0.65;
            });
            if (!overlaps) {
                selected.push(candidate);
            }
        }
        return selected;
    }

    private async _collectCursorFacts(
        document: vscode.TextDocument,
        position: vscode.Position,
        token?: vscode.CancellationToken,
    ): Promise<INeighborFileSnippet[]> {
        if (token?.isCancellationRequested) return [];
        const [hover, signatureHelp] = await Promise.all([
            this._execute<vscode.Hover | vscode.Hover[]>('vscode.executeHoverProvider', document.uri, position, token),
            this._execute<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', document.uri, position, token),
        ]);
        const facts: string[] = [];
        for (const item of Array.isArray(hover) ? hover : hover ? [hover] : []) {
            const contents = (item as vscode.Hover).contents ?? [];
            const text = contents.map(content => this._markdownText(content)).filter(Boolean).join('\n');
            if (text) facts.push(text.slice(0, 1800));
        }
        const signatures = signatureHelp?.signatures ?? [];
        if (signatures.length > 0) {
            const active = signatures[signatureHelp?.activeSignature ?? 0] ?? signatures[0];
            const label = active.label ?? '';
            const documentation = active.documentation ? this._markdownText(active.documentation) : '';
            facts.push([label, documentation].filter(Boolean).join('\n'));
        }
        if (facts.length === 0) return [];
        return [{
            uri: document.uri.toString(),
            relativePath: vscode.workspace.asRelativePath(document.uri),
            snippet: facts.join('\n').slice(0, 2200),
            lineRange: { startLine: Math.max(0, position.line - 2), endLineExclusive: Math.min(document.lineCount, position.line + 3) },
            score: 15,
            kind: 'facts',
        }];
    }

    private _markdownText(value: unknown): string {
        if (typeof value === 'string') return value;
        if (value && typeof value === 'object') {
            const candidate = value as { value?: unknown; language?: unknown };
            if (typeof candidate.value === 'string') {
                return candidate.language ? `\`\`\`${String(candidate.language)}\n${candidate.value}\n\`\`\`` : candidate.value;
            }
        }
        return '';
    }

    private _flattenSymbols(value: vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined): Array<{ range: vscode.Range; name: string }> {
        if (!value) return [];
        const result: Array<{ range: vscode.Range; name: string }> = [];
        const visit = (symbol: vscode.DocumentSymbol): void => {
            result.push({ range: symbol.range, name: symbol.name });
            for (const child of symbol.children) visit(child);
        };
        for (const symbol of value) {
            if ('children' in symbol) visit(symbol);
            else result.push({ range: symbol.location.range, name: symbol.name });
        }
        return result;
    }

    private _candidateSymbols(document: vscode.TextDocument, position: vscode.Position): Array<{ position: vscode.Position; score: number }> {
        const result: Array<{ position: vscode.Position; score: number }> = [];
        const startLine = Math.max(0, position.line - 12);
        const endLine = Math.min(document.lineCount - 1, position.line + 1);
        const seen = new Set<string>();
        for (let line = startLine; line <= endLine; line++) {
            const text = document.lineAt(line).text;
            const expression = /[\p{L}_$][\p{L}\p{N}_$]{2,}/gu;
            let match: RegExpExecArray | null;
            while ((match = expression.exec(text))) {
                const value = match[0];
                if (STOP_WORDS.has(value) || value.length < 3) continue;
                const distance = Math.abs(line - position.line);
                const score = (line === position.line ? 8 : 3) - distance / 10;
                const key = `${value}:${line}`;
                if (seen.has(key)) continue;
                seen.add(key);
                result.push({ position: new vscode.Position(line, match.index), score });
            }
        }
        return result.sort((a, b) => b.score - a.score).slice(0, 4);
    }

    private _locations(value: vscode.Location | vscode.LocationLink[] | undefined): vscode.Location[] {
        if (!value) return [];
        if (Array.isArray(value)) {
            return value.map(item => 'targetUri' in item
                ? new vscode.Location(item.targetUri, item.targetSelectionRange ?? item.targetRange)
                : item);
        }
        return [value];
    }

    private _importSpecifiers(document: vscode.TextDocument): string[] {
        const source = document.getText();
        const result = new Set<string>();
        const memberCandidates = new Set<string>();
        const languageId = detectLanguage(document).languageId;
        const patterns = [
            /(?:from|import)\s*[('\"]([^'\"]+)[('\")]?/g,
            /require\s*\(\s*['\"]([^'\"]+)['\"]\s*\)/g,
            /(?:^|\n)\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g,
        ];
        for (const pattern of patterns) {
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(source))) {
                const specifier = (match[1] ?? match[2] ?? '').trim();
                if (specifier && specifier.length < 160) result.add(specifier);
            }
        }
        if (languageId === 'python') {
            // `from . import helpers` imports a sibling module, not just the
            // package's __init__.py. Resolve each named member as a possible
            // module when a language server cannot provide its definition.
            const membersPattern = /(?:^|\n)\s*from\s+(\.+(?:[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*)?)\s+import\s+(?:\(([^)]*)\)|([^\n#]+))/gu;
            let match: RegExpExecArray | null;
            while ((match = membersPattern.exec(source))) {
                const members = (match[2] ?? match[3]).replace(/#[^\n]*/g, '').split(',');
                for (const member of members) {
                    const name = member.trim().split(/\s+as\s+/u, 1)[0];
                    if (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name)) {
                        memberCandidates.add(`${match[1]}${match[1].endsWith('.') ? '' : '.'}${name}`);
                    }
                }
            }
        }
        if (['yaml', 'json', 'jsonc', 'json5'].includes(languageId)) {
            const addLocalReference = (value: string) => {
                const path = value.split(/[?#]/, 1)[0].trim();
                if (!path || path.length >= 160 || /^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('/')) return;
                result.add(path.startsWith('.') ? path : `./${path}`);
            };
            const referencePatterns = [
                /["']?(?:\$ref|include)["']?\s*:\s*["']?([^\s"'#,[\]}]+)/g,
                /!include\s+["']?([^\s"'#,[\]}]+)/g,
            ];
            for (const pattern of referencePatterns) {
                let match: RegExpExecArray | null;
                while ((match = pattern.exec(source))) addLocalReference(match[1]);
            }
        }
        return [...result, ...memberCandidates].slice(0, 12);
    }

    private async _resolveImports(
        document: vscode.TextDocument,
        imports: readonly string[],
        onProgress?: (uris: readonly vscode.Uri[]) => void,
    ): Promise<vscode.Uri[]> {
        if (imports.length === 0) return [];
        const isPython = detectLanguage(document).languageId === 'python';
        const resolved: vscode.Uri[][] = imports.map(() => []);
        const collected = (): vscode.Uri[] => {
            const seen = new Set<string>();
            return resolved.flat().filter(uri => {
                const key = uri.toString();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            }).slice(0, 6);
        };
        const resolveOne = async (specifier: string): Promise<vscode.Uri[]> => {
            const matchesForImport: vscode.Uri[] = [];
            const relativeCandidates = relativeImportCandidates(document.uri, specifier, isPython ? 'python' : undefined);
            const relativeStats = await Promise.allSettled(relativeCandidates.map(candidate => vscode.workspace.fs.stat(candidate)));
            for (let index = 0; index < relativeCandidates.length; index++) {
                const stat = relativeStats[index];
                if (stat.status === 'fulfilled' && stat.value.type === vscode.FileType.File) {
                    matchesForImport.push(relativeCandidates[index]);
                    if (isPython) break;
                }
            }
            if (matchesForImport.length > 0) return matchesForImport;
            // A missing relative import cannot refer to an unrelated file with
            // the same basename elsewhere in the workspace.
            if (specifier.startsWith('.')) return [];

            const normalized = isPython && /^[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)+$/u.test(specifier)
                ? specifier.replace(/\./g, '/')
                : specifier.replace(/^\.[/\\]/, '').replace(/[\\/]+/g, '/');
            if (!normalized || normalized.startsWith('@')) return [];
            try {
                const matches = await vscode.workspace.findFiles(
                    `**/${normalized}.{ts,tsx,js,jsx,mjs,cjs,py,java,go,rs,yaml,yml,json,jsonc}`,
                    '**/{node_modules,.git,dist,out}/**',
                    4,
                );
                matchesForImport.push(...matches);
                if (matches.length === 0) {
                    const indexMatches = await vscode.workspace.findFiles(
                        `**/${normalized}/index.{ts,tsx,js,jsx,mjs,cjs,py}`,
                        '**/{node_modules,.git,dist,out}/**',
                        4,
                    );
                    matchesForImport.push(...indexMatches);
                }
            } catch { /* workspace may not have a file index yet */ }
            return matchesForImport;
        };
        let nextIndex = 0;
        const worker = async (): Promise<void> => {
            while (nextIndex < imports.length) {
                const index = nextIndex++;
                resolved[index] = await resolveOne(imports[index]);
                onProgress?.(collected());
            }
        };
        await Promise.all(Array.from({ length: Math.min(3, imports.length) }, () => worker()));
        return collected();
    }

    private async _resolveImportsWithTimeout(
        document: vscode.TextDocument,
        imports: readonly string[],
        token?: vscode.CancellationToken,
    ): Promise<{ uris: vscode.Uri[]; timedOut: boolean }> {
        if (imports.length === 0) return { uris: [], timedOut: false };
        if (token?.isCancellationRequested) return { uris: [], timedOut: true };
        const key = `${document.uri.toString()}:${imports.join('\u0000')}`;
        let entry = SemanticContextService._importLookups.get(key);
        if (!entry || entry.expires <= Date.now()) {
            const lookup: { expires: number; promise: Promise<vscode.Uri[]>; partial: vscode.Uri[] } = {
                expires: Date.now() + 8_000,
                promise: Promise.resolve([]),
                partial: [],
            };
            lookup.promise = this._resolveImports(document, imports, uris => {
                lookup.partial = [...uris];
            }).catch(() => lookup.partial);
            lookup.promise.then(uris => {
                if (uris.length === 0 && SemanticContextService._importLookups.get(key) === lookup) {
                    lookup.expires = Math.min(lookup.expires, Date.now() + UNRESOLVED_IMPORT_RETRY_MS);
                }
            });
            entry = lookup;
            SemanticContextService._importLookups.set(key, entry);
            if (SemanticContextService._importLookups.size > 128) {
                const first = SemanticContextService._importLookups.keys().next().value;
                if (first) SemanticContextService._importLookups.delete(first);
            }
        }
        const activeLookup = entry;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancellation: vscode.Disposable | undefined;
        try {
            const cancelled = token && new Promise<{ uris: vscode.Uri[]; timedOut: boolean }>(resolve => {
                cancellation = token.onCancellationRequested(() => resolve({ uris: [], timedOut: true }));
                if (token.isCancellationRequested) resolve({ uris: [], timedOut: true });
            });
            return await Promise.race([
                activeLookup.promise.then(uris => ({ uris, timedOut: false })),
                new Promise<{ uris: vscode.Uri[]; timedOut: boolean }>(resolve => {
                    timer = setTimeout(() => resolve({ uris: [...activeLookup.partial], timedOut: true }), this._timeouts.importMs);
                }),
                ...(cancelled ? [cancelled] : []),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
            cancellation?.dispose();
        }
    }

    private async _execute<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
        const token = args[args.length - 1] as vscode.CancellationToken | undefined;
        const commandArgs = args.slice(0, -1);
        if (token?.isCancellationRequested) return undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancellation: vscode.Disposable | undefined;
        try {
            const cancelled = token && new Promise<undefined>(resolve => {
                cancellation = token.onCancellationRequested(() => resolve(undefined));
                if (token.isCancellationRequested) resolve(undefined);
            });
            const result = await Promise.race([
                vscode.commands.executeCommand<T>(command, ...commandArgs),
                new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), this._timeouts.providerMs); }),
                ...(cancelled ? [cancelled] : []),
            ]);
            return result as T | undefined;
        } catch {
            return undefined;
        } finally {
            if (timer) clearTimeout(timer);
            cancellation?.dispose();
        }
    }
}
