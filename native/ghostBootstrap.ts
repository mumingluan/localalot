import type { ExtensionContext, InlineCompletionItemProvider } from 'vscode';
import { IAuthenticationService } from '../vendor/copilot/src/platform/authentication/common/authentication';
import { IConfigurationService } from '../vendor/copilot/src/platform/configuration/common/configurationService';
import { IRequestLogger } from '../vendor/copilot/src/platform/requestLogger/common/requestLogger';
import { ILanguageContextProviderService, ProviderTarget } from '../vendor/copilot/src/platform/languageContextProvider/common/languageContextProviderService';
import { IIgnoreService } from '../vendor/copilot/src/platform/ignore/common/ignoreService';
import { IExperimentationService, NullExperimentationService } from '../vendor/copilot/src/platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../vendor/copilot/src/platform/telemetry/common/telemetry';
import { NullTelemetryService } from '../vendor/copilot/src/platform/telemetry/common/nullTelemetryService';
import { IGitService } from '../vendor/copilot/src/platform/git/common/gitService';
import { IGitDiffService } from '../vendor/copilot/src/platform/git/common/gitDiffService';
import { GitServiceImpl } from '../vendor/copilot/src/platform/git/vscode-node/gitServiceImpl';
import { InstantiationServiceBuilder } from '../vendor/copilot/src/util/common/services';
import { SyncDescriptor } from '../vendor/copilot/src/util/vs/platform/instantiation/common/descriptors';
import { Event } from '../vendor/copilot/src/util/vs/base/common/event';
import { DisposableStore } from '../vendor/copilot/src/util/vs/base/common/lifecycle';
import { createContext, setup } from '../vendor/copilot/src/extension/completions-core/vscode-node/completionsServiceBridges';
import { ICompletionsDefaultContextProviders } from '../vendor/copilot/src/extension/completions-core/vscode-node/lib/src/prompt/contextProviderRegistry';
import { CopilotInlineCompletionItemProvider } from '../vendor/copilot/src/extension/completions-core/vscode-node/extension/src/vscodeInlineCompletionItemProvider';
import { registerServices as registerCommonServices } from '../vendor/copilot/src/extension/extension/vscode/services';
import { LanguageContextProviderService } from '../vendor/copilot/src/extension/languageContextProvider/vscode-node/languageContextProviderService';
import { GitDiffService } from '../vendor/copilot/src/extension/prompt/vscode-node/gitDiffService';
import { ScmContextProviderContribution } from '../vendor/copilot/src/extension/git/vscode/scmContextprovider';
import { LocalGhostTransportOptions } from './localGhostTransport';
import { localToken } from './localGhostServices';
import { LocalIgnoreService } from './localIgnoreService';
import { registerLocalLanguageContext } from './localLanguageContext';
import { registerOriginalTypeScriptContext } from './originalTypeScriptContext';
import { reportLocalRequestStatus } from './localRequestStatus';
import { LocalConfigurationService } from './localConfigurationService';
import { LocalCompletionsConfigProvider } from './localCompletionsConfig';

/** Only provides the interfaces needed by the original completion pipeline. */
export function createLocalGhostProvider(
    context: ExtensionContext,
    readOptions?: () => LocalGhostTransportOptions,
): {
    provider: InlineCompletionItemProvider;
    ready: Promise<void>;
    whenReady(): Promise<void>;
    getLastRequestLog(): unknown;
    getContextProviders(): ReturnType<LanguageContextProviderService['getAllProviders']>;
    dispose(): void;
} {
    const builder = new InstantiationServiceBuilder();
    let lastRequest: { markdownContent?: () => unknown } | undefined;
    registerCommonServices(builder, context);
    // The upstream provider must use Localalot enablement even when the
    // GitHub Copilot extension or its settings are disabled.
    builder.define(IConfigurationService, new SyncDescriptor(LocalConfigurationService));
    const languageContextService = new LanguageContextProviderService();
    const ignoreService = new LocalIgnoreService();
    builder.define(ILanguageContextProviderService, languageContextService);
    builder.define(IIgnoreService, ignoreService);
    builder.define(IGitService, new SyncDescriptor(GitServiceImpl));
    builder.define(IGitDiffService, new SyncDescriptor(GitDiffService));
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

    const root = builder.seal();
    const store = new DisposableStore();
    try {
        store.add(ignoreService);
        const ready = ignoreService.init();
        store.add(languageContextService);
        store.add(registerLocalLanguageContext(languageContextService, ProviderTarget.Completions, ignoreService));
        store.add(registerOriginalTypeScriptContext(root, languageContextService, ProviderTarget.Completions));
        store.add(root.createInstance(ScmContextProviderContribution));
        const completionsConfig = store.add(new LocalCompletionsConfigProvider());
        const completions = root.invokeFunction(createContext, store, completionsConfig, readOptions);
        completions.invokeFunction(setup, store);
        completions.invokeFunction(accessor => {
            accessor.get(ICompletionsDefaultContextProviders).add('localalot.semantic-context-provider');
        });
        const provider = store.add(completions.createInstance(CopilotInlineCompletionItemProvider));
        return {
            provider,
            ready,
            whenReady: () => ignoreService.whenReady(),
            getLastRequestLog: () => lastRequest?.markdownContent?.(),
            getContextProviders: () => languageContextService.getAllProviders([ProviderTarget.Completions]),
            dispose: () => { store.dispose(); root.dispose(); reportLocalRequestStatus('ghost'); },
        };
    } catch (error) {
        store.dispose();
        root.dispose();
        throw error;
    }
}
