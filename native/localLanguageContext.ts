import * as vscode from 'vscode';
import type { Copilot } from '../vendor/copilot/src/platform/inlineCompletions/common/api';
import { ProviderTarget, type ILanguageContextProviderService } from '../vendor/copilot/src/platform/languageContextProvider/common/languageContextProviderService';
import type { IIgnoreService } from '../vendor/copilot/src/platform/ignore/common/ignoreService';
import { URI } from '../vendor/copilot/src/util/vs/base/common/uri';
import { SemanticContextService } from '../src/completions/nes/semanticContextService';

const semanticContext = new SemanticContextService({ providerMs: 600, importMs: 300, documentMs: 300 });

/** Feeds language-server context through the original Copilot context-provider interface. */
export function registerLocalLanguageContext(
    service: ILanguageContextProviderService,
    target: ProviderTarget,
    ignoreService: IIgnoreService,
): vscode.Disposable {
    return service.registerContextProvider<Copilot.CodeSnippet | Copilot.Trait>({
        id: 'localalot.semantic-context-provider',
        selector: [{ scheme: 'file' }, { scheme: 'untitled' }, { scheme: 'vscode-remote' }, { scheme: 'vscode-vfs' }],
        resolver: {
            resolve: async (request, token) => {
                const setting = target === ProviderTarget.NES
                    ? 'localalot.nes.semanticContextEnabled' : 'localalot.ghost.semanticContextEnabled';
                if (!vscode.workspace.getConfiguration().get<boolean>(setting, true)) return [];
                const doc = vscode.workspace.textDocuments.find(candidate =>
                    candidate.uri.toString() === request.documentContext.uri);
                if (!doc || doc.version !== request.documentContext.version || token.isCancellationRequested) {
                    return [];
                }
                const position = request.documentContext.position;
                if (!position || position.line < 0 || position.line >= doc.lineCount) return [];
                const snippets = await semanticContext.collect(doc, position, token);
                if (token.isCancellationRequested || doc.version !== request.documentContext.version) return [];
                const excluded = await Promise.all(snippets.map(async snippet => {
                    if (snippet.kind === 'facts') return false;
                    try {
                        return await ignoreService.isCopilotIgnored(URI.parse(snippet.uri));
                    } catch {
                        return true;
                    }
                }));
                if (token.isCancellationRequested || doc.version !== request.documentContext.version) return [];
                return snippets.filter((snippet, index) => !excluded[index] && (target === ProviderTarget.NES
                    || snippet.kind === 'facts'
                    || snippet.uri !== doc.uri.toString()
                    || snippet.lineRange.endLineExclusive < position.line - 60
                    || snippet.lineRange.startLine > position.line + 60)).map(snippet => {
                    const importance = Math.max(0, Math.min(100, Math.round(snippet.score * 7)));
                    if (snippet.kind === 'facts') {
                        return { name: 'Cursor symbol facts', value: snippet.snippet, importance };
                    }
                    return { uri: snippet.uri, value: snippet.snippet, importance };
                });
            },
        },
    }, [target]);
}
