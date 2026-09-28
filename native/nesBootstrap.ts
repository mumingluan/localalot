import type { ExtensionContext, InlineCompletionItemProvider } from 'vscode';
import { IAuthenticationService } from '../vendor/copilot/src/platform/authentication/common/authentication';
import { IDiffService } from '../vendor/copilot/src/platform/diff/common/diffService';
import { DiffServiceImpl } from '../vendor/copilot/src/platform/diff/node/diffServiceImpl';
import { IEndpointProvider } from '../vendor/copilot/src/platform/endpoint/common/endpointProvider';
import { IIgnoreService } from '../vendor/copilot/src/platform/ignore/common/ignoreService';
import { IInlineEditsModelService } from '../vendor/copilot/src/platform/inlineEdits/common/inlineEditsModelService';
import { ObservableGit } from '../vendor/copilot/src/platform/inlineEdits/common/observableGit';
import { NesHistoryContextProvider } from '../vendor/copilot/src/platform/inlineEdits/common/workspaceEditTracker/nesHistoryContextProvider';
import { ILanguageContextProviderService } from '../vendor/copilot/src/platform/languageContextProvider/common/languageContextProviderService';
import { ProviderTarget } from '../vendor/copilot/src/platform/languageContextProvider/common/languageContextProviderService';
import { IRequestLogger } from '../vendor/copilot/src/platform/requestLogger/common/requestLogger';
import { ISnippyService, NullSnippyService } from '../vendor/copilot/src/platform/snippy/common/snippyService';
import { IProxyModelsService, NullProxyModelsService } from '../vendor/copilot/src/platform/proxyModels/common/proxyModelsService';
import { IExperimentationService, NullExperimentationService } from '../vendor/copilot/src/platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../vendor/copilot/src/platform/telemetry/common/telemetry';
import { NullTelemetryService } from '../vendor/copilot/src/platform/telemetry/common/nullTelemetryService';
import { ITerminalService, NullTerminalService } from '../vendor/copilot/src/platform/terminal/common/terminalService';
import { Event } from '../vendor/copilot/src/util/vs/base/common/event';
import { DisposableStore } from '../vendor/copilot/src/util/vs/base/common/lifecycle';
import { InstantiationServiceBuilder } from '../vendor/copilot/src/util/common/services';
import { InlineCompletionProviderImpl } from '../vendor/copilot/src/extension/inlineEdits/vscode-node/inlineCompletionProvider';
import { InlineEditModel } from '../vendor/copilot/src/extension/inlineEdits/vscode-node/inlineEditModel';
import { InlineEditLogger } from '../vendor/copilot/src/extension/inlineEdits/vscode-node/parts/inlineEditLogger';
import { DiagnosticsNextEditProvider } from '../vendor/copilot/src/extension/inlineEdits/vscode-node/features/diagnosticsInlineEditProvider';
import { DiagnosticsContextContribution } from '../vendor/copilot/src/extension/diagnosticsContext/vscode/diagnosticsContextProvider';
import { VSCodeWorkspace } from '../vendor/copilot/src/extension/inlineEdits/vscode-node/parts/vscodeWorkspace';
import { LanguageContextProviderService } from '../vendor/copilot/src/extension/languageContextProvider/vscode-node/languageContextProviderService';
import { ISimilarFilesContextService } from '../vendor/copilot/src/extension/xtab/common/similarFilesContextService';
import { SimilarFilesContextService } from '../vendor/copilot/src/extension/inlineEdits/vscode-node/similarFilesContext';
import { ICopilotInlineCompletionItemProviderService } from '../vendor/copilot/src/extension/completions/common/copilotInlineCompletionItemProviderService';
import { CopilotInlineCompletionItemProviderService } from '../vendor/copilot/src/extension/completions/vscode-node/copilotInlineCompletionItemProviderService';
import { registerDocumentTracker } from '../vendor/copilot/src/extension/completions-core/vscode-node/lib/src/documentTracker';
import { SyncDescriptor } from '../vendor/copilot/src/util/vs/platform/instantiation/common/descriptors';
import { registerServices as registerCommonServices } from '../vendor/copilot/src/extension/extension/vscode/services';
import { localToken } from './localGhostServices';
import { LocalIgnoreService } from './localIgnoreService';
import { LocalNesModelService } from './localNesModelService';
import { configureLocalNesSettings, localNesDiagnosticFixesEnabled } from './localNesSettings';
import { registerLocalLanguageContext } from './localLanguageContext';
import { registerOriginalTypeScriptContext } from './originalTypeScriptContext';
import { reportLocalRequestStatus } from './localRequestStatus';

/** Constructs the original NES model and inline provider without its chat/Agent contribution list. */
export function createLocalNesProvider(
    context: ExtensionContext,
    readNextCursorEnabled?: () => boolean,
): {
    provider: InlineCompletionItemProvider;
    ready: Promise<void>;
    whenReady(): Promise<void>;
    handlesCompletions(): boolean;
    getLastRequestLog(): unknown;
    getContextProviders(): ReturnType<LanguageContextProviderService['getAllProviders']>;
    dispose(): void;
} {
    const resetSettings = configureLocalNesSettings(readNextCursorEnabled);
    const builder = new InstantiationServiceBuilder();
    let lastRequest: { markdownContent?: () => unknown } | undefined;
    const ignoreService = new LocalIgnoreService();
    registerCommonServices(builder, context);
    builder.define(IExperimentationService, new NullExperimentationService());
    builder.define(ITelemetryService, new NullTelemetryService());
    builder.define(IAuthenticationService, {
        _serviceBrand: undefined,
        isMinimalMode: true,
        hasCopilotTokenSource: true,
        copilotToken: localToken,
        onDidAuthenticationChange: Event.None,
        onDidCopilotTokenChange: Event.None,
        onDidAccessTokenChange: Event.None,
        onDidAdoAuthenticationChange: Event.None,
        getCopilotToken: async () => localToken,
        resetCopilotToken: () => undefined,
    } as never);
    builder.define(IRequestLogger, {
        _serviceBrand: undefined,
        addEntry: (entry: { markdownContent?: () => unknown }) => { lastRequest = entry; },
        captureInvocation: (_token: unknown, callback: () => unknown) => callback(),
    } as never);
    builder.define(IIgnoreService, ignoreService);
    builder.define(IDiffService, new DiffServiceImpl());
    const modelService = new LocalNesModelService();
    builder.define(IInlineEditsModelService, modelService);
    builder.define(IProxyModelsService, new NullProxyModelsService());
    builder.define(IEndpointProvider, {
        _serviceBrand: undefined,
        onDidModelsRefresh: Event.None,
        getAllCompletionModels: async () => [],
        getAllChatEndpoints: async () => [],
        getChatEndpoint: async () => { throw new Error('Local NES endpoint is not yet configured'); },
        getEmbeddingsEndpoint: async () => { throw new Error('Local NES does not use embeddings'); },
    } as never);
    const languageContextService = new LanguageContextProviderService();
    builder.define(ILanguageContextProviderService, languageContextService);
    builder.define(ICopilotInlineCompletionItemProviderService, new SyncDescriptor(CopilotInlineCompletionItemProviderService));
    builder.define(ISimilarFilesContextService, new SyncDescriptor(SimilarFilesContextService));
    builder.define(ITerminalService, NullTerminalService.Instance);
    builder.define(ISnippyService, new NullSnippyService());

    const root = builder.seal();
    const store = new DisposableStore();
    try {
        store.add(ignoreService);
        const ready = ignoreService.init();
        store.add(languageContextService);
        store.add(registerLocalLanguageContext(languageContextService, ProviderTarget.NES, ignoreService));
        store.add(registerOriginalTypeScriptContext(root, languageContextService, ProviderTarget.NES));
        // Standalone NES uses this embedded completions service for similar
        // files. The original contribution that normally calls setup() is not
        // registered here, including when NES handles unified completions.
        const completions = root.invokeFunction(accessor =>
            accessor.get(ICopilotInlineCompletionItemProviderService).getOrCreateInstantiationService());
        store.add(completions.invokeFunction(registerDocumentTracker));
        store.add(root.createInstance(DiagnosticsContextContribution));
        const workspace = store.add(root.createInstance(VSCodeWorkspace));
        const git = store.add(root.createInstance(ObservableGit));
        const history = store.add(new NesHistoryContextProvider(workspace, git));
        const diagnostics = localNesDiagnosticFixesEnabled()
            ? store.add(root.createInstance(DiagnosticsNextEditProvider, workspace, git)) : undefined;
        const model = store.add(root.createInstance(InlineEditModel, undefined, workspace, history, diagnostics));
        const logger = store.add(root.createInstance(InlineEditLogger));
        const telemetry = {
            scheduleSendingEnhancedTelemetry: () => undefined,
            sendTelemetryForBuilder: () => undefined,
            sendTelemetry: () => undefined,
        } as never;
        const expectedCapture = {
            isCaptureActive: false,
            isEnabled: false,
            captureOnReject: false,
        } as never;
        const provider = store.add(root.createInstance(
            InlineCompletionProviderImpl, model, logger, undefined, undefined, telemetry, expectedCapture,
        ));
        return {
            provider,
            ready,
            whenReady: () => ignoreService.whenReady(),
            handlesCompletions: () => modelService.supportsUnifiedCompletions.get() === true,
            getLastRequestLog: () => lastRequest?.markdownContent?.(),
            getContextProviders: () => languageContextService.getAllProviders([ProviderTarget.NES]),
            dispose: () => { store.dispose(); root.dispose(); resetSettings(); reportLocalRequestStatus('nes'); },
        };
    } catch (error) {
        store.dispose();
        root.dispose();
        resetSettings();
        throw error;
    }
}
