import * as assert from 'assert';
import * as vscode from 'vscode';
import { waitForIgnoreRules } from '../../native/ignoreReadiness';

suite('Ignore rule readiness', () => {
    test('releases a cancelled request while the rule scan is still pending', async () => {
        let finishScan!: () => void;
        const scan = new Promise<void>(resolve => { finishScan = resolve; });
        const token = new vscode.CancellationTokenSource();
        try {
            const waiting = waitForIgnoreRules(scan, token.token);
            token.cancel();
            assert.strictEqual(await waiting, false);
            finishScan();
        } finally {
            finishScan();
            token.dispose();
        }
    });

    test('continues after the rule scan completes', async () => {
        const token = new vscode.CancellationTokenSource();
        try {
            assert.strictEqual(await waitForIgnoreRules(Promise.resolve(), token.token), true);
        } finally {
            token.dispose();
        }
    });
});
