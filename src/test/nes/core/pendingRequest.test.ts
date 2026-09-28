import * as assert from 'assert';
import * as vscode from 'vscode';
import { NesWorkflow } from '../../../completions/nes/core/nesWorkflow';
import { NextEditCache } from '../../../completions/nes/nextEditCache';
import { Deferred } from '../../../common/async';
import { DocumentId } from '../../../completions/nes/stubs/types';

suite('NES joined request completion', () => {
    test('retries a joined request after an open context document changes', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = calculateTax();',
        });
        const neighbor = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'export function calculateTax() { return 1; }',
        });
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
        let notifyFirst!: () => void;
        const firstStarted = new Promise<void>(resolve => { notifyFirst = resolve; });
        let requests = 0;
        const workflow = new NesWorkflow(
            {
                revision: 0, enabled: true, endpoint: 'chat/completions', stream: false,
                baseUrl: '', apiKey: '', model: 'test', family: 'standard', maxOutputTokens: 256,
                presencePenalty: 0, frequencyPenalty: 0,
                capabilities: { supports: { thinking: false, reasoning_effort: '' } },
                suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
            } as never,
            { getAdapter: () => ({ send: async () => {
                requests++;
                if (requests === 1) { notifyFirst(); await firstGate; }
                return { text: '', finishReason: 'stop' };
            } }) } as never,
            { info() {}, debug() {}, error() {} } as never,
            new NextEditCache(),
        );
        const internals = workflow as unknown as {
            _semanticContext: { collect: () => Promise<[]> };
            _promptAssembler: { assemble: () => unknown };
        };
        internals._semanticContext.collect = async () => [];
        internals._promptAssembler.assemble = () => ({
            promptPieces: {}, systemPrompt: 'edit', userPrompt: 'edit',
            editWindowLines: ['const value = calculateTax();'],
            editWindowRange: { start: 0, endExclusive: 1 },
        });
        let first: Promise<unknown> | undefined;
        try {
            first = workflow.execute(document, new vscode.Position(0, 0), true);
            await firstStarted;
            const joined = workflow.execute(document, new vscode.Position(0, 0), true);
            const edit = new vscode.WorkspaceEdit();
            edit.insert(neighbor.uri, new vscode.Position(0, neighbor.lineAt(0).text.length), ' // changed');
            assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
            releaseFirst();
            await first;
            await joined;
            assert.strictEqual(requests, 2);
        } finally {
            releaseFirst();
            await first;
            workflow.dispose();
        }
    });

    test('does not cache an in-flight no-edit response after diagnostics change', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = missing;' });
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
        let notifyFirst!: () => void;
        const firstStarted = new Promise<void>(resolve => { notifyFirst = resolve; });
        let requests = 0;
        const workflow = new NesWorkflow(
            {
                revision: 0, enabled: true, endpoint: 'chat/completions', stream: false,
                baseUrl: '', apiKey: '', model: 'test', family: 'standard', maxOutputTokens: 256,
                presencePenalty: 0, frequencyPenalty: 0,
                capabilities: { supports: { thinking: false, reasoning_effort: '' } },
                suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
            } as never,
            { getAdapter: () => ({ send: async () => {
                requests++;
                if (requests === 1) { notifyFirst(); await firstGate; }
                return { text: '', finishReason: 'stop' };
            } }) } as never,
            { info() {}, debug() {}, error() {} } as never,
            new NextEditCache(),
        );
        const internals = workflow as unknown as {
            _semanticContext: { collect: () => Promise<[]> };
            _promptAssembler: { assemble: () => unknown };
        };
        internals._semanticContext.collect = async () => [];
        internals._promptAssembler.assemble = () => ({
            promptPieces: {}, systemPrompt: 'edit', userPrompt: 'edit',
            editWindowLines: ['const value = missing;'],
            editWindowRange: { start: 0, endExclusive: 1 },
        });
        let first: Promise<unknown> | undefined;
        try {
            first = workflow.execute(document, new vscode.Position(0, 0), true);
            await firstStarted;
            const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 14, 0, 21), 'missing name');
            workflow.noteDiagnosticsChanged(document.uri.toString(), [diagnostic]);
            releaseFirst();
            await first;
            await workflow.execute(document, new vscode.Position(0, 0), true);
            assert.strictEqual(requests, 2);
        } finally {
            releaseFirst();
            await first;
            workflow.dispose();
        }
    });

    test('caches only conclusive no-edit responses within the reduced cursor window', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript',
            content: Array.from({ length: 20 }, (_, line) => `const value${line} = ${line};`).join('\n'),
        });
        let requests = 0;
        const cache = new NextEditCache();
        const workflow = new NesWorkflow(
            {
                revision: 0, enabled: true, endpoint: 'chat/completions', stream: false,
                baseUrl: '', apiKey: '', model: 'test', family: 'standard', maxOutputTokens: 256,
                presencePenalty: 0, frequencyPenalty: 0,
                capabilities: { supports: { thinking: false, reasoning_effort: '' } },
                suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
            } as never,
            { getAdapter: () => ({ send: async () => {
                requests++;
                return { text: '', finishReason: requests === 1 ? 'length' : 'stop' };
            } }) } as never,
            { info() {}, debug() {}, error() {} } as never,
            cache,
        );
        const internals = workflow as unknown as {
            _semanticContext: { collect: () => Promise<[]> };
            _promptAssembler: { assemble: (...args: unknown[]) => unknown };
        };
        internals._semanticContext.collect = async () => [];
        internals._promptAssembler.assemble = (_document, position) => ({
            promptPieces: {}, systemPrompt: 'edit', userPrompt: 'edit',
            editWindowLines: [document.lineAt((position as vscode.Position).line).text],
            editWindowRange: { start: (position as vscode.Position).line, endExclusive: (position as vscode.Position).line + 1 },
        });
        try {
            await workflow.execute(document, new vscode.Position(4, 0), true);
            await workflow.execute(document, new vscode.Position(4, 0), true);
            assert.strictEqual(requests, 2);
            assert.ok(cache.getNoNextEdit(DocumentId.create(document.uri.toString()), document, { line: 4 }));
            await workflow.execute(document, new vscode.Position(15, 0), true, undefined, false, false);
            assert.strictEqual(requests, 3);
            assert.ok(cache.getNoNextEdit(DocumentId.create(document.uri.toString()), document, { line: 4 }));
            const pendingPrediction = await workflow.execute(document, new vscode.Position(4, 0), true);
            assert.ok(pendingPrediction.promptPieces, 'cached empty edit must still reach cursor prediction');
            assert.strictEqual(pendingPrediction.cachedNoEdit?.predictionComplete, false);
            workflow.completeNoEditPrediction(document, new vscode.Position(4, 0));
            const completedPrediction = await workflow.execute(document, new vscode.Position(4, 0), true);
            assert.strictEqual(completedPrediction.promptPieces, undefined);
            assert.strictEqual(completedPrediction.cachedNoEdit?.predictionComplete, true);
            assert.strictEqual(requests, 3);
            await workflow.execute(document, new vscode.Position(4, 0), true);
            assert.strictEqual(requests, 3);
            const diagnostic = new vscode.Diagnostic(new vscode.Range(4, 0, 4, 5), 'missing symbol');
            workflow.noteDiagnosticsChanged(document.uri.toString(), [diagnostic]);
            await workflow.execute(document, new vscode.Position(4, 0), true);
            assert.strictEqual(requests, 4);
            workflow.noteDiagnosticsChanged(document.uri.toString(), [diagnostic]);
            await workflow.execute(document, new vscode.Position(4, 0), true);
            assert.strictEqual(requests, 4);
            diagnostic.message = 'different symbol';
            workflow.noteDiagnosticsChanged(document.uri.toString(), [diagnostic]);
            await workflow.execute(document, new vscode.Position(4, 0), true);
            assert.strictEqual(requests, 5);
            await workflow.execute(document, new vscode.Position(15, 0), true);
            assert.strictEqual(requests, 6);
        } finally {
            workflow.dispose();
        }
    });

    test('uses the expanded edit window for one network request after acceptance', async () => {
        const documents = await Promise.all([0, 1].map(index => vscode.workspace.openTextDocument({
            language: 'typescript', content: `const acceptedFollowUp${index} = ${index};`,
        })));
        const expanded: Array<number | undefined> = [];
        const workflow = new NesWorkflow(
            {
                revision: 0, enabled: true, endpoint: 'chat/completions', stream: false,
                baseUrl: '', apiKey: '', model: 'test', family: 'standard', maxOutputTokens: 256,
                presencePenalty: 0, frequencyPenalty: 0,
                capabilities: { supports: { thinking: false, reasoning_effort: '' } },
                suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
            } as never,
            { getAdapter: () => ({ send: async () => ({ text: '', finishReason: 'stop' }) }) } as never,
            { info() {}, debug() {}, error() {} } as never,
            new NextEditCache(),
        );
        const internals = workflow as unknown as {
            _semanticContext: { collect: () => Promise<[]> };
            _promptAssembler: { assemble: (...args: unknown[]) => unknown };
        };
        internals._semanticContext.collect = async () => [];
        internals._promptAssembler.assemble = (...args) => {
            expanded.push(args[6] as number | undefined);
            return {
                promptPieces: {}, systemPrompt: 'edit', userPrompt: 'edit',
                editWindowLines: ['const value = 1;'],
                editWindowRange: { start: 0, endExclusive: 1 },
            };
        };
        try {
            workflow.noteAcceptedEdit();
            await workflow.execute(documents[0], new vscode.Position(0, 0), true, undefined, true);
            await workflow.execute(documents[0], new vscode.Position(0, 0), true);
            await workflow.execute(documents[1], new vscode.Position(0, 0), true);
            assert.deepStrictEqual(expanded, [undefined, 10, undefined]);
        } finally {
            workflow.dispose();
        }
    });

    test('starts a new request after the cursor leaves the pending edit window', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript',
            content: Array.from({ length: 16 }, (_, line) => `const value${line} = ${line};`).join('\n'),
        });
        const pendingResult = new Deferred<{ editResult: undefined }>();
        let networkCalls = 0;
        const workflow = new NesWorkflow(
            {
                revision: 0, enabled: true, endpoint: 'chat/completions', stream: false,
                baseUrl: '', apiKey: '', model: 'test', family: 'standard', maxOutputTokens: 256,
                presencePenalty: 0, frequencyPenalty: 0,
                capabilities: { supports: { thinking: false, reasoning_effort: '' } },
                suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
            } as never,
            { getAdapter: () => ({ send: async () => {
                networkCalls++;
                return { text: '', finishReason: 'stop' };
            } }) } as never,
            { info() {}, debug() {}, error() {} } as never,
            new NextEditCache(),
        );
        const internals = workflow as unknown as {
            _semanticContext: { collect: () => Promise<[]> };
            _promptAssembler: { assemble: () => unknown };
            _pendingRequest?: unknown;
        };
        internals._semanticContext.collect = async () => [];
        internals._promptAssembler.assemble = () => ({
            promptPieces: {}, systemPrompt: 'edit', userPrompt: 'edit',
            editWindowLines: ['const value10 = 10;'],
            editWindowRange: { start: 10, endExclusive: 11 },
        });
        internals._pendingRequest = {
            headerRequestId: 'old-window', documentUri: document.uri.toString(),
            documentText: document.getText(), configRevision: 0,
            position: new vscode.Position(0, 0), speculative: false,
            abortController: new AbortController(), liveDependants: 1,
            deferred: pendingResult,
        };
        try {
            await workflow.execute(document, new vscode.Position(10, 0), true);
            assert.strictEqual(networkCalls, 1);
        } finally {
            pendingResult.resolve({ editResult: undefined });
            workflow.dispose();
        }
    });

    test('does not send a request whose only caller canceled while waiting for the network slot', async () => {
        const firstDocument = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const first = 1;' });
        const secondDocument = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const second = 2;' });
        const position = new vscode.Position(0, 0);
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
        let notifyStarted!: () => void;
        const started = new Promise<void>(resolve => { notifyStarted = resolve; });
        let networkCalls = 0;
        const adapter = {
            async send() {
                networkCalls++;
                if (networkCalls === 1) {
                    notifyStarted();
                    await firstGate;
                }
                return { text: '', finishReason: 'stop' };
            },
        };
        const config = {
            revision: 0, enabled: true, endpoint: 'chat/completions',
            baseUrl: '', apiKey: '', model: 'test', family: 'standard',
            maxOutputTokens: 256, stream: false,
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { supports: { thinking: false, reasoning_effort: '' } },
            suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
        };
        const workflow = new NesWorkflow(config as never,
            { getAdapter: () => adapter } as never,
            { info() {}, debug() {}, error() {} } as never,
            new NextEditCache());
        const internals = workflow as unknown as {
            _semanticContext: { collect: () => Promise<[]> };
            _promptAssembler: { assemble: () => unknown };
            _pendingRequest?: { documentUri: string };
        };
        internals._semanticContext.collect = async () => [];
        internals._promptAssembler.assemble = () => ({
            promptPieces: {}, systemPrompt: 'edit', userPrompt: 'edit',
            editWindowLines: ['const first = 1;'],
            editWindowRange: { start: 0, endExclusive: 1 },
        });
        const cts = new vscode.CancellationTokenSource();
        let first: Promise<unknown> | undefined;
        let second: Promise<unknown> | undefined;
        try {
            first = workflow.execute(firstDocument, position, true);
            await started;
            second = workflow.execute(secondDocument, position, true, cts.token);
            for (let i = 0; i < 30 && internals._pendingRequest?.documentUri !== secondDocument.uri.toString(); i++) {
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            assert.strictEqual(internals._pendingRequest?.documentUri, secondDocument.uri.toString());
            cts.cancel();
            await second;
            assert.strictEqual(networkCalls, 1);
        } finally {
            releaseFirst();
            await Promise.allSettled([first, second].filter(Boolean) as Promise<unknown>[]);
            cts.dispose();
            workflow.dispose();
        }
    });

    test('skips prompt and network work when the endpoint is unconfigured', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = 1;' });
        const workflow = new NesWorkflow(
            { enabled: true, endpointConfigured: false, revision: 0 } as never,
            { getAdapter: () => { throw new Error('network should not start'); } } as never,
            { info() {}, debug() {}, error() {} } as never,
            new NextEditCache(),
        );
        try {
            assert.strictEqual((await workflow.execute(document, new vscode.Position(0, 0), true)).editResult, undefined);
        } finally {
            workflow.dispose();
        }
    });

    for (const [name, response] of [
        ['empty model response', ''],
        ['filtered no-op response', '###remain edit start boundary line###\nconst a = 1;\n###remain edit end boundary line###'],
    ] as const) {
        test(`settles both callers after ${name}`, async () => {
            const document = await vscode.workspace.openTextDocument({
                language: 'typescript', content: 'const a = 1;\n',
            });
            const position = new vscode.Position(0, 12);
            let releaseStream!: () => void;
            const streamGate = new Promise<void>(resolve => { releaseStream = resolve; });
            let notifyStarted!: () => void;
            const streamStarted = new Promise<void>(resolve => { notifyStarted = resolve; });
            const adapter = {
                async *sendStream() {
                    notifyStarted();
                    await streamGate;
                    yield response;
                    return { text: response };
                },
            };
            const config = {
                enabled: true,
                endpoint: 'chat/completions',
                baseUrl: '', apiKey: '', model: 'test', family: 'standard',
                maxOutputTokens: 256, stream: true,
                presencePenalty: 0, frequencyPenalty: 0,
                capabilities: { supports: { thinking: false, reasoning_effort: '' } },
                suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
            };
            const log = { info() {}, debug() {}, error() {} };
            const workflow = new NesWorkflow(
                config as never,
                { getAdapter: () => adapter } as never,
                log as never,
                new NextEditCache(),
            );
            const internals = workflow as unknown as {
                _semanticContext: { collect: () => Promise<[]> };
                _promptAssembler: { assemble: () => unknown };
            };
            internals._semanticContext.collect = async () => [];
            const promptPieces = {};
            internals._promptAssembler.assemble = () => ({
                promptPieces,
                systemPrompt: 'edit code',
                userPrompt: 'edit code',
                editWindowLines: ['const a = 1;'],
                editWindowRange: { start: 0, endExclusive: 1 },
            });

            const first = workflow.execute(document, position, true);
            await streamStarted;
            const joined = workflow.execute(document, position, true);
            releaseStream();

            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
                const results = await Promise.race([
                    Promise.all([first, joined]),
                    new Promise<never>((_, reject) => {
                        timeout = setTimeout(() => reject(new Error('joined NES request did not settle')), 3000);
                    }),
                ]);
                assert.strictEqual(results[0].editResult, undefined);
                assert.strictEqual(results[1].editResult, undefined);
                assert.strictEqual(results[0].promptPieces, promptPieces);
                assert.strictEqual(results[1].promptPieces, promptPieces);
            } finally {
                if (timeout) clearTimeout(timeout);
                workflow.dispose();
            }
        });
    }
});

suite('NES speculative request priority', () => {
    test('model configuration change invalidates a cached edit', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = 1;\n',
        });
        const position = new vscode.Position(0, 0);
        let networkCalls = 0;
        const adapter = {
            async *sendStream() {
                networkCalls++;
                return { text: '' };
            },
        };
        const config = {
            revision: 0, enabled: true, endpoint: 'chat/completions',
            baseUrl: '', apiKey: '', model: 'old-model', family: 'standard',
            maxOutputTokens: 256, stream: true,
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { supports: { thinking: false, reasoning_effort: '' } },
            suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
        };
        const log = { info() {}, debug() {}, error() {} };
        const cache = new NextEditCache();
        const workflow = new NesWorkflow(config as never,
            { getAdapter: () => adapter } as never, log as never, cache);
        const internals = workflow as unknown as {
            _semanticContext: { collect: () => Promise<[]> };
            _promptAssembler: { assemble: () => unknown };
        };
        internals._semanticContext.collect = async () => [];
        internals._promptAssembler.assemble = () => ({
            promptPieces: {}, systemPrompt: 'edit code', userPrompt: 'edit code',
            editWindowLines: ['const value = 1;'],
            editWindowRange: { start: 0, endExclusive: 1 },
        });
        try {
            await workflow.execute(document, position, true);
            const docId = DocumentId.create(document.uri.toString());
            cache.setKthNextEdit(docId, {
                docId, documentBeforeEdit: document.getText(),
                editWindow: { startLine: 0, endLineExclusive: 1 },
                edit: 'const value = 2;', cacheTime: Date.now(),
            });
            config.model = 'new-model';
            config.revision++;
            const outcome = await workflow.execute(document, position, true);
            assert.strictEqual(outcome.editResult, undefined);
            assert.strictEqual(networkCalls, 2);
            assert.strictEqual(cache.lookupNextEdit(docId, document, position), undefined);
        } finally {
            workflow.dispose();
        }
    });

    test('model configuration change discards an old in-flight edit', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = 1;\n',
        });
        let releaseStream!: () => void;
        const streamGate = new Promise<void>(resolve => { releaseStream = resolve; });
        let notifyStarted!: () => void;
        const streamStarted = new Promise<void>(resolve => { notifyStarted = resolve; });
        const response = '###remain edit start boundary line###\nconst value = 2;\n###remain edit end boundary line###';
        const adapter = {
            async *sendStream() {
                notifyStarted();
                await streamGate;
                yield response;
                return { text: response };
            },
        };
        const config = {
            revision: 0, enabled: true, endpoint: 'chat/completions',
            baseUrl: '', apiKey: '', model: 'old-model', family: 'standard',
            maxOutputTokens: 256, stream: true,
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { supports: { thinking: false, reasoning_effort: '' } },
            suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
        };
        const log = { info() {}, debug() {}, error() {} };
        const cache = new NextEditCache();
        const workflow = new NesWorkflow(config as never,
            { getAdapter: () => adapter } as never, log as never, cache);
        const internals = workflow as unknown as {
            _semanticContext: { collect: () => Promise<[]> };
            _promptAssembler: { assemble: () => unknown };
        };
        internals._semanticContext.collect = async () => [];
        internals._promptAssembler.assemble = () => ({
            promptPieces: {}, systemPrompt: 'edit code', userPrompt: 'edit code',
            editWindowLines: ['const value = 1;'],
            editWindowRange: { start: 0, endExclusive: 1 },
        });
        try {
            const outcome = workflow.execute(document, new vscode.Position(0, 0), true);
            await streamStarted;
            config.model = 'new-model';
            config.revision++;
            releaseStream();
            assert.strictEqual((await outcome).editResult, undefined);
            assert.strictEqual(cache.lookupNextEdit(DocumentId.create(document.uri.toString()),
                document, new vscode.Position(0, 0)), undefined);
        } finally {
            releaseStream();
            workflow.dispose();
        }
    });

    for (const [name, response] of [
        ['edit', '###remain edit start boundary line###\nconst value = 2;\n###remain edit end boundary line###'],
        ['no edit', ''],
    ] as const) {
        test(`discards an in-flight ${name} after an open context document changes`, async () => {
            const document = await vscode.workspace.openTextDocument({
                language: 'typescript', content: 'const value = calculateTax();\n',
            });
            const neighbor = await vscode.workspace.openTextDocument({
                language: 'typescript', content: 'export function calculateTax() { return 1; }',
            });
            let releaseStream!: () => void;
            const streamGate = new Promise<void>(resolve => { releaseStream = resolve; });
            let notifyStarted!: () => void;
            const streamStarted = new Promise<void>(resolve => { notifyStarted = resolve; });
            const adapter = {
                async *sendStream() {
                    notifyStarted();
                    await streamGate;
                    if (response) yield response;
                    return { text: response };
                },
            };
            const config = {
                revision: 0, enabled: true, endpoint: 'chat/completions',
                baseUrl: '', apiKey: '', model: 'test-model', family: 'standard',
                maxOutputTokens: 256, stream: true,
                presencePenalty: 0, frequencyPenalty: 0,
                capabilities: { supports: { thinking: false, reasoning_effort: '' } },
                suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
            };
            const cache = new NextEditCache();
            const workflow = new NesWorkflow(config as never,
                { getAdapter: () => adapter } as never,
                { info() {}, debug() {}, error() {} } as never, cache);
            const internals = workflow as unknown as {
                _semanticContext: { collect: () => Promise<[]> };
                _promptAssembler: { assemble: () => unknown };
            };
            internals._semanticContext.collect = async () => [];
            internals._promptAssembler.assemble = () => ({
                promptPieces: {}, systemPrompt: 'edit code', userPrompt: 'edit code',
                editWindowLines: ['const value = calculateTax();'],
                editWindowRange: { start: 0, endExclusive: 1 },
            });
            try {
                const outcome = workflow.execute(document, new vscode.Position(0, 0), true);
                await streamStarted;
                const edit = new vscode.WorkspaceEdit();
                edit.insert(neighbor.uri, new vscode.Position(0, neighbor.lineAt(0).text.length), ' // changed');
                assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
                releaseStream();
                assert.strictEqual((await outcome).editResult, undefined);
                const docId = DocumentId.create(document.uri.toString());
                assert.strictEqual(cache.lookupNextEdit(docId, document, new vscode.Position(0, 0)), undefined);
                assert.strictEqual(cache.getNoNextEdit(docId, document, new vscode.Position(0, 0)), undefined);
            } finally {
                releaseStream();
                workflow.dispose();
            }
        });
    }

    test('cancelled or disabled caller does not join a pending stream', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = 1;\n',
        });
        const position = new vscode.Position(0, 0);
        const config = { enabled: true };
        const log = { info() {}, debug() {}, error() {} };
        const workflow = new NesWorkflow(config as never,
            { getAdapter: () => { throw new Error('unexpected adapter request'); } } as never,
            log as never, new NextEditCache());
        const deferred = new Deferred<{ editResult: undefined }>();
        const pending = {
            headerRequestId: 'visible', documentUri: document.uri.toString(),
            documentText: document.getText(), position, speculative: false,
            abortController: new AbortController(), liveDependants: 1, deferred,
        };
        const internals = workflow as unknown as { _pendingRequest: typeof pending };
        internals._pendingRequest = pending;
        const cts = new vscode.CancellationTokenSource();
        try {
            cts.cancel();
            assert.deepStrictEqual(await workflow.execute(document, position, true, cts.token),
                { editResult: undefined });
            config.enabled = false;
            assert.deepStrictEqual(await workflow.execute(document, position, true),
                { editResult: undefined });
            assert.strictEqual(pending.liveDependants, 1);
            assert.strictEqual(pending.abortController.signal.aborted, false);
        } finally {
            deferred.resolve({ editResult: undefined });
            cts.dispose();
            workflow.dispose();
        }
    });

    for (const startPrefetchFirst of [false, true]) {
        test(startPrefetchFirst
            ? 'prefetch finishing prompt build does not cancel a newer visible request'
            : 'prefetch does not cancel an existing visible request', async () => {
            const visibleDocument = await vscode.workspace.openTextDocument({
                language: 'typescript', content: 'const visible = 1;\n',
            });
            const prefetchDocument = await vscode.workspace.openTextDocument({
                language: 'typescript', content: 'const prefetch = 1;\n',
            });
            let releaseVisible!: () => void;
            const visibleGate = new Promise<void>(resolve => { releaseVisible = resolve; });
            let notifyVisibleStarted!: () => void;
            const visibleStarted = new Promise<void>(resolve => { notifyVisibleStarted = resolve; });
            let releasePrefetchPrompt!: () => void;
            const prefetchPromptGate = new Promise<void>(resolve => { releasePrefetchPrompt = resolve; });
            let notifyPrefetchPromptStarted!: () => void;
            const prefetchPromptStarted = new Promise<void>(resolve => { notifyPrefetchPromptStarted = resolve; });
            let visibleSignal: AbortSignal | undefined;
            let networkCalls = 0;
            const adapter = {
                async *sendStream(_request: unknown, signal: AbortSignal) {
                    networkCalls++;
                    visibleSignal = signal;
                    notifyVisibleStarted();
                    await visibleGate;
                    return { text: '' };
                },
            };
            const config = {
                enabled: true, endpoint: 'chat/completions',
                baseUrl: '', apiKey: '', model: 'test', family: 'standard',
                maxOutputTokens: 256, stream: true,
                presencePenalty: 0, frequencyPenalty: 0,
                capabilities: { supports: { thinking: false, reasoning_effort: '' } },
                suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
            };
            const log = { info() {}, debug() {}, error() {} };
            const workflow = new NesWorkflow(config as never,
                { getAdapter: () => adapter } as never, log as never, new NextEditCache());
            const internals = workflow as unknown as {
                _semanticContext: { collect: (document: vscode.TextDocument) => Promise<[]> };
                _promptAssembler: { assemble: () => unknown };
            };
            internals._semanticContext.collect = async document => {
                if (startPrefetchFirst && document.uri.toString() === prefetchDocument.uri.toString()) {
                    notifyPrefetchPromptStarted();
                    await prefetchPromptGate;
                }
                return [];
            };
            internals._promptAssembler.assemble = () => ({
                promptPieces: {}, systemPrompt: 'edit code', userPrompt: 'edit code',
                editWindowLines: ['const visible = 1;'],
                editWindowRange: { start: 0, endExclusive: 1 },
            });
            try {
                let prefetch: Promise<unknown> | undefined;
                if (startPrefetchFirst) {
                    prefetch = workflow.execute(prefetchDocument, new vscode.Position(0, 0), true, undefined, true);
                    await prefetchPromptStarted;
                }
                const visible = workflow.execute(visibleDocument, new vscode.Position(0, 0), true);
                await visibleStarted;
                if (!prefetch) {
                    prefetch = workflow.execute(prefetchDocument, new vscode.Position(0, 0), true, undefined, true);
                } else {
                    releasePrefetchPrompt();
                }
                const prefetchResult = await prefetch;
                assert.deepStrictEqual(prefetchResult, { editResult: undefined });
                assert.strictEqual(visibleSignal?.aborted, false);
                assert.strictEqual(networkCalls, 1);
                releaseVisible();
                await visible;
            } finally {
                releaseVisible();
                releasePrefetchPrompt();
                workflow.dispose();
            }
        });
    }
});

suite('NES cancelled stream', () => {
    test('cancelled joined caller returns while the visible stream continues', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const a = 1;\n',
        });
        let releaseStream!: () => void;
        const streamGate = new Promise<void>(resolve => { releaseStream = resolve; });
        let notifyStarted!: () => void;
        const streamStarted = new Promise<void>(resolve => { notifyStarted = resolve; });
        let visibleSignal: AbortSignal | undefined;
        const adapter = {
            async *sendStream(_request: unknown, signal: AbortSignal) {
                visibleSignal = signal;
                notifyStarted();
                await streamGate;
                return { text: '' };
            },
        };
        const config = {
            enabled: true, endpoint: 'chat/completions',
            baseUrl: '', apiKey: '', model: 'test', family: 'standard',
            maxOutputTokens: 256, stream: true,
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { supports: { thinking: false, reasoning_effort: '' } },
            suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
        };
        const log = { info() {}, debug() {}, error() {} };
        const workflow = new NesWorkflow(config as never,
            { getAdapter: () => adapter } as never, log as never, new NextEditCache());
        const internals = workflow as unknown as {
            _semanticContext: { collect: () => Promise<[]> };
            _promptAssembler: { assemble: () => unknown };
        };
        internals._semanticContext.collect = async () => [];
        internals._promptAssembler.assemble = () => ({
            promptPieces: {}, systemPrompt: 'edit code', userPrompt: 'edit code',
            editWindowLines: ['const a = 1;'],
            editWindowRange: { start: 0, endExclusive: 1 },
        });
        const joinedToken = new vscode.CancellationTokenSource();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const visible = workflow.execute(document, new vscode.Position(0, 0), true);
            await streamStarted;
            const joined = workflow.execute(document, new vscode.Position(0, 0), true, joinedToken.token);
            joinedToken.cancel();
            const result = await Promise.race([
                joined,
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => reject(new Error('cancelled join did not return promptly')), 500);
                }),
            ]);
            assert.deepStrictEqual(result, { editResult: undefined });
            assert.strictEqual(visibleSignal?.aborted, false);
            releaseStream();
            await visible;
        } finally {
            if (timeout) clearTimeout(timeout);
            releaseStream();
            joinedToken.dispose();
            workflow.dispose();
        }
    });

    test('does not apply an unmarked partial edit after the stream is aborted', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const a = 1;\n',
        });
        let releaseStream!: () => void;
        const streamGate = new Promise<void>(resolve => { releaseStream = resolve; });
        let notifyPartialRead!: () => void;
        const partialRead = new Promise<void>(resolve => { notifyPartialRead = resolve; });
        const adapter = {
            async *sendStream() {
                yield 'const a = 2;';
                notifyPartialRead();
                await streamGate;
                return { text: 'const a = 2;' };
            },
        };
        const config = {
            enabled: true,
            endpoint: 'chat/completions',
            baseUrl: '', apiKey: '', model: 'test', family: 'standard',
            maxOutputTokens: 256, stream: true,
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { supports: { thinking: false, reasoning_effort: '' } },
            suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
        };
        const log = { info() {}, debug() {}, error() {} };
        const workflow = new NesWorkflow(
            config as never,
            { getAdapter: () => adapter } as never,
            log as never,
            new NextEditCache(),
        );
        const internals = workflow as unknown as {
            _semanticContext: { collect: () => Promise<[]> };
            _promptAssembler: { assemble: () => unknown };
            _pendingRequest?: { abortController: AbortController };
        };
        internals._semanticContext.collect = async () => [];
        internals._promptAssembler.assemble = () => ({
            promptPieces: {},
            systemPrompt: 'edit code',
            userPrompt: 'edit code',
            editWindowLines: ['const a = 1;'],
            editWindowRange: { start: 0, endExclusive: 1 },
        });

        try {
            const pending = workflow.execute(document, new vscode.Position(0, 12), true);
            await partialRead;
            assert.ok(internals._pendingRequest);
            internals._pendingRequest.abortController.abort();
            releaseStream();
            const result = await pending;
            assert.strictEqual(result.editResult, undefined);
        } finally {
            releaseStream();
            workflow.dispose();
        }
    });

    test('aborts a joined request after both callers cancel', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const a = 1;\n',
        });
        let notifyStarted!: () => void;
        const streamStarted = new Promise<void>(resolve => { notifyStarted = resolve; });
        let wasAborted = false;
        const adapter = {
            async *sendStream(_request: unknown, signal: AbortSignal) {
                notifyStarted();
                yield 'const a = 2;';
                await new Promise<void>(resolve => {
                    if (signal.aborted) { resolve(); return; }
                    signal.addEventListener('abort', () => resolve(), { once: true });
                });
                wasAborted = signal.aborted;
                return { text: 'const a = 2;' };
            },
        };
        const config = {
            enabled: true,
            endpoint: 'chat/completions',
            baseUrl: '', apiKey: '', model: 'test', family: 'standard',
            maxOutputTokens: 256, stream: true,
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { supports: { thinking: false, reasoning_effort: '' } },
            suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
        };
        const log = { info() {}, debug() {}, error() {} };
        const workflow = new NesWorkflow(
            config as never,
            { getAdapter: () => adapter } as never,
            log as never,
            new NextEditCache(),
        );
        const internals = workflow as unknown as {
            _semanticContext: { collect: () => Promise<[]> };
            _promptAssembler: { assemble: () => unknown };
        };
        internals._semanticContext.collect = async () => [];
        internals._promptAssembler.assemble = () => ({
            promptPieces: {},
            systemPrompt: 'edit code',
            userPrompt: 'edit code',
            editWindowLines: ['const a = 1;'],
            editWindowRange: { start: 0, endExclusive: 1 },
        });
        const firstToken = new vscode.CancellationTokenSource();
        const joinedToken = new vscode.CancellationTokenSource();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const first = workflow.execute(document, new vscode.Position(0, 12), true, firstToken.token);
            await streamStarted;
            const joined = workflow.execute(document, new vscode.Position(0, 12), true, joinedToken.token);
            firstToken.cancel();
            joinedToken.cancel();
            const results = await Promise.race([
                Promise.all([first, joined]),
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => reject(new Error('joined NES stream did not abort')), 3000);
                }),
            ]);
            assert.strictEqual(wasAborted, true);
            assert.strictEqual(results[0].editResult, undefined);
            assert.strictEqual(results[1].editResult, undefined);
        } finally {
            if (timeout) clearTimeout(timeout);
            firstToken.dispose();
            joinedToken.dispose();
            workflow.dispose();
        }
    });
});

suite('NES explicit deletion response', () => {
    for (const [name, response, expectedKind] of [
        ['complete boundary pair', '###remain edit start boundary line###\n###remain edit end boundary line###', 'delete'],
        ['one blank replacement line', '###remain edit start boundary line###\n\n###remain edit end boundary line###', 'none'],
        ['truncated boundary pair', '###remain edit start boundary line###\n###remain edit end boundary', 'none'],
        ['empty unmarked response', '', 'none'],
    ] as const) {
        test(name, async () => {
            const document = await vscode.workspace.openTextDocument({
                language: 'typescript', content: 'keep();\nremove();',
            });
            const adapter = {
                async *sendStream() {
                    yield response;
                    return { text: response };
                },
            };
            const config = {
                enabled: true,
                endpoint: 'chat/completions',
                baseUrl: '', apiKey: '', model: 'test', family: 'standard',
                maxOutputTokens: 256, stream: true,
                presencePenalty: 0, frequencyPenalty: 0,
                capabilities: { supports: { thinking: false, reasoning_effort: '' } },
                suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
            };
            const log = { info() {}, debug() {}, error() {} };
            const workflow = new NesWorkflow(
                config as never,
                { getAdapter: () => adapter } as never,
                log as never,
                new NextEditCache(),
            );
            const internals = workflow as unknown as {
                _semanticContext: { collect: () => Promise<[]> };
                _promptAssembler: { assemble: () => unknown };
            };
            internals._semanticContext.collect = async () => [];
            internals._promptAssembler.assemble = () => ({
                promptPieces: {},
                systemPrompt: 'edit code',
                userPrompt: 'edit code',
                editWindowLines: ['remove();'],
                editWindowRange: { start: 1, endExclusive: 2 },
            });
            try {
                const outcome = await workflow.execute(document, new vscode.Position(1, 0), true);
                assert.strictEqual(!!outcome.editResult, expectedKind !== 'none');
                if (expectedKind !== 'none') {
                    const result = outcome.editResult!;
                    assert.strictEqual(result.edits.length, 1);
                    const edit = result.edits[0];
                    const textAfterEdit = document.getText().slice(0, document.offsetAt(edit.replaceRange.start))
                        + edit.newText
                        + document.getText().slice(document.offsetAt(edit.replaceRange.end));
                    assert.strictEqual(textAfterEdit, 'keep();');
                }
            } finally {
                workflow.dispose();
            }
        });
    }
});
