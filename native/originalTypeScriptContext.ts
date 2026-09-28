import * as vscode from 'vscode';
import { getLocalSetting } from '../src/config/compatConfiguration';
import type { Copilot } from '../vendor/copilot/src/platform/inlineCompletions/common/api';
import { ProviderTarget, type ILanguageContextProviderService } from '../vendor/copilot/src/platform/languageContextProvider/common/languageContextProviderService';
import { ContextKind, KnownSources, TriggerKind, type ContextItem, type RequestContext } from '../vendor/copilot/src/platform/languageServer/common/languageContextService';
import { IConfigurationService } from '../vendor/copilot/src/platform/configuration/common/configurationService';
import { ILogService } from '../vendor/copilot/src/platform/log/common/logService';
import { IExperimentationService } from '../vendor/copilot/src/platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../vendor/copilot/src/platform/telemetry/common/telemetry';
import type { IInstantiationService } from '../vendor/copilot/src/util/vs/platform/instantiation/common/instantiation';
import { TS6LanguageContextService } from '../vendor/copilot/src/extension/typescriptContext/vscode-node/ts6/tsContextService';
import { TS7LanguageContextService } from '../vendor/copilot/src/extension/typescriptContext/vscode-node/ts7/tsContextService';
import type { TSLanguageContextService } from '../vendor/copilot/src/extension/typescriptContext/vscode-node/tsContextService';
import { TypeScript } from '../vendor/copilot/src/extension/typescriptContext/vscode-node/tsService';

function convertItem(item: ContextItem): Copilot.SupportedContextItem | undefined {
    if (item.kind === ContextKind.Snippet) {
        return {
            importance: item.priority * 100,
            id: item.id,
            uri: item.uri.toString(),
            value: item.value,
            additionalUris: item.additionalUris?.map(uri => uri.toString()),
        };
    }
    if (item.kind === ContextKind.Trait) {
        return { importance: item.priority * 100, id: item.id, name: item.name, value: item.value };
    }
    if (item.kind === ContextKind.DiagnosticBag) {
        return { importance: item.priority * 100, id: item.id, uri: item.uri, values: item.values };
    }
    return undefined;
}

/** Connects the original TS server context engine to the standalone inline providers. */
export function registerOriginalTypeScriptContext(
    root: IInstantiationService,
    providers: ILanguageContextProviderService,
    target: ProviderTarget,
): vscode.Disposable {
    const createLanguageContext = (): TSLanguageContextService => root.invokeFunction(accessor => {
        const telemetry = accessor.get(ITelemetryService);
        const configuration = accessor.get(IConfigurationService);
        const experimentation = accessor.get(IExperimentationService);
        const log = accessor.get(ILogService);
        return TypeScript.runsVersion7()
            ? new TS7LanguageContextService(telemetry, configuration, experimentation, log)
            : new TS6LanguageContextService(telemetry, configuration, experimentation, log);
    });
    let languageContext = createLanguageContext();
    let listeners: vscode.Disposable | undefined;
    try {
        const setting = target === ProviderTarget.NES
            ? 'localalot.nes.semanticContextEnabled' : 'localalot.ghost.semanticContextEnabled';
        let disposed = false;
        let pending: NodeJS.Timeout | undefined;
        const schedule = (document: vscode.TextDocument, position: vscode.Position) => {
            if (disposed || document.uri.scheme !== 'file'
                || !getLocalSetting<boolean>(setting, true)
                || !['typescript', 'typescriptreact'].includes(document.languageId)) return;
            if (pending) clearTimeout(pending);
            pending = setTimeout(() => {
                pending = undefined;
                if (disposed || !vscode.workspace.textDocuments.includes(document)) return;
                const service = languageContext;
                void service.isActivated(document).then(active => {
                    if (active && !disposed && service === languageContext) {
                        return service.populateCache(document, position, {
                            requestId: `localalot-ts-context-${Date.now()}`,
                            source: target === ProviderTarget.NES ? KnownSources.nes : KnownSources.completion,
                        });
                    }
                }).catch(() => undefined);
            }, 100);
        };
        listeners = vscode.Disposable.from(
            vscode.window.onDidChangeTextEditorSelection(event =>
                schedule(event.textEditor.document, event.selections[0]?.active ?? event.textEditor.selection.active)),
            vscode.workspace.onDidChangeTextDocument(event => {
                if (vscode.window.activeTextEditor?.document.uri.toString() === event.document.uri.toString()) {
                    schedule(event.document, vscode.window.activeTextEditor.selection.active);
                }
            }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (!TypeScript.affectsVersion(event)) return;
                const previous = languageContext;
                languageContext = createLanguageContext();
                previous.dispose();
                const editor = vscode.window.activeTextEditor;
                if (editor) schedule(editor.document, editor.selection.active);
            }),
            new vscode.Disposable(() => {
                disposed = true;
                if (pending) clearTimeout(pending);
            }),
        );
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) schedule(activeEditor.document, activeEditor.selection.active);
        const registration = providers.registerContextProvider<Copilot.SupportedContextItem>({
            id: 'typescript-ai-context-provider',
            selector: [
                { scheme: 'file', language: 'typescript' },
                { scheme: 'file', language: 'typescriptreact' },
            ],
            resolver: {
                resolve: async (request, token) => {
                    if (!getLocalSetting<boolean>(setting, true)) return [];
                    const document = vscode.workspace.textDocuments.find(open =>
                        open.uri.toString() === request.documentContext.uri);
                    if (!document || document.version !== request.documentContext.version
                        || token.isCancellationRequested) return [];
                    const requestPosition = request.documentContext.position;
                    const position = requestPosition
                        ? new vscode.Position(requestPosition.line, requestPosition.character)
                        : document.positionAt(request.documentContext.offset);
                    const service = languageContext;
                    if (!await service.isActivated(document) || service !== languageContext || token.isCancellationRequested
                        || document.version !== request.documentContext.version) return [];
                    const context: RequestContext = {
                        requestId: request.completionId,
                        opportunityId: request.opportunityId,
                        timeBudget: request.timeBudget,
                        tokenBudget: Math.max(0, 8 * 1024 - Math.trunc(document.getText().length / 4) - 256),
                        source: request.source === 'nes' ? KnownSources.nes : KnownSources.completion,
                        trigger: TriggerKind.completion,
                        proposedEdits: request.documentContext.proposedEdits === undefined ? undefined : [],
                        sampleTelemetry: 1,
                    };
                    if (context.tokenBudget === 0) return [];
                    const population = service.populateCache(document, position, context);
                    await Promise.race([
                        population,
                        new Promise<void>(resolve => setTimeout(resolve, Math.min(request.timeBudget ?? 100, 100))),
                    ]);
                    const result: Copilot.SupportedContextItem[] = [];
                    for await (const item of service.getContext(document, position, context, token)) {
                        if (service !== languageContext || token.isCancellationRequested
                            || document.version !== request.documentContext.version) return [];
                        const converted = convertItem(item);
                        if (converted) result.push(converted);
                    }
                    return result;
                },
            },
        }, [target]);
        return vscode.Disposable.from(registration, listeners, new vscode.Disposable(() => languageContext.dispose()));
    } catch (error) {
        listeners?.dispose();
        languageContext.dispose();
        throw error;
    }
}
