import * as assert from 'assert';
import * as vscode from 'vscode';
import { VSCodeGhostConfigProvider } from '../../config/ghostConfig';

function mockContext(): vscode.ExtensionContext {
    const state = new Map<string, unknown>();
    return {
        workspaceState: {
            get: <T>(key: string, defaultValue: T) => (state.has(key) ? state.get(key) : defaultValue) as T,
            update: (key: string, value: unknown) => { state.set(key, value); return Promise.resolve(); },
        },
        subscriptions: [] as vscode.Disposable[],
    } as unknown as vscode.ExtensionContext;
}

suite('VSCodeGhostConfigProvider', () => {

    test('returns default model when no config set', () => {
        const provider = new VSCodeGhostConfigProvider(mockContext());
        assert.strictEqual(provider.model, 'gpt-4o');
    });

    test('returns updated value after config change invalidates cache', async () => {
        const provider = new VSCodeGhostConfigProvider(mockContext());
        const config = vscode.workspace.getConfiguration('localalot.ghost');

        assert.strictEqual(provider.model, 'gpt-4o');

        await config.update('model', 'gpt-4.1', vscode.ConfigurationTarget.Global);
        assert.strictEqual(provider.model, 'gpt-4.1');

        await config.update('model', undefined, vscode.ConfigurationTarget.Global);
    });

    test('returns default promptTemplate when no config set', () => {
        const provider = new VSCodeGhostConfigProvider(mockContext());
        assert.strictEqual(
            provider.promptTemplate,
            '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
        );
    });

    test('returns default endpoint when no config set', () => {
        const provider = new VSCodeGhostConfigProvider(mockContext());
        assert.strictEqual(provider.endpoint, 'completions');
        assert.strictEqual(provider.maxOutputTokens, 500);
        assert.strictEqual(provider.delay, 0);
    });

    test('uses neutral sampling penalties by default', () => {
        const provider = new VSCodeGhostConfigProvider(mockContext());
        assert.strictEqual(provider.presencePenalty, 0);
        assert.strictEqual(provider.frequencyPenalty, 0);
    });

    test('returns updated endpoint after config change invalidates cache', async () => {
        const provider = new VSCodeGhostConfigProvider(mockContext());
        const config = vscode.workspace.getConfiguration('localalot.ghost');

        assert.strictEqual(provider.endpoint, 'completions');

        await config.update('endpoint', 'fim/completions', vscode.ConfigurationTarget.Global);
        assert.strictEqual(provider.endpoint, 'fim/completions');

        await config.update('endpoint', undefined, vscode.ConfigurationTarget.Global);
    });

    test('updates context placement after a settings change', async () => {
        const provider = new VSCodeGhostConfigProvider(mockContext());
        const config = vscode.workspace.getConfiguration('localalot.ghost');

        assert.strictEqual(provider.contextPlacement, 'prefix');
        const initialRevision = provider.revision;
        try {
            await config.update('contextPlacement', 'extra', vscode.ConfigurationTarget.Global);
            assert.strictEqual(provider.contextPlacement, 'extra');
            assert.ok(provider.revision > initialRevision);
        } finally {
            await config.update('contextPlacement', undefined, vscode.ConfigurationTarget.Global);
        }
        assert.strictEqual(provider.contextPlacement, 'prefix');
    });

    test('enabled is independent of settings.json cache', () => {
        const provider = new VSCodeGhostConfigProvider(mockContext());

        const initialEnabled = provider.enabled;
        const initialRevision = provider.revision;
        provider.enabled = false;
        assert.strictEqual(provider.enabled, false);
        assert.ok(provider.revision > initialRevision);

        // model still works (separate storage)
        assert.strictEqual(provider.model, 'gpt-4o');

        const disabledRevision = provider.revision;
        provider.enabled = false;
        assert.strictEqual(provider.revision, disabledRevision);
        provider.enabled = initialEnabled;
        assert.ok(provider.revision > disabledRevision);
    });

    test('publishes an enabled toggle before workspace state finishes writing', async () => {
        const state = new Map<string, unknown>();
        let finishWrite!: () => void;
        const context = {
            workspaceState: {
                get: <T>(key: string, fallback: T) => (state.has(key) ? state.get(key) : fallback) as T,
                update: (key: string, value: unknown) => new Promise<void>(resolve => {
                    finishWrite = () => { state.set(key, value); resolve(); };
                }),
            },
            subscriptions: [] as vscode.Disposable[],
        } as unknown as vscode.ExtensionContext;
        const provider = new VSCodeGhostConfigProvider(context);
        const observed: boolean[] = [];
        const listener = provider.onDidChangeEnabled(() => observed.push(provider.enabled));
        try {
            provider.enabled = false;
            assert.deepStrictEqual(observed, [false]);
            assert.strictEqual(provider.enabled, false);
            await new Promise<void>(resolve => setImmediate(resolve));
            finishWrite();
            await Promise.resolve();
            assert.strictEqual(provider.enabled, false);
        } finally {
            listener.dispose();
        }
    });

    test('persists rapid enabled toggles in the order selected', async () => {
        const state = new Map<string, unknown>();
        const writes: Array<() => void> = [];
        const context = {
            workspaceState: {
                get: <T>(key: string, fallback: T) => (state.has(key) ? state.get(key) : fallback) as T,
                update: (key: string, value: unknown) => new Promise<void>(resolve => {
                    writes.push(() => { state.set(key, value); resolve(); });
                }),
            },
            subscriptions: [] as vscode.Disposable[],
        } as unknown as vscode.ExtensionContext;
        const provider = new VSCodeGhostConfigProvider(context);
        provider.enabled = false;
        provider.enabled = true;
        assert.strictEqual(provider.enabled, true);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(writes.length, 1);
        writes.shift()!();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(writes.length, 1);
        writes.shift()!();
        await Promise.resolve();
        assert.strictEqual(state.get('ghost.enabled'), true);
    });
});
