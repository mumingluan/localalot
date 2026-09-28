import * as assert from 'assert';
import * as vscode from 'vscode';
import { NativeGhostRuntime } from '../../native/ghostRuntime';
import { NativeNesRuntime } from '../../native/nesRuntime';

suite('Original provider runtime status', () => {
    test('reports a reset failure and clears it when the provider is disabled', () => {
        const context = { extensionPath: 'missing-native-bundle' } as vscode.ExtensionContext;
        const log = { info() {}, error() {} } as never;
        const ghostConfig = {
            enabled: false,
            onDidChangeEnabled: () => new vscode.Disposable(() => undefined),
        };
        const nesConfig = {
            enabled: false,
            onDidChangeEnabled: () => new vscode.Disposable(() => undefined),
        };
        const ghost = new NativeGhostRuntime(context, ghostConfig as never, log);
        const nes = new NativeNesRuntime(context, nesConfig as never, log);
        const changes = { ghost: 0, nes: 0 };
        const subscriptions = vscode.Disposable.from(
            ghost.onDidChangeAvailability(() => changes.ghost++),
            nes.onDidChangeAvailability(() => changes.nes++),
        );
        try {
            ghost.register();
            nes.register();
            ghostConfig.enabled = true;
            nesConfig.enabled = true;
            ghost.invalidateCachedCompletions();
            nes.invalidateCachedEdits();
            assert.ok(ghost.startupError);
            assert.ok(nes.startupError);
            assert.strictEqual(changes.ghost, 1);
            assert.strictEqual(changes.nes, 1);
            ghostConfig.enabled = false;
            nesConfig.enabled = false;
            ghost.invalidateCachedCompletions();
            nes.invalidateCachedEdits();
            assert.strictEqual(ghost.startupError, undefined);
            assert.strictEqual(nes.startupError, undefined);
            assert.strictEqual(changes.ghost, 2);
            assert.strictEqual(changes.nes, 2);
        } finally {
            subscriptions.dispose();
            ghost.dispose();
            nes.dispose();
        }
    });
});
