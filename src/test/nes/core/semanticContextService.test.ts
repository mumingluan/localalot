import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SemanticContextService, relativeImportCandidates } from '../../../completions/nes/semanticContextService';

suite('NES semantic context', () => {
    test('keeps a cross-file fallback when local document symbols fill the candidate slots', async () => {
        const symbol = `crossFileFallback${Date.now()}`;
        const source = await vscode.workspace.openTextDocument({
            language: 'typescript',
            content: [
                ...Array.from({ length: 6 }, (_, index) => `function local${index}() { return '${'x'.repeat(1050)}'; }`),
                `${symbol}();`,
            ].join('\n'),
        });
        const target = await vscode.workspace.openTextDocument({
            language: 'typescript',
            content: `export function ${symbol}() { return 42; }`,
        });
        const symbols = Array.from({ length: 6 }, (_, index) => new vscode.DocumentSymbol(
            `local${index}`, 'function', vscode.SymbolKind.Function,
            new vscode.Range(index, 0, index, source.lineAt(index).text.length),
            new vscode.Range(index, 9, index, 15),
        ));
        const service = new SemanticContextService() as unknown as {
            collect(document: vscode.TextDocument, position: vscode.Position): Promise<Array<{ uri: string; snippet: string }>>;
            _execute: (command: string) => Promise<vscode.DocumentSymbol[] | undefined>;
            _collectCursorFacts: () => Promise<[]>;
        };
        service._execute = async command => command === 'vscode.executeDocumentSymbolProvider' ? symbols : undefined;
        service._collectCursorFacts = async () => [];
        const context = await service.collect(source, new vscode.Position(6, 5));
        assert.ok(context.some(item => item.uri === source.uri.toString() && item.snippet.includes('local0')));
        assert.ok(context.some(item => item.uri === target.uri.toString() && item.snippet.includes(symbol)));
    });

    test('uses a TSX open buffer when TypeScript language providers are unavailable', async () => {
        const neighbor = await vscode.workspace.openTextDocument({
            language: 'typescriptreact',
            content: 'export function uniqueTsxSemanticHelper(invoice: Invoice) { return invoice.total; }',
        });
        const source = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'uniqueTsxSemanticHelper(invoice);',
        });
        const service = new SemanticContextService() as unknown as {
            collect(document: vscode.TextDocument, position: vscode.Position): Promise<Array<{ uri: string; snippet: string }>>;
            _execute: () => Promise<undefined>;
            _collectCursorFacts: () => Promise<[]>;
        };
        service._execute = async () => undefined;
        service._collectCursorFacts = async () => [];
        const context = await service.collect(source, new vscode.Position(0, 10));
        assert.ok(context.some(item => item.uri === neighbor.uri.toString()
            && item.snippet.includes('uniqueTsxSemanticHelper')));
    });

    test('uses an open related buffer when an external definition cannot be read', async () => {
        const name = `unavailableDefinitionFallback${Date.now()}`;
        const neighbor = await vscode.workspace.openTextDocument({
            language: 'typescript', content: `export function ${name}() { return 42; }`,
        });
        const source = await vscode.workspace.openTextDocument({
            language: 'typescript', content: [
                ...Array.from({ length: 6 }, (_, index) => `function local${index}() { return '${'x'.repeat(1050)}'; }`),
                `${name}();`,
            ].join('\n'),
        });
        const unavailable = vscode.Uri.file(path.join(os.tmpdir(), `${name}.ts`));
        const localSymbols = Array.from({ length: 6 }, (_, index) => new vscode.DocumentSymbol(
            `local${index}`, 'function', vscode.SymbolKind.Function,
            new vscode.Range(index, 0, index, source.lineAt(index).text.length),
            new vscode.Range(index, 9, index, 15),
        ));
        const service = new SemanticContextService() as unknown as {
            collect(document: vscode.TextDocument, position: vscode.Position): Promise<Array<{ uri: string; snippet: string }>>;
            _execute: (command: string) => Promise<vscode.Location | vscode.DocumentSymbol[] | undefined>;
            _collectCursorFacts: () => Promise<[]>;
            _openDocumentWithin: () => Promise<undefined>;
        };
        service._execute = async command => command === 'vscode.executeDefinitionProvider'
            ? new vscode.Location(unavailable, new vscode.Range(0, 0, 0, name.length))
            : command === 'vscode.executeDocumentSymbolProvider' ? localSymbols : undefined;
        service._collectCursorFacts = async () => [];
        service._openDocumentWithin = async () => undefined;
        const context = await service.collect(source, new vscode.Position(6, 8));
        assert.ok(context.some(item => item.uri === neighbor.uri.toString() && item.snippet.includes(name)));
        assert.ok(context.reduce((total, item) => total + item.snippet.length, 0) <= 7_000);
    });

    test('resolves relative imports within local and remote document authorities', () => {
        for (const source of [
            vscode.Uri.file('C:/workspace/src/main.ts'),
            vscode.Uri.parse('vscode-remote://ssh-remote+dev/home/user/src/main.ts'),
            vscode.Uri.parse('vscode-vfs://github/repository/src/main.ts'),
        ]) {
            const candidates = relativeImportCandidates(source, '../lib/helper');
            assert.strictEqual(candidates[0].scheme, source.scheme);
            assert.strictEqual(candidates[0].authority, source.authority);
            assert.strictEqual(candidates[0].path, source.path.replace(/\/src\/main\.ts$/, '/lib/helper'));
            assert.strictEqual(candidates[1].path, `${candidates[0].path}.ts`);
        }
        assert.deepStrictEqual(relativeImportCandidates(vscode.Uri.parse('output:/logs'), './helper'), []);
        assert.ok(relativeImportCandidates(vscode.Uri.file('C:/workspace/compose.yaml'), './services/db')
            .some(candidate => candidate.path.endsWith('/services/db.yaml')));
        const explicitReference = relativeImportCandidates(vscode.Uri.file('C:/workspace/compose.yaml'), './schema.json');
        assert.strictEqual(explicitReference.length, 1);
        assert.ok(explicitReference[0].path.endsWith('/schema.json'));
    });
    test('maps Python dotted relative imports to package paths', () => {
        const source = vscode.Uri.file('C:/workspace/pkg/sub/main.py');
        assert.ok(relativeImportCandidates(source, '.helpers', 'python')
            .some(candidate => candidate.path.endsWith('/pkg/sub/helpers.py')));
        assert.ok(relativeImportCandidates(source, '..utils', 'python')
            .some(candidate => candidate.path.endsWith('/pkg/utils.py')));
        assert.ok(relativeImportCandidates(source, '...shared.models', 'python')
            .some(candidate => candidate.path.endsWith('/workspace/shared/models.py')));
        assert.ok(relativeImportCandidates(source, '.', 'python')
            .some(candidate => candidate.path.endsWith('/pkg/sub/__init__.py')));
        assert.ok(relativeImportCandidates(source, '.helpers', 'python')
            .every(candidate => /(?:\.py|\.pyi)$/.test(candidate.path)));
    });
    test('resolves Python relative module definitions from the file system', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-python-semantic-'));
        try {
            const sourcePath = path.join(directory, 'pkg', 'sub', 'main.py');
            const helperPath = path.join(directory, 'pkg', 'sub', 'helpers.py');
            const utilsPath = path.join(directory, 'pkg', 'utils.py');
            await fs.mkdir(path.dirname(sourcePath), { recursive: true });
            await fs.writeFile(sourcePath, 'from .helpers import helper\nfrom ..utils import utility\n');
            await fs.writeFile(helperPath, 'def helper(): pass\n');
            await fs.writeFile(utilsPath, 'def utility(): pass\n');
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            const service = new SemanticContextService() as unknown as {
                _importSpecifiers: (document: vscode.TextDocument) => string[];
                _resolveImports: (document: vscode.TextDocument, imports: string[]) => Promise<vscode.Uri[]>;
            };
            const imports = service._importSpecifiers(document);
            assert.ok(imports.includes('.helpers'));
            assert.ok(imports.includes('..utils'));
            const resolved = await service._resolveImports(document, imports);
            assert.deepStrictEqual(resolved.map(uri => uri.toString()),
                [helperPath, utilsPath].map(file => vscode.Uri.file(file).toString()));
        } finally {
            await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
    test('resolves Python from-package member imports without a language server', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-python-members-'));
        try {
            const sourcePath = path.join(directory, 'pkg', 'sub', 'main.py');
            const helperPath = path.join(directory, 'pkg', 'sub', 'helpers.py');
            const settingsPath = path.join(directory, 'pkg', 'sub', 'settings.py');
            await fs.mkdir(path.dirname(sourcePath), { recursive: true });
            await fs.writeFile(sourcePath, 'from . import helpers, settings as cfg\n');
            await fs.writeFile(helperPath, 'def helper(): pass\n');
            await fs.writeFile(settingsPath, 'MODE = "prod"\n');
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            const service = new SemanticContextService() as unknown as {
                _importSpecifiers: (document: vscode.TextDocument) => string[];
                _resolveImports: (document: vscode.TextDocument, imports: string[]) => Promise<vscode.Uri[]>;
            };
            const imports = service._importSpecifiers(document);
            assert.ok(imports.includes('.helpers'));
            assert.ok(imports.includes('.settings'));
            const resolved = await service._resolveImports(document, imports);
            assert.ok(resolved.some(uri => uri.toString() === vscode.Uri.file(helperPath).toString()));
            assert.ok(resolved.some(uri => uri.toString() === vscode.Uri.file(settingsPath).toString()));
        } finally {
            await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
    test('resolves a module imported from a relative Python package', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-python-package-members-'));
        try {
            const sourcePath = path.join(directory, 'pkg', 'main.py');
            const packagePath = path.join(directory, 'pkg', 'services', '__init__.py');
            const shadowedModulePath = path.join(directory, 'pkg', 'services.py');
            const memberPath = path.join(directory, 'pkg', 'services', 'payments.py');
            await fs.mkdir(path.dirname(packagePath), { recursive: true });
            await fs.writeFile(sourcePath, 'from .services import payments as pay\n');
            await fs.writeFile(packagePath, '');
            await fs.writeFile(shadowedModulePath, 'legacy = True\n');
            await fs.writeFile(memberPath, 'def charge(): pass\n');
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            const service = new SemanticContextService() as unknown as {
                _importSpecifiers: (document: vscode.TextDocument) => string[];
                _resolveImports: (document: vscode.TextDocument, imports: string[]) => Promise<vscode.Uri[]>;
            };
            const imports = service._importSpecifiers(document);
            assert.ok(imports.includes('.services.payments'));
            const resolved = await service._resolveImports(document, imports);
            assert.ok(resolved.some(uri => uri.toString() === vscode.Uri.file(packagePath).toString()));
            assert.ok(!resolved.some(uri => uri.toString() === vscode.Uri.file(shadowedModulePath).toString()));
            assert.ok(resolved.some(uri => uri.toString() === vscode.Uri.file(memberPath).toString()));
        } finally {
            await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
    test('recognizes parent-package members in multiline Python imports', () => {
        const document = {
            uri: vscode.Uri.file('C:/workspace/pkg/sub/main.py'), languageId: 'python',
            getText: () => 'from .. import (\n    utilities,\n    settings as cfg,  # configured elsewhere\n)\n',
        } as vscode.TextDocument;
        const service = new SemanticContextService() as unknown as {
            _importSpecifiers: (document: vscode.TextDocument) => string[];
        };
        const imports = service._importSpecifiers(document);
        assert.ok(imports.includes('..utilities'));
        assert.ok(imports.includes('..settings'));
    });
    test('keeps direct Python imports ahead of speculative package members', () => {
        const document = {
            uri: vscode.Uri.file('C:/workspace/pkg/main.py'), languageId: 'python',
            getText: () => Array.from({ length: 11 }, (_, index) =>
                `from .module${index} import member${index}`).join('\n'),
        } as vscode.TextDocument;
        const service = new SemanticContextService() as unknown as {
            _importSpecifiers: (document: vscode.TextDocument) => string[];
        };
        const imports = service._importSpecifiers(document);
        assert.strictEqual(imports.length, 12);
        assert.ok(imports.includes('.module10'));
        assert.ok(imports.includes('.module0.member0'));
        assert.ok(!imports.includes('.module1.member1'));
    });
    test('resolves a relative directory import to its index module', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-semantic-import-'));
        try {
            const sourcePath = path.join(directory, 'main.ts');
            const modulePath = path.join(directory, 'helper', 'index.ts');
            await fs.mkdir(path.dirname(modulePath), { recursive: true });
            await fs.writeFile(sourcePath, "import { helper } from './helper';\nhelper();");
            await fs.writeFile(modulePath, 'export const helper = () => 42;');
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            const service = new SemanticContextService() as unknown as {
                _resolveImports: (document: vscode.TextDocument, imports: string[]) => Promise<vscode.Uri[]>;
            };
            const resolved = await service._resolveImports(document, ['./helper']);
            assert.deepStrictEqual(resolved.map(uri => uri.toString()), [vscode.Uri.file(modulePath).toString()]);
            assert.deepStrictEqual(await service._resolveImports(document, ['./missing-helper']), []);
        } finally {
            await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
    test('follows local YAML includes and JSON schema references', async () => {
        const yaml = await vscode.workspace.openTextDocument({
            language: 'yaml',
            content: 'include: ./common.yaml\nservice: !include db.yml\n$ref: "./schema.json#/$defs/Service"',
        });
        const json = await vscode.workspace.openTextDocument({
            language: 'json',
            content: '{ "$ref": "schema.json#/$defs/Service", "remote": { "$ref": "https://example.com/schema.json" } }',
        });
        const service = new SemanticContextService() as unknown as {
            _importSpecifiers: (document: vscode.TextDocument) => string[];
        };
        assert.deepStrictEqual(service._importSpecifiers(yaml), ['./common.yaml', './schema.json', './db.yml']);
        assert.deepStrictEqual(service._importSpecifiers(json), ['./schema.json']);
        const yamlTemplate = {
            uri: vscode.Uri.file('C:/workspace/compose.yml.njk'), languageId: 'plaintext',
            getText: () => 'service: !include db.yml',
        } as vscode.TextDocument;
        assert.deepStrictEqual(service._importSpecifiers(yamlTemplate), ['./db.yml']);
    });
    test('keeps fast ghost snapshots separate from full NES semantic context', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: `uniqueSemantic${Date.now()}();`,
        });
        const fast = new SemanticContextService({ providerMs: 130, importMs: 130, documentMs: 60 });
        const full = new SemanticContextService();
        const fastInternals = fast as unknown as {
            _candidateSymbols: () => [];
            _importSpecifiers: () => [];
            _collectCursorFacts: () => Promise<[]>;
            _execute: () => Promise<undefined>;
        };
        fastInternals._candidateSymbols = () => [];
        fastInternals._importSpecifiers = () => [];
        fastInternals._collectCursorFacts = async () => [];
        fastInternals._execute = async () => undefined;
        const position = new vscode.Position(0, 3);
        assert.deepStrictEqual(await fast.collect(document, position), []);

        const fullInternals = full as unknown as {
            _candidateSymbols: () => [];
            _importSpecifiers: () => [];
            _collectCursorFacts: () => Promise<Array<{ snippet: string; uri: string; relativePath: string; lineRange: { startLine: number; endLineExclusive: number }; score: number; kind: 'facts' }>>;
            _execute: () => Promise<undefined>;
        };
        fullInternals._candidateSymbols = () => [];
        fullInternals._importSpecifiers = () => [];
        fullInternals._collectCursorFacts = async () => [{
            uri: document.uri.toString(), relativePath: 'unique.ts', snippet: 'hover fact',
            lineRange: { startLine: 0, endLineExclusive: 1 }, score: 15, kind: 'facts',
        }];
        fullInternals._execute = async () => undefined;
        assert.strictEqual((await full.collect(document, position))[0]?.snippet, 'hover fact');
    });

    test('retries empty semantic context soon after a language server becomes ready', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: `pendingLanguageServer${Date.now()}();`,
        });
        const service = new SemanticContextService();
        const internals = service as unknown as {
            _candidateSymbols: () => [];
            _importSpecifiers: () => [];
            _collectCursorFacts: () => Promise<Array<{ uri: string; relativePath: string; snippet: string; lineRange: { startLine: number; endLineExclusive: number }; score: number; kind: 'facts' }>>;
            _execute: () => Promise<undefined>;
        };
        internals._candidateSymbols = () => [];
        internals._importSpecifiers = () => [];
        let ready = false;
        internals._collectCursorFacts = async () => ready ? [{
            uri: document.uri.toString(), relativePath: 'ready.ts', snippet: 'definition ready',
            lineRange: { startLine: 0, endLineExclusive: 1 }, score: 15, kind: 'facts',
        }] : [];
        internals._execute = async () => undefined;
        const position = new vscode.Position(0, 3);
        assert.deepStrictEqual(await service.collect(document, position), []);
        const cache = (SemanticContextService as unknown as {
            _cache: Map<string, { expires: number }>;
        })._cache;
        const entry = [...cache].find(([key]) => key.includes(document.uri.toString()))?.[1];
        assert.ok(entry);
        assert.ok(entry.expires <= Date.now() + 2_100);
        ready = true;
        entry.expires = Date.now() - 1;
        assert.strictEqual((await service.collect(document, position))[0]?.snippet, 'definition ready');
    });

    test('does not cache partial semantic context from a cancelled request', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: `cancelledSemantic${Date.now()}();`,
        });
        const service = new SemanticContextService();
        const internals = service as unknown as {
            _candidateSymbols: () => [];
            _importSpecifiers: () => [];
            _collectCursorFacts: () => Promise<[]>;
            _execute: () => Promise<undefined>;
        };
        internals._candidateSymbols = () => [];
        internals._importSpecifiers = () => [];
        internals._collectCursorFacts = async () => [];
        internals._execute = async () => undefined;
        const cancellation = new vscode.CancellationTokenSource();
        cancellation.cancel();
        try {
            await service.collect(document, new vscode.Position(0, 3), cancellation.token);
            const cache = (SemanticContextService as unknown as { _cache: Map<string, unknown> })._cache;
            assert.ok(![...cache.keys()].some(key => key.includes(document.uri.toString())));
        } finally {
            cancellation.dispose();
        }
    });

    test('recollects semantic facts when an open dependency changes during provider wait', async () => {
        const source = await vscode.workspace.openTextDocument({
            language: 'typescript', content: `semanticRace${Date.now()}();`,
        });
        const dependency = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'export const value = "old";',
        });
        const service = new SemanticContextService();
        const internals = service as unknown as {
            _candidateSymbols: () => [];
            _importSpecifiers: () => [];
            _collectCursorFacts: () => Promise<Array<{
                uri: string; relativePath: string; snippet: string;
                lineRange: { startLine: number; endLineExclusive: number }; score: number; kind: 'facts';
            }>>;
            _execute: () => Promise<undefined>;
        };
        internals._candidateSymbols = () => [];
        internals._importSpecifiers = () => [];
        internals._execute = async () => undefined;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let calls = 0;
        internals._collectCursorFacts = async () => {
            calls++;
            const snippet = dependency.getText();
            if (calls === 1) await gate;
            return [{
                uri: dependency.uri.toString(), relativePath: 'dependency.ts', snippet,
                lineRange: { startLine: 0, endLineExclusive: 1 }, score: 15, kind: 'facts',
            }];
        };
        const pending = service.collect(source, new vscode.Position(0, 5));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(dependency.uri, new vscode.Range(0, 0, 0, dependency.lineAt(0).text.length),
            'export const value = "new";');
        try {
            assert.ok(await vscode.workspace.applyEdit(edit));
        } finally {
            release();
        }
        const context = await pending;
        assert.strictEqual(calls, 2);
        assert.ok(context.some(item => item.snippet.includes('"new"')));
        assert.ok(!context.some(item => item.snippet.includes('"old"')));
    });

    test('cancellation ends a pending language service wait before its timeout', async () => {
        const command = `localalot.test.semantic-delay-${Date.now()}`;
        let signalStarted!: () => void;
        const started = new Promise<void>(resolve => { signalStarted = resolve; });
        let release!: (value: string) => void;
        const held = new Promise<string>(resolve => { release = resolve; });
        const registration = vscode.commands.registerCommand(command, () => {
            signalStarted();
            return held;
        });
        const cancellation = new vscode.CancellationTokenSource();
        const service = new SemanticContextService({ providerMs: 500, importMs: 200, documentMs: 200 });
        const execute = (service as unknown as {
            _execute: (command: string, token: vscode.CancellationToken) => Promise<string | undefined>;
        })._execute.bind(service);
        try {
            const pending = execute(command, cancellation.token);
            await started;
            cancellation.cancel();
            const result = await Promise.race([
                pending.then(value => ({ completed: true, value })),
                new Promise<{ completed: false }>(resolve => setTimeout(() => resolve({ completed: false }), 100)),
            ]);
            assert.deepStrictEqual(result, { completed: true, value: undefined });
        } finally {
            release('late');
            cancellation.dispose();
            registration.dispose();
        }
    });
    test('recognizes Unicode identifiers near the cursor', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'python', content: '配置选项 = load_config()\nprint(配置选项)',
        });
        const service = new SemanticContextService() as unknown as {
            _candidateSymbols: (document: vscode.TextDocument, position: vscode.Position) =>
                Array<{ position: vscode.Position; score: number }>;
        };
        const symbols = service._candidateSymbols(document, new vscode.Position(1, 8));
        assert.ok(symbols.some(symbol => document.getText(document.getWordRangeAtPosition(symbol.position)) === '配置选项'));
    });

    test('bounds import lookup latency and reuses its eventual result', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'import { helper } from "./slow-lookup";\nhelper();',
        });
        const service = new SemanticContextService();
        const internals = service as unknown as {
            _resolveImports: () => Promise<vscode.Uri[]>;
            _resolveImportsWithTimeout: (doc: vscode.TextDocument, imports: string[]) =>
                Promise<{ uris: vscode.Uri[]; timedOut: boolean }>;
        };
        let release!: (uris: vscode.Uri[]) => void;
        const pending = new Promise<vscode.Uri[]>(resolve => { release = resolve; });
        let lookups = 0;
        internals._resolveImports = () => { lookups++; return pending; };
        const importName = `./slow-lookup-${Date.now()}`;
        const first = await internals._resolveImportsWithTimeout(document, [importName]);
        assert.deepStrictEqual(first, { uris: [], timedOut: true });

        const uri = vscode.Uri.file('C:/workspace/slow-lookup.ts');
        release([uri]);
        const second = await internals._resolveImportsWithTimeout(document, [importName]);
        assert.deepStrictEqual(second, { uris: [uri], timedOut: false });
        assert.strictEqual(lookups, 1);
    });

    test('keeps imports found before a later lookup times out', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: `import './fast-${Date.now()}';`,
        });
        const service = new SemanticContextService({ providerMs: 200, importMs: 25, documentMs: 200 });
        const internals = service as unknown as {
            _resolveImports: (doc: vscode.TextDocument, imports: string[], onProgress?: (uris: readonly vscode.Uri[]) => void) => Promise<vscode.Uri[]>;
            _resolveImportsWithTimeout: (doc: vscode.TextDocument, imports: string[]) =>
                Promise<{ uris: vscode.Uri[]; timedOut: boolean }>;
        };
        const firstUri = vscode.Uri.file('C:/workspace/fast.ts');
        const secondUri = vscode.Uri.file('C:/workspace/slow.ts');
        let release!: () => void;
        const slowLookup = new Promise<void>(resolve => { release = resolve; });
        internals._resolveImports = async (_doc, _imports, onProgress) => {
            onProgress?.([firstUri]);
            await slowLookup;
            return [firstUri, secondUri];
        };
        const importName = `./partial-${Date.now()}`;
        try {
            assert.deepStrictEqual(await internals._resolveImportsWithTimeout(document, [importName]),
                { uris: [firstUri], timedOut: true });
        } finally {
            release();
        }
        assert.deepStrictEqual(await internals._resolveImportsWithTimeout(document, [importName]),
            { uris: [firstUri, secondUri], timedOut: false });
    });

    test('cancellation ends a pending import lookup wait before its timeout', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: `import './cancelled-${Date.now()}';`,
        });
        const service = new SemanticContextService({ providerMs: 200, importMs: 500, documentMs: 200 });
        const internals = service as unknown as {
            _resolveImports: () => Promise<vscode.Uri[]>;
            _resolveImportsWithTimeout: (doc: vscode.TextDocument, imports: string[], token: vscode.CancellationToken) =>
                Promise<{ uris: vscode.Uri[]; timedOut: boolean }>;
        };
        let signalStarted!: () => void;
        const started = new Promise<void>(resolve => { signalStarted = resolve; });
        let release!: (uris: vscode.Uri[]) => void;
        internals._resolveImports = () => {
            signalStarted();
            return new Promise(resolve => { release = resolve; });
        };
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const pending = internals._resolveImportsWithTimeout(document, [`./unique-${Date.now()}`], cancellation.token);
            await started;
            cancellation.cancel();
            const result = await Promise.race([
                pending.then(value => ({ completed: true, value })),
                new Promise<{ completed: false }>(resolve => setTimeout(() => resolve({ completed: false }), 100)),
            ]);
            assert.deepStrictEqual(result, { completed: true, value: { uris: [], timedOut: true } });
        } finally {
            release([]);
            cancellation.dispose();
        }
    });

    test('retries unresolved imports sooner than resolved imports', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'import { helper } from "./new-module";',
        });
        const specifier = `./new-module-${Date.now()}`;
        const key = `${document.uri.toString()}:${specifier}`;
        const service = new SemanticContextService();
        const internals = service as unknown as {
            _resolveImports: () => Promise<vscode.Uri[]>;
            _resolveImportsWithTimeout: (doc: vscode.TextDocument, imports: string[]) =>
                Promise<{ uris: vscode.Uri[]; timedOut: boolean }>;
        };
        const lookups = (SemanticContextService as unknown as {
            _importLookups: Map<string, { expires: number }>;
        })._importLookups;
        let calls = 0;
        internals._resolveImports = async () => {
            calls++;
            return calls === 1 ? [] : [vscode.Uri.file('C:/workspace/new-module.ts')];
        };
        assert.deepStrictEqual(await internals._resolveImportsWithTimeout(document, [specifier]),
            { uris: [], timedOut: false });
        const first = lookups.get(key);
        assert.ok(first);
        assert.ok(first.expires <= Date.now() + 2_000);
        first.expires = Date.now() - 1;
        const resolved = await internals._resolveImportsWithTimeout(document, [specifier]);
        assert.strictEqual(resolved.uris.length, 1);
        assert.strictEqual(calls, 2);
        assert.ok(lookups.get(key)!.expires > Date.now() + 2_000);
    });

    test('starts independent language service lookups together', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'import { helper } from "./parallel-lookup";\nhelper();',
        });
        const service = new SemanticContextService();
        const internals = service as unknown as {
            _collectCursorFacts: () => Promise<[]>;
            _execute: () => Promise<[]>;
            _resolveImports: () => Promise<[]>;
        };
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const started = new Set<string>();
        internals._collectCursorFacts = async () => { started.add('facts'); await gate; return []; };
        internals._execute = async () => { started.add('symbols'); await gate; return []; };
        internals._resolveImports = async () => { started.add('imports'); await gate; return []; };
        const collection = service.collect(document, new vscode.Position(1, 2));
        try {
            assert.deepStrictEqual([...started].sort(), ['facts', 'imports', 'symbols']);
        } finally {
            release();
        }
        await collection;
    });

    test('starts workspace symbol fallback with definition lookups', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'helper();',
        });
        const service = new SemanticContextService();
        const internals = service as unknown as {
            _collectCursorFacts: () => Promise<[]>;
            _execute: (command: string) => Promise<undefined>;
        };
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const started = new Set<string>();
        internals._collectCursorFacts = async () => [];
        internals._execute = async command => {
            started.add(command);
            await gate;
            return undefined;
        };
        const collection = service.collect(document, new vscode.Position(0, 3));
        try {
            assert.ok(started.has('vscode.executeDefinitionProvider'));
            assert.ok(started.has('vscode.executeWorkspaceSymbolProvider'));
        } finally {
            release();
        }
        await collection;
    });

    test('finds a relevant definition past the first 200 lines without a language server', async () => {
        const symbol = `lateHelper${Date.now()}`;
        const source = await vscode.workspace.openTextDocument({
            language: 'typescript', content: `${symbol}();`,
        });
        const target = await vscode.workspace.openTextDocument({
            language: 'typescript', content: [
                ...Array.from({ length: 230 }, (_, index) => `const filler${index} = ${index};`),
                `export function ${symbol}() { return 42; }`,
            ].join('\n'),
        });
        const service = new SemanticContextService();
        const internals = service as unknown as {
            _collectCursorFacts: () => Promise<[]>;
            _execute: () => Promise<undefined>;
        };
        internals._collectCursorFacts = async () => [];
        internals._execute = async () => undefined;
        const snippets = await service.collect(source, new vscode.Position(0, 5));
        const definition = snippets.find(snippet => snippet.uri === target.uri.toString()
            && snippet.snippet.includes(`export function ${symbol}`));
        assert.ok(definition);
        assert.strictEqual(definition.snippet.split('\n')[0], target.lineAt(definition.lineRange.startLine).text);
    });

    test('refreshes semantic context when another open document changes', async () => {
        const symbol = `changingHelper${Date.now()}`;
        const source = await vscode.workspace.openTextDocument({
            language: 'typescript', content: `${symbol}();`,
        });
        const target = await vscode.workspace.openTextDocument({
            language: 'typescript', content: `export function ${symbol}() { return 1; }`,
        });
        const service = new SemanticContextService();
        const internals = service as unknown as {
            _collectCursorFacts: () => Promise<[]>;
            _execute: () => Promise<undefined>;
        };
        internals._collectCursorFacts = async () => [];
        internals._execute = async () => undefined;
        const position = new vscode.Position(0, 5);
        const first = await service.collect(source, position);
        assert.ok(first.some(item => item.uri === target.uri.toString() && item.snippet.includes('return 1')));

        const edit = new vscode.WorkspaceEdit();
        edit.replace(target.uri, target.lineAt(0).range, `export function ${symbol}() { return 2; }`);
        assert.ok(await vscode.workspace.applyEdit(edit));
        const second = await service.collect(source, position);
        assert.ok(second.some(item => item.uri === target.uri.toString() && item.snippet.includes('return 2')));
        assert.ok(!second.some(item => item.uri === target.uri.toString() && item.snippet.includes('return 1')));
    });

    test('includes hover and signature facts at the cursor', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript',
            content: 'const value = helper(1);\n',
        });
        const hover = vscode.languages.registerHoverProvider('typescript', {
            provideHover: () => new vscode.Hover('helper(value: number): string'),
        });
        const signature = vscode.languages.registerSignatureHelpProvider('typescript', {
            provideSignatureHelp: () => {
                const info = new vscode.SignatureInformation('helper(value: number): string', 'Returns a formatted value');
                const help = new vscode.SignatureHelp();
                help.signatures = [info];
                help.activeSignature = 0;
                help.activeParameter = 0;
                return help;
            },
        }, '(', ',');
        try {
            const snippets = await new SemanticContextService().collect(document, new vscode.Position(0, 20));
            assert.ok(snippets.some(snippet => snippet.snippet.includes('helper(value: number)')));
            assert.ok(!snippets.some(snippet => snippet.snippet.includes('// semantic facts')));
        } finally {
            hover.dispose();
            signature.dispose();
        }
    });

    test('prioritizes nearby document symbols when reference lookup is unavailable', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript',
            content: 'function render(value: string) {\n  return value.trim();\n}\n\nrender("x");\n',
        });
        const provider = vscode.languages.registerDocumentSymbolProvider('typescript', {
            provideDocumentSymbols: () => [new vscode.DocumentSymbol(
                'render', 'function', vscode.SymbolKind.Function,
                new vscode.Range(0, 0, 2, 1), new vscode.Range(0, 9, 0, 15),
            )],
        });
        try {
            const snippets = await new SemanticContextService().collect(document, new vscode.Position(4, 2));
            assert.ok(snippets.some(snippet => snippet.snippet.includes('function render')),
                JSON.stringify(snippets.map(snippet => ({ uri: snippet.uri, text: snippet.snippet.slice(0, 100) }))));
        } finally {
            provider.dispose();
        }
    });

    test('suppresses overlapping symbol ranges to preserve context budget', async () => {
        const service = new SemanticContextService() as unknown as {
            _selectNonOverlappingLocations(locations: Array<{ uri: vscode.Uri; range: vscode.Range; score: number }>): Array<unknown>;
        };
        const uri = vscode.Uri.parse('file:///workspace/service.ts');
        const selected = service._selectNonOverlappingLocations([
            { uri, range: new vscode.Range(0, 0, 20, 0), score: 8 },
            { uri, range: new vscode.Range(2, 0, 8, 0), score: 7 },
            { uri, range: new vscode.Range(30, 0, 35, 0), score: 6 },
        ]);
        assert.strictEqual(selected.length, 2);
    });

    test('collects definition snippets and references through VS Code providers', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const helper = 1;\nhelper();\n' });
        const provider = vscode.languages.registerDefinitionProvider('typescript', {
            provideDefinition: () => new vscode.Location(document.uri, new vscode.Range(0, 6, 0, 12)),
        });
        const references = vscode.languages.registerReferenceProvider('typescript', {
            provideReferences: () => [new vscode.Location(document.uri, new vscode.Range(1, 0, 1, 6))],
        });
        try {
            const snippets = await new SemanticContextService().collect(document, new vscode.Position(1, 2));
            assert.ok(snippets.some(snippet => snippet.snippet.includes('const helper = 1;')));
        } finally {
            provider.dispose();
            references.dispose();
        }
    });
});
