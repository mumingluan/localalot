import * as vscode from 'vscode';

/** Keep a cancelled editor request from waiting for a workspace rule scan. */
export async function waitForIgnoreRules(
    ready: Promise<void>, token: vscode.CancellationToken,
): Promise<boolean> {
    if (token.isCancellationRequested) return false;
    let cancellation: vscode.Disposable | undefined;
    try {
        return await Promise.race([
            ready.then(() => true),
            new Promise<boolean>(resolve => {
                cancellation = token.onCancellationRequested(() => resolve(false));
                if (token.isCancellationRequested) resolve(false);
            }),
        ]);
    } finally {
        cancellation?.dispose();
    }
}
