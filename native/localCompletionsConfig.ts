import { ConfigKey } from '../vendor/copilot/src/extension/completions-core/vscode-node/lib/src/config';
import { ICompletionsConfigProvider } from '../vendor/copilot/src/extension/completions-core/vscode-node/lib/src/config';
import { VSCodeConfigProvider } from '../vendor/copilot/src/extension/completions-core/vscode-node/extension/src/config';
import { getLocalSetting } from '../src/config/compatConfiguration';

/** Copilot completion-core settings that must be owned by Localalot. */
export class LocalCompletionsConfigProvider extends VSCodeConfigProvider implements ICompletionsConfigProvider {
    override getConfig<T>(key: string): T {
        const value = this.localValue<T>(key);
        return value.handled ? value.value as T : super.getConfig<T>(key);
    }

    override getOptionalConfig<T>(key: string): T | undefined {
        const value = this.localValue<T>(key);
        return value.handled ? value.value as T : super.getOptionalConfig<T>(key);
    }

    private localValue<T>(key: string): { handled: boolean; value?: T } {
        switch (key) {
            case ConfigKey.Enable:
                return { handled: true, value: getLocalSetting('localalot.enable', { '*': true }) as T };
            case ConfigKey.ContextProviderTimeBudget:
                return { handled: true, value: getLocalSetting('localalot.advanced.contextProviderTimeBudget', 750) as T };
            default:
                return { handled: false };
        }
    }
}
