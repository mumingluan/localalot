import * as assert from 'assert';
import * as vscode from 'vscode';
import { NextEditProvider } from '../../../completions/nes/nextEditProvider';
import { Result } from '../../../common/result';
import { NextEditCache } from '../../../completions/nes/nextEditCache';
import { DocumentId } from '../../../completions/nes/stubs/types';

suite('NES provider toggle', () => {
    test('drops a cursor prediction when an open context document changes', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = calculateTax();\nother();',
        });
        const neighbor = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'export function calculateTax() { return 1; }',
        });
        const cache = new NextEditCache();
        let workflowCalls = 0;
        let completedPredictions = 0;
        let releasePrediction!: () => void;
        const predictionGate = new Promise<void>(resolve => { releasePrediction = resolve; });
        let notifyPredictionStarted!: () => void;
        const predictionStarted = new Promise<void>(resolve => { notifyPredictionStarted = resolve; });
        const workflow = {
            execute: async () => {
                workflowCalls++;
                return {
                    editResult: undefined,
                    promptPieces: { editWindowLinesRange: { contains: () => false } },
                };
            },
            getContextStamp: () => cache.getContextStamp(DocumentId.create(document.uri.toString())),
            completeNoEditPrediction: () => { completedPredictions++; },
            setAggressiveness() {},
        };
        const predictor = {
            isEnabled: () => true,
            predict: async () => {
                notifyPredictionStarted();
                await predictionGate;
                return Result.ok({ kind: 'sameFile', lineNumber: 1 });
            },
        };
        const provider = new NextEditProvider(
            { createInstance: (type: { name: string }) => type.name === 'NesWorkflow' ? workflow : predictor } as never,
            { enabled: true, revision: 0, eagernessSelection: 'medium' } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const cts = new vscode.CancellationTokenSource();
        try {
            const result = provider.provideInlineCompletionItems(
                document, new vscode.Position(0, 0),
                { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext,
                cts.token,
            );
            await predictionStarted;
            const edit = new vscode.WorkspaceEdit();
            edit.insert(neighbor.uri, new vscode.Position(0, neighbor.lineAt(0).text.length), ' // changed');
            assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
            releasePrediction();
            assert.strictEqual(await result, undefined);
            assert.strictEqual(workflowCalls, 1);
            assert.strictEqual(completedPredictions, 0);
        } finally {
            releasePrediction();
            cts.dispose();
        }
    });

    test('reuses a completed cursor-only jump without predicting again', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'first();\nsecond();' });
        let predictions = 0;
        const provider = new NextEditProvider(
            { createInstance: (type: { name: string }) => type.name === 'NesWorkflow'
                ? { execute: async () => ({
                    editResult: undefined,
                    cachedNoEdit: { predictionComplete: true, jump: {
                        uri: document.uri.toString(), line: 1, character: 0,
                        targetDocumentText: document.getText(),
                    } },
                }), setAggressiveness() {} }
                : { isEnabled: () => true, predict: async () => { predictions++; return Result.error('unused'); } } } as never,
            { enabled: true, revision: 0, eagernessSelection: 'medium' } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const cts = new vscode.CancellationTokenSource();
        try {
            const result = await provider.provideInlineCompletionItems(
                document, new vscode.Position(0, 0),
                { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext,
                cts.token,
            );
            assert.strictEqual(result?.items.length, 1);
            assert.deepStrictEqual((result?.items[0] as unknown as { jumpToPosition?: vscode.Position })?.jumpToPosition,
                new vscode.Position(1, 0));
            assert.strictEqual(predictions, 0);
        } finally {
            cts.dispose();
        }
    });

    test('finishes cursor prediction when the predicted line stays in the edit window', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = 1;' });
        let predictionCalls = 0;
        let complete = false;
        const workflow = {
            execute: async () => ({
                editResult: undefined,
                promptPieces: complete ? undefined : { editWindowLinesRange: { contains: () => true } },
                cachedNoEdit: { predictionComplete: complete },
            }),
            completeNoEditPrediction: () => { complete = true; },
            setAggressiveness() {},
        };
        const predictor = {
            isEnabled: () => true,
            predict: async () => { predictionCalls++; return Result.ok({ kind: 'sameFile', lineNumber: 0 }); },
        };
        const provider = new NextEditProvider(
            { createInstance: (type: { name: string }) => type.name === 'NesWorkflow' ? workflow : predictor } as never,
            { enabled: true, revision: 0, eagernessSelection: 'medium' } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const cts = new vscode.CancellationTokenSource();
        try {
            const position = new vscode.Position(0, 0);
            const context = { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext;
            await provider.provideInlineCompletionItems(document, position, context, cts.token);
            await provider.provideInlineCompletionItems(document, position, context, cts.token);
            assert.strictEqual(predictionCalls, 1);
            assert.strictEqual(complete, true);
        } finally {
            cts.dispose();
        }
    });

    test('retries a transient cursor prediction failure while the no-edit cache stays pending', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = 1;' });
        let predictionCalls = 0;
        let workflowCalls = 0;
        let completes = 0;
        const workflow = {
            execute: async () => {
                workflowCalls++;
                return { editResult: undefined, promptPieces: {}, cachedNoEdit: { predictionComplete: false } };
            },
            completeNoEditPrediction: () => { completes++; },
            setAggressiveness() {},
        };
        const provider = new NextEditProvider(
            { createInstance: (type: { name: string }) => type.name === 'NesWorkflow' ? workflow : {
                isEnabled: () => true,
                predict: async () => { predictionCalls++; return Result.error('fetchError:temporary'); },
            } } as never,
            { enabled: true, revision: 0, eagernessSelection: 'medium' } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const cts = new vscode.CancellationTokenSource();
        try {
            const position = new vscode.Position(0, 0);
            const context = { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext;
            await provider.provideInlineCompletionItems(document, position, context, cts.token);
            await provider.provideInlineCompletionItems(document, position, context, cts.token);
            assert.strictEqual(workflowCalls, 2);
            assert.strictEqual(predictionCalls, 2);
            assert.strictEqual(completes, 0);
        } finally {
            cts.dispose();
        }
    });

    test('accepting the currently shown model edit expands the next edit window', () => {
        let expansions = 0;
        const provider = Object.create(NextEditProvider.prototype) as NextEditProvider;
        const active = { wasShown: false, info: { source: 'provider' } };
        const internals = provider as unknown as {
            _workflow: { noteAcceptedEdit(): void };
            _activeItem: unknown;
            _onDidChange: { fire(): void };
        };
        internals._workflow = { noteAcceptedEdit: () => { expansions++; } };
        internals._activeItem = active;
        internals._onDidChange = { fire() {} };
        provider.handleEndOfLifetime(active as never, { kind: 0 });
        assert.strictEqual(expansions, 1);
    });

    test('accepting a displayed edit still expands after a newer request changes the active item', () => {
        let expansions = 0;
        const provider = Object.create(NextEditProvider.prototype) as NextEditProvider;
        const accepted = { wasShown: true, info: { source: 'provider' } };
        const internals = provider as unknown as {
            _workflow: { noteAcceptedEdit(): void };
            _activeItem: unknown;
            _onDidChange: { fire(): void };
            _adaptiveEagerness: { record(accepted: boolean): void };
            _aggressivenessSelection: string;
        };
        internals._workflow = { noteAcceptedEdit: () => { expansions++; } };
        internals._activeItem = { wasShown: false };
        internals._onDidChange = { fire() {} };
        internals._adaptiveEagerness = { record() {} };
        internals._aggressivenessSelection = 'medium';
        provider.handleEndOfLifetime(accepted as never, { kind: 0 });
        assert.strictEqual(expansions, 1);
    });

    test('redrawing a shown edit preserves its first display time', () => {
        const provider = Object.create(NextEditProvider.prototype) as NextEditProvider;
        const shownAt = Date.now() - 2_000;
        const item = { wasShown: true, shownAt };
        const internals = provider as unknown as {
            _activeItem: unknown;
            _speculativeProjection: unknown;
            _scheduleSpeculativePrefetch: () => void;
        };
        internals._activeItem = item;
        internals._speculativeProjection = {};
        internals._scheduleSpeculativePrefetch = () => {};
        provider.handleDidShowCompletionItem(item as never, 'edit');
        assert.strictEqual(item.shownAt, shownAt);
    });

    test('disabling NES aborts pending work and clears old edit suggestions', () => {
        const changes = new vscode.EventEmitter<void>();
        const config = { enabled: true, onDidChangeEnabled: changes.event };
        let clears = 0;
        const workflow = {
            clearPendingAndCachedEdits: () => { clears++; },
            noteDiagnosticsChanged: () => false,
            dispose() {},
        };
        const provider = new NextEditProvider(
            { createInstance: () => workflow } as never,
            config as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const registration = provider.register();
        try {
            config.enabled = false;
            changes.fire();
            assert.strictEqual(clears, 1);
        } finally {
            registration.dispose();
            changes.dispose();
        }
    });

    test('changing the NES model in settings clears cached edits and pending requests', async () => {
        const config = vscode.workspace.getConfiguration('localalot.nes');
        const previousModel = config.inspect<string>('model')?.globalValue;
        let clears = 0;
        const workflow = {
            clearPendingAndCachedEdits: () => { clears++; },
            execute: async () => ({ editResult: undefined }),
            noteDiagnosticsChanged: () => false,
            dispose() {},
        };
        const provider = new NextEditProvider(
            { createInstance: () => workflow } as never,
            { enabled: true, revision: 0, eagernessSelection: 'medium', model: 'test',
                onDidChangeEnabled: () => new vscode.Disposable(() => {}) } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const registration = provider.register();
        try {
            await config.update('model', 'nes-cache-invalidation-test', vscode.ConfigurationTarget.Global);
            assert.ok(clears > 0, 'changing the model must invalidate the old result cache');
        } finally {
            await config.update('model', previousModel, vscode.ConfigurationTarget.Global);
            registration.dispose();
        }
    });

    test('changing NES eagerness invalidates results from the previous level', async () => {
        let clears = 0;
        let savedLevel = '';
        const workflow = {
            clearPendingAndCachedEdits: () => { clears++; },
            setAggressiveness() {},
        };
        const provider = new NextEditProvider(
            { createInstance: () => workflow } as never,
            { eagernessSelection: 'medium', setEagernessSelection: (value: string) => { savedLevel = value; } } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        await provider.setProviderOptionValue('eagerness', 'high');
        assert.strictEqual(savedLevel, 'high');
        assert.strictEqual(clears, 1);
        assert.strictEqual(provider.providerOptions[0].currentValueId, 'high');
    });
});
