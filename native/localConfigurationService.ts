import type { ConfigurationScope } from 'vscode';
import { ICopilotTokenStore } from '../vendor/copilot/src/platform/authentication/common/copilotTokenStore';
import {
    Config,
    ConfigKey,
    ExperimentBasedConfig,
    ExperimentBasedConfigType,
    IConfigurationService,
} from '../vendor/copilot/src/platform/configuration/common/configurationService';
import { ConfigurationServiceImpl } from '../vendor/copilot/src/platform/configuration/vscode/configurationServiceImpl';
import { IObservable, constObservable } from '../vendor/copilot/src/util/vs/base/common/observable';
import { getLocalConfiguration } from '../src/config/compatConfiguration';

type LocalOverride = { handled: true; value: unknown } | { handled: false };

/**
 * Keeps the upstream providers intact while replacing only their Copilot
 * enablement gates with Localalot settings. This is what makes NES continue
 * working when github.copilot.enable or Copilot Chat is disabled.
 */
export class LocalConfigurationService extends ConfigurationServiceImpl implements IConfigurationService {
    constructor(@ICopilotTokenStore tokenStore: ICopilotTokenStore) {
        super(tokenStore);
    }

    override getConfig<T>(key: Config<T>, scope?: ConfigurationScope): T {
        const override = this.localOverride(key.id, scope);
        return (override.handled ? override.value : super.getConfig(key, scope)) as T;
    }

    override getExperimentBasedConfig<T extends ExperimentBasedConfigType>(
        key: ExperimentBasedConfig<T>,
        experimentationService: import('../vendor/copilot/src/platform/telemetry/common/nullExperimentationService').IExperimentationService,
        scope?: ConfigurationScope,
    ): T {
        const override = this.localOverride(key.id, scope);
        return (override.handled ? override.value : super.getExperimentBasedConfig(key, experimentationService, scope)) as T;
    }

    override getConfigObservable<T>(key: Config<T>): IObservable<T> {
        const override = this.localOverride(key.id);
        return override.handled ? constObservable(override.value as T) : super.getConfigObservable(key);
    }

    override getExperimentBasedConfigObservable<T extends ExperimentBasedConfigType>(
        key: ExperimentBasedConfig<T>,
        experimentationService: import('../vendor/copilot/src/platform/telemetry/common/nullExperimentationService').IExperimentationService,
    ): IObservable<T> {
        const override = this.localOverride(key.id);
        return override.handled
            ? constObservable(override.value as T)
            : super.getExperimentBasedConfigObservable(key, experimentationService);
    }

    private localOverride(key: string, scope?: ConfigurationScope): LocalOverride {
        switch (key) {
            case ConfigKey.Enable:
                return { handled: true, value: getLocalConfiguration('localalot', scope).get('enable', { '*': true }) };
            case ConfigKey.ContextProviderTimeBudget:
                return { handled: true, value: getLocalConfiguration('localalot.advanced', scope).get('contextProviderTimeBudget', 750) };
            case ConfigKey.InlineEditsEnabled:
                return { handled: true, value: getLocalConfiguration('localalot.nextEditSuggestions', scope).get('enabled', true) };
            case ConfigKey.InlineEditsNextCursorPredictionEnabled:
                return { handled: true, value: getLocalConfiguration('localalot.nextEditSuggestions', scope).get('extendedRange', true) };
            case ConfigKey.InlineEditsEnableDiagnosticsProvider:
                return { handled: true, value: getLocalConfiguration('localalot.nes', scope).get('diagnosticFixesEnabled', true) };
            case ConfigKey.InlineEditsAllowWhitespaceOnlyChanges:
                return { handled: true, value: getLocalConfiguration('localalot.nes', scope).get('allowWhitespaceOnlyChanges', true) };
            case ConfigKey.InlineEditsAggressiveness:
                return { handled: true, value: getLocalConfiguration('localalot.nextEditSuggestions', scope).get('eagerness', 'auto') };
            case ConfigKey.Advanced.InlineEditsTriggerOnEditorChangeAfterSeconds: {
                const value = getLocalConfiguration('localalot.nextEditSuggestions', scope)
                    .get<number | null>('triggerOnEditorChangeAfterSeconds', 10);
                return { handled: true, value: value === null ? undefined : value };
            }
            case ConfigKey.Advanced.InlineEditsNextCursorPredictionCurrentFileMaxTokens:
                return {
                    handled: true,
                    value: getLocalConfiguration('localalot.nes.nextCursorPrediction').get('currentFileMaxTokens', 3000),
                };
            case ConfigKey.TeamInternal.InlineEditsIgnoreCompletionsDisablement:
                return { handled: true, value: false };
            case ConfigKey.TeamInternal.InlineEditsInlineCompletionsEnabled:
                return { handled: true, value: true };
            case ConfigKey.TeamInternal.InlineEditsIgnoreWhenSuggestVisible:
                return { handled: true, value: getLocalConfiguration('localalot', scope).get('ignoreWhenSuggestVisible', false) };
            case ConfigKey.TeamInternal.InlineEditsNesMimicGhostTextBehavior:
                return { handled: true, value: getLocalConfiguration('localalot.nes', scope).get('mimicGhostTextBehavior', false) };
            case ConfigKey.InlineEditsRenameSymbolSuggestions:
                return { handled: true, value: getLocalConfiguration('localalot.nes').get('renameSymbolSuggestions', true) };
            case ConfigKey.DiagnosticsContextProvider:
                return { handled: true, value: getLocalConfiguration('localalot.nes', scope).get('diagnosticContextEnabled', true) };
            default:
                return { handled: false };
        }
    }
}
