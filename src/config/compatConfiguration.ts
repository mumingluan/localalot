import * as vscode from 'vscode';

const legacySectionPrefix = 'cc-completion';
const localSectionPrefix = 'localalot';

/**
 * Reads Localalot settings and falls back to the former cc-completion section.
 * A value explicitly set under localalot always wins, including false and 0.
 * Writes intentionally target localalot so the extension gradually moves users
 * to the current namespace without changing their existing settings in place.
 */
export function getLocalConfiguration(
    section?: string,
    scope?: vscode.ConfigurationScope,
): vscode.WorkspaceConfiguration {
    const local = vscode.workspace.getConfiguration(section, scope);
    const legacySection = section === undefined
        ? undefined
        : section === localSectionPrefix
            ? legacySectionPrefix
            : section.startsWith(`${localSectionPrefix}.`)
                ? `${legacySectionPrefix}${section.slice(localSectionPrefix.length)}`
                : undefined;
    if (!legacySection) return local;

    const legacy = vscode.workspace.getConfiguration(legacySection, scope);
    const hasUserValue = (configuration: vscode.WorkspaceConfiguration, key: string): boolean => {
        const inspected = configuration.inspect<unknown>(key);
        if (!inspected) return false;
        return inspected.workspaceFolderLanguageValue !== undefined
            || inspected.workspaceLanguageValue !== undefined
            || inspected.globalLanguageValue !== undefined
            || inspected.workspaceFolderValue !== undefined
            || inspected.workspaceValue !== undefined
            || inspected.globalValue !== undefined;
    };

    return new Proxy(local, {
        get(target, property, receiver) {
            if (property === 'get') {
                return <T>(key: string, defaultValue?: T): T => {
                    if (hasUserValue(target, key)) return target.get<T>(key, defaultValue as T);
                    if (hasUserValue(legacy, key)) return legacy.get<T>(key, defaultValue as T);
                    return target.get<T>(key, defaultValue as T);
                };
            }
            if (property === 'has') {
                return (key: string): boolean => target.has(key) || legacy.has(key);
            }
            if (property === 'inspect') {
                return <T>(key: string) => {
                    if (hasUserValue(target, key)) return target.inspect<T>(key);
                    if (hasUserValue(legacy, key)) return legacy.inspect<T>(key);
                    return target.inspect<T>(key);
                };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

/** Reads a fully-qualified Localalot key with cc-completion fallback. */
export function getLocalSetting<T>(key: string, defaultValue: T, scope?: vscode.ConfigurationScope): T {
    const separator = key.lastIndexOf('.');
    if (separator <= 0) return vscode.workspace.getConfiguration().get<T>(key, defaultValue);
    return getLocalConfiguration(key.slice(0, separator), scope).get<T>(key.slice(separator + 1), defaultValue);
}
