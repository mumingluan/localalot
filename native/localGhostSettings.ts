import * as vscode from 'vscode';

/** Keep Copilot's dynamic IntelliSense default when Localalot has no explicit override. */
export function localRespectSelectedCompletionInfo(defaultValue: boolean): boolean {
    const config = vscode.workspace.getConfiguration('localalot');
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
