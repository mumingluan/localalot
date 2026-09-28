import * as vscode from 'vscode';

/** Model settings have VS Code's default window scope: user or workspace. */
export function modelSettingScope(
    inspected: { workspaceValue?: string; globalValue?: string } | undefined,
): vscode.ConfigurationTarget {
    return inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
}
