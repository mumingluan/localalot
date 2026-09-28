import * as assert from 'assert';
import * as vscode from 'vscode';
import { VSCodeNesConfigProvider } from '../../config/nesConfig';

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

suite('VSCodeNesConfigProvider', () => {

    test('reads the configured model', () => {
        const provider = new VSCodeNesConfigProvider(mockContext());
        assert.strictEqual(provider.model, vscode.workspace.getConfiguration('localalot.nes').get<string>('model', 'gpt-4o'));
    });

    test('returns updated value after config change invalidates cache', async () => {
        const provider = new VSCodeNesConfigProvider(mockContext());
        const config = vscode.workspace.getConfiguration('localalot.nes');
        const previousModel = config.inspect<string>('model')?.globalValue;

        // Prime the cache
        assert.strictEqual(provider.model, config.get<string>('model', 'gpt-4o'));
        const revision = provider.revision;

        // Change config — VS Code fires onDidChangeConfiguration internally,
        // which clears the cache
        await config.update('model', 'claude-4', vscode.ConfigurationTarget.Global);

        // Cache was cleared, next read gets new value
        assert.strictEqual(provider.model, 'claude-4');
        assert.ok(provider.revision > revision);

        // Cleanup
        await config.update('model', previousModel, vscode.ConfigurationTarget.Global);
    });

    test('enabled is independent of settings.json cache', () => {
        const provider = new VSCodeNesConfigProvider(mockContext());

        const initialEnabled = provider.enabled;
        provider.enabled = false;
        assert.strictEqual(provider.enabled, false);
        const disabledRevision = provider.revision;
        provider.enabled = false;
        assert.strictEqual(provider.revision, disabledRevision);

        // model still works (separate storage)
        assert.strictEqual(provider.model, vscode.workspace.getConfiguration('localalot.nes').get<string>('model', 'gpt-4o'));

        provider.enabled = initialEnabled;
    });

    test('nextCursorPredictionEnabled uses workspaceState', () => {
        const provider = new VSCodeNesConfigProvider(mockContext());

        assert.strictEqual(provider.nextCursorPredictionEnabled, true);
        const revision = provider.revision;
        provider.nextCursorPredictionEnabled = false;
        assert.strictEqual(provider.nextCursorPredictionEnabled, false);
        assert.ok(provider.revision > revision);
        const disabledRevision = provider.revision;
        provider.nextCursorPredictionEnabled = false;
        assert.strictEqual(provider.revision, disabledRevision);
    });

    test('standalone cursor jumps are an opt-in editor setting', async () => {
        const provider = new VSCodeNesConfigProvider(mockContext());
        const config = vscode.workspace.getConfiguration('localalot.nes');
        const previous = config.inspect<boolean>('nextCursorPrediction.jumpWithoutEdit')?.globalValue;
        try {
            assert.strictEqual(provider.nextCursorJumpWithoutEdit, false);
            await config.update('nextCursorPrediction.jumpWithoutEdit', true, vscode.ConfigurationTarget.Global);
            assert.strictEqual(provider.nextCursorJumpWithoutEdit, true);
        } finally {
            await config.update('nextCursorPrediction.jumpWithoutEdit', previous, vscode.ConfigurationTarget.Global);
        }
    });

    test('restores the cursor prediction preference after NES is re-enabled', () => {
        const provider = new VSCodeNesConfigProvider(mockContext());
        provider.nextCursorPredictionEnabled = false;
        provider.enabled = false;
        assert.strictEqual(provider.nextCursorPredictionEnabled, false);
        provider.enabled = true;
        assert.strictEqual(provider.nextCursorPredictionEnabled, false);
    });

    test('publishes NES and cursor toggles before workspace state finishes writing', async () => {
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
        const provider = new VSCodeNesConfigProvider(context);
        const observed: Array<[boolean, boolean]> = [];
        const listener = provider.onDidChangeEnabled(() => observed.push([
            provider.enabled, provider.nextCursorPredictionEnabled,
        ]));
        try {
            provider.enabled = false;
            provider.nextCursorPredictionEnabled = false;
            assert.deepStrictEqual(observed, [[false, true], [false, false]]);
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.strictEqual(writes.length, 2);
            writes.forEach(write => write());
            await Promise.resolve();
            assert.strictEqual(provider.enabled, false);
            assert.strictEqual(provider.nextCursorPredictionEnabled, false);
        } finally {
            listener.dispose();
        }
    });

    test('family defaults to standard', () => {
        const provider = new VSCodeNesConfigProvider(mockContext());
        assert.strictEqual(provider.family, 'standard');
    });

    test('uses neutral sampling penalties by default', () => {
        const provider = new VSCodeNesConfigProvider(mockContext());
        assert.strictEqual(provider.presencePenalty, 0);
        assert.strictEqual(provider.frequencyPenalty, 0);
    });

    test('supportedEndpoint defaults to chat/completions', () => {
        const provider = new VSCodeNesConfigProvider(mockContext());
        assert.strictEqual(provider.endpoint, 'chat/completions');
    });

    test('promptTemplate has expected default', () => {
        const provider = new VSCodeNesConfigProvider(mockContext());
        const tmpl = provider.promptTemplate;
        assert.ok(tmpl.includes('{system}'));
        assert.ok(tmpl.includes('{user}'));
        assert.ok(tmpl.includes('<|im_start|>'));
        assert.ok(tmpl.includes('<|im_end|>'));
        assert.ok(tmpl.endsWith('\n\n'));
    });
});
