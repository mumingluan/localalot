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

    // WorkspaceConfiguration is a host object whose methods can be
    // non-configurable. A Proxy cannot safely replace those methods on newer
    // VS Code versions, so use a facade with the native configuration as its
    // prototype and shadow only the compatibility methods.
    const compatibility = Object.create(local) as vscode.WorkspaceConfiguration;
    Object.defineProperties(compatibility, {
        get: {
            enumerable: true,
            value: <T>(key: string, defaultValue?: T): T => {
                if (hasUserValue(local, key)) return local.get<T>(key, defaultValue as T);
                if (hasUserValue(legacy, key)) return legacy.get<T>(key, defaultValue as T);
                return local.get<T>(key, defaultValue as T);
            },
        },
        has: {
            enumerable: true,
            value: (key: string): boolean => local.has(key) || legacy.has(key),
        },
        inspect: {
            enumerable: true,
            value: <T>(key: string) => {
                if (hasUserValue(local, key)) return local.inspect<T>(key);
                if (hasUserValue(legacy, key)) return legacy.inspect<T>(key);
                return local.inspect<T>(key);
            },
        },
        update: {
            enumerable: true,
            value: local.update.bind(local),
        },
    });
    return compatibility;
}

/** Reads a fully-qualified Localalot key with cc-completion fallback. */
export function getLocalSetting<T>(key: string, defaultValue: T, scope?: vscode.ConfigurationScope): T {
    const separator = key.lastIndexOf('.');
    if (separator <= 0) return vscode.workspace.getConfiguration().get<T>(key, defaultValue);
    return getLocalConfiguration(key.slice(0, separator), scope).get<T>(key.slice(separator + 1), defaultValue);
}

/** Resolve the Ghost IntelliSense preview setting with its dynamic default. */
export function getLocalRespectSelectedCompletionInfo(
    scope: vscode.ConfigurationScope | undefined,
    defaultValue: boolean,
): boolean {
    const config = getLocalConfiguration('localalot', scope);
    const inspected = config.inspect<boolean>('respectSelectedCompletionInfo');
    const configured = inspected && [
        inspected.defaultLanguageValue,
        inspected.globalValue,
        inspected.workspaceValue,
        inspected.workspaceFolderValue,
        inspected.globalLanguageValue,
        inspected.workspaceLanguageValue,
        inspected.workspaceFolderLanguageValue,
    ].some(value => value !== undefined);
    return configured ? config.get('respectSelectedCompletionInfo', defaultValue) : defaultValue;
}
