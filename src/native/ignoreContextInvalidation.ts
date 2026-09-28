import * as vscode from 'vscode';

/** Recreate upstream prompt state after ignore files or workspace roots change. */
export function registerIgnoreContextInvalidation(invalidate: () => void): vscode.Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher('**/.copilotignore');
    let pending: NodeJS.Timeout | undefined;
    const schedule = (): void => {
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
            pending = undefined;
            invalidate();
        }, 100);
    };
    const subscriptions = vscode.Disposable.from(
        watcher,
        watcher.onDidCreate(schedule),
        watcher.onDidChange(schedule),
        watcher.onDidDelete(schedule),
        vscode.workspace.onDidChangeWorkspaceFolders(schedule),
    );
    return new vscode.Disposable(() => {
        if (pending) clearTimeout(pending);
        subscriptions.dispose();
    });
}
