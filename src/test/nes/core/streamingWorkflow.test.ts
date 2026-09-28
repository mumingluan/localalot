import * as assert from 'assert';
import * as vscode from 'vscode';
import { NesWorkflow } from '../../../completions/nes/core/nesWorkflow';
import { NextEditCache } from '../../../completions/nes/nextEditCache';
import { DocumentId } from '../../../completions/nes/stubs/types';

suite('NES streamed first edit', () => {
    test('keeps a complete empty marked deletion inside model formatting', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const obsolete = 1;',
        });
        const adapter = {
            async send() {
                return {
                    text: '<think>remove obsolete code</think>\n```ts\n###remain edit start boundary line###\n###remain edit end boundary line###\n```',
                    finishReason: 'stop',
                };
            },
        };
        const workflow = new NesWorkflow(
            {
                enabled: true, endpoint: 'chat/completions', baseUrl: '', apiKey: '',
                model: 'test', family: 'standard', maxOutputTokens: 256, stream: false,
                presencePenalty: 0, frequencyPenalty: 0,
                capabilities: { supports: { thinking: false, reasoning_effort: '' } },
                suffixOverlapThreshold: 1, suffixOverlapType: 'high',
            } as never,
            { getAdapter: () => adapter } as never,
            { info() {}, debug() {}, error() {} } as never,
            new NextEditCache(),
        );
        (workflow as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];
        try {
            const result = await workflow.execute(document, new vscode.Position(0, 10), false);
            assert.ok(result.editResult?.edits.length);
            assert.strictEqual(result.editResult?.edit, '');
        } finally {
            workflow.dispose();
        }
    });

    test('uses complete text returned only at the end of a stream', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = 1;',
        });
        const response = '###remain edit start boundary line###\nconst value = 2;\n###remain edit end boundary line###';
        const adapter = {
            async *sendStream() {
                return { text: response, finishReason: 'stop' };
            },
        };
        const workflow = new NesWorkflow(
            {
                enabled: true, endpoint: 'chat/completions', baseUrl: '', apiKey: '',
                model: 'test', family: 'standard', maxOutputTokens: 256, stream: true,
                presencePenalty: 0, frequencyPenalty: 0,
                capabilities: { supports: { thinking: false, reasoning_effort: '' } },
                suffixOverlapThreshold: 1, suffixOverlapType: 'high',
            } as never,
            { getAdapter: () => adapter } as never,
            { info() {}, debug() {}, error() {} } as never,
            new NextEditCache(),
        );
        (workflow as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];
        try {
            const result = await workflow.execute(document, new vscode.Position(0, 14), false);
            assert.strictEqual(result.editResult?.edit, '2');
        } finally {
            workflow.dispose();
        }
    });

    test('discards unmarked text when a stream ends without a terminal response', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = 1;',
        });
        const cache = new NextEditCache();
        const adapter = {
            async *sendStream() {
                yield 'const value = 2;';
                // Some compatible gateways close the stream without a final
                // choice or finish reason after a transport failure.
            },
        };
        const workflow = new NesWorkflow(
            {
                enabled: true, endpoint: 'chat/completions', baseUrl: '', apiKey: '',
                model: 'test', family: 'standard', maxOutputTokens: 256, stream: true,
                presencePenalty: 0, frequencyPenalty: 0,
                capabilities: { supports: { thinking: false, reasoning_effort: '' } },
                suffixOverlapThreshold: 1, suffixOverlapType: 'high',
            } as never,
            { getAdapter: () => adapter } as never,
            { info() {}, debug() {}, error() {} } as never,
            cache,
        );
        (workflow as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];
        try {
            const position = new vscode.Position(0, 14);
            assert.strictEqual((await workflow.execute(document, position, false)).editResult, undefined);
            assert.strictEqual(cache.lookupNextEdit(DocumentId.create(document.uri.toString()),
                document, position), undefined);
        } finally {
            workflow.dispose();
        }
    });

    test('does not apply an unmarked response truncated at the output limit', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = 1;',
        });
        const adapter = {
            async send() { return { text: 'const value = 2;', finishReason: 'length' }; },
            async *sendStream() {
                yield 'const value = 2;';
                return { text: 'const value = 2;', finishReason: 'max_output_tokens' };
            },
        };
        const config = {
            enabled: true, endpoint: 'chat/completions', baseUrl: '', apiKey: '', model: 'test', family: 'standard',
            maxOutputTokens: 256, stream: false, presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { supports: { thinking: false, reasoning_effort: '' } },
            suffixOverlapThreshold: 1, suffixOverlapType: 'high',
        };
        const workflow = new NesWorkflow(
            config as never, { getAdapter: () => adapter } as never,
            { info() {}, debug() {}, error() {} } as never, new NextEditCache(),
        );
        (workflow as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];
        try {
            assert.strictEqual((await workflow.execute(document, new vscode.Position(0, 14), false)).editResult, undefined);
            config.stream = true;
            assert.strictEqual((await workflow.execute(document, new vscode.Position(0, 14), false)).editResult, undefined);
        } finally {
            workflow.dispose();
        }
    });

    test('uses a complete response when NES streaming is disabled', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = 1;',
        });
        let sent = 0;
        const adapter = {
            async send(request: { stream?: boolean }) {
                sent++;
                assert.strictEqual(request.stream, false);
                return {
                    text: '###remain edit start boundary line###\nconst value = 2;\n###remain edit end boundary line###',
                    finishReason: 'stop',
                };
            },
            sendStream(): never { throw new Error('streaming endpoint was called'); },
        };
        const config = {
            enabled: true, endpoint: 'chat/completions', baseUrl: '', apiKey: '', model: 'test', family: 'standard',
            maxOutputTokens: 256, stream: false, presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { supports: { thinking: false, reasoning_effort: '' } },
            suffixOverlapThreshold: 1, suffixOverlapType: 'high',
        };
        const workflow = new NesWorkflow(
            config as never, { getAdapter: () => adapter } as never,
            { info() {}, debug() {}, error() {} } as never, new NextEditCache(),
        );
        (workflow as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];
        try {
            const result = await workflow.execute(document, new vscode.Position(0, 14), false);
            assert.strictEqual(sent, 1);
            assert.strictEqual(result.editResult?.edit, '2');
        } finally {
            workflow.dispose();
        }
    });

    test('uses the model window clamp in the actual edit request', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = 1;',
        });
        let requestMaxTokens: number | undefined;
        const adapter = {
            async *sendStream(request: { max_tokens: number }) {
                requestMaxTokens = request.max_tokens;
                yield '###remain edit start boundary line###\nconst value = 2;\n###remain edit end boundary line###';
                return { text: '' };
            },
        };
        const config = {
            enabled: true, endpoint: 'chat/completions', baseUrl: '', apiKey: '', model: 'test', family: 'standard',
            maxOutputTokens: 9_216, stream: true, presencePenalty: 0, frequencyPenalty: 0,
            capabilities: {
                limits: { max_context_window_tokens: 4_096 },
                supports: { thinking: false, reasoning_effort: '' },
            },
            suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
        };
        const workflow = new NesWorkflow(
            config as never, { getAdapter: () => adapter } as never,
            { info() {}, debug() {}, error() {} } as never, new NextEditCache(),
        );
        (workflow as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];
        try {
            const result = await workflow.execute(document, new vscode.Position(0, 14), false);
            assert.strictEqual(requestMaxTokens, 2_048);
            assert.ok(result.editResult?.edits.length);
        } finally {
            workflow.dispose();
        }
    });

    test('stops the background stream when the workflow is disposed after its first edit', async () => {
        const source = ['before();', 'call();', 'after();'].join('\n');
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: source });
        let notifyAbort!: () => void;
        const aborted = new Promise<void>(resolve => { notifyAbort = resolve; });
        const adapter = {
            async *sendStream(_request: unknown, signal: AbortSignal) {
                yield '###remain edit start boundary line###\nbefore();\ncall(extra);\n';
                await new Promise<void>(resolve => {
                    if (signal.aborted) resolve();
                    else signal.addEventListener('abort', () => resolve(), { once: true });
                });
                notifyAbort();
                return { text: '' };
            },
        };
        const config = {
            enabled: true, endpoint: 'chat/completions', baseUrl: '', apiKey: '', model: 'test', family: 'standard',
            maxOutputTokens: 256, stream: true, presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { supports: { thinking: false, reasoning_effort: '' } },
            suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
        };
        const workflow = new NesWorkflow(
            config as never, { getAdapter: () => adapter } as never,
            { info() {}, debug() {}, error() {} } as never, new NextEditCache(),
        );
        const internals = workflow as unknown as {
            _semanticContext: { collect: () => Promise<[]> };
            _promptAssembler: { assemble: () => unknown };
        };
        internals._semanticContext.collect = async () => [];
        internals._promptAssembler.assemble = () => ({
            promptPieces: {}, systemPrompt: 'edit code', userPrompt: 'edit code',
            editWindowLines: source.split('\n'), editWindowRange: { start: 0, endExclusive: 3 },
        });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const first = await workflow.execute(document, new vscode.Position(1, 0), true);
            assert.strictEqual(first.editResult?.edit, 'extra');
            workflow.dispose();
            await Promise.race([
                aborted,
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => reject(new Error('background stream was not canceled')), 2000);
                }),
            ]);
        } finally {
            if (timeout) clearTimeout(timeout);
            workflow.dispose();
        }
    });

    test('shows an additive cursor-line edit before an anchor arrives', async () => {
        const source = ['before();', 'call();', 'after();'].join('\n');
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: source });
        let releaseTail!: () => void;
        const tailGate = new Promise<void>(resolve => { releaseTail = resolve; });
        const adapter = {
            async *sendStream() {
                yield '###remain edit start boundary line###\nbefore();\ncall(extra);\n';
                await tailGate;
                yield 'after();\n###remain edit end boundary line###';
                return { text: '' };
            },
        };
        const config = {
            enabled: true, endpoint: 'chat/completions', baseUrl: '', apiKey: '', model: 'test', family: 'standard',
            maxOutputTokens: 256, stream: true, presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { supports: { thinking: false, reasoning_effort: '' } },
            suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
        };
        const workflow = new NesWorkflow(
            config as never, { getAdapter: () => adapter } as never,
            { info() {}, debug() {}, error() {} } as never, new NextEditCache(),
        );
        const internals = workflow as unknown as {
            _semanticContext: { collect: () => Promise<[]> };
            _promptAssembler: { assemble: () => unknown };
        };
        internals._semanticContext.collect = async () => [];
        internals._promptAssembler.assemble = () => ({
            promptPieces: {}, systemPrompt: 'edit code', userPrompt: 'edit code',
            editWindowLines: source.split('\n'), editWindowRange: { start: 0, endExclusive: 3 },
        });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([
                workflow.execute(document, new vscode.Position(1, 0), true),
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => reject(new Error('additive cursor edit waited for tail')), 2000);
                }),
            ]);
            assert.strictEqual(result.editResult?.edit, 'extra');
            assert.strictEqual(result.editResult?.range.start.line, 1);
        } finally {
            if (timeout) clearTimeout(timeout);
            releaseTail();
            workflow.dispose();
        }
    });

    test('does not turn an early cursor-line replacement into a deletion', async () => {
        const source = 'call();\ncall(extra);';
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: source });
        let releaseTail!: () => void;
        const tailGate = new Promise<void>(resolve => { releaseTail = resolve; });
        const adapter = {
            async *sendStream() {
                yield '###remain edit start boundary line###\ncall(extra);\n';
                await tailGate;
                yield '###remain edit end boundary line###';
                return { text: '', finishReason: 'stop' };
            },
        };
        const workflow = new NesWorkflow(
            {
                enabled: true, endpoint: 'chat/completions', baseUrl: '', apiKey: '',
                model: 'test', family: 'standard', maxOutputTokens: 256, stream: true,
                presencePenalty: 0, frequencyPenalty: 0,
                capabilities: { supports: { thinking: false, reasoning_effort: '' } },
                suffixOverlapThreshold: 1, suffixOverlapType: 'high',
            } as never,
            { getAdapter: () => adapter } as never,
            { info() {}, debug() {}, error() {} } as never,
            new NextEditCache(),
        );
        const internals = workflow as unknown as {
            _semanticContext: { collect: () => Promise<[]> };
            _promptAssembler: { assemble: () => unknown };
        };
        internals._semanticContext.collect = async () => [];
        internals._promptAssembler.assemble = () => ({
            promptPieces: {}, systemPrompt: 'edit code', userPrompt: 'edit code',
            editWindowLines: ['call();'], editWindowRange: { start: 0, endExclusive: 1 },
        });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([
                workflow.execute(document, new vscode.Position(0, 0), false),
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => reject(new Error('early edit waited for the full response')), 2000);
                }),
            ]);
            const edit = result.editResult;
            assert.ok(edit);
            assert.strictEqual(edit.edits.length, 1);
            const accepted = source.slice(0, document.offsetAt(edit.range.start)) + edit.edit
                + source.slice(document.offsetAt(edit.range.end));
            assert.strictEqual(accepted, 'call(extra);\ncall(extra);');
        } finally {
            if (timeout) clearTimeout(timeout);
            releaseTail();
            workflow.dispose();
        }
    });

    test('shows a converged edit before the end marker and keeps reading later edits', async () => {
        const source = ['keep();', 'old();', 'anchor();', 'late();', 'more();'].join('\n');
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: source });
        const position = new vscode.Position(1, 0);
        let releaseTail!: () => void;
        const tailGate = new Promise<void>(resolve => { releaseTail = resolve; });
        const adapter = {
            async *sendStream() {
                yield '###remain edit start boundary line###\nkeep();\nnew();\nanchor();\n';
                await tailGate;
                yield 'late2();\nmore();\n###remain edit end boundary line###';
                return { text: '' };
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
        const cache = new NextEditCache();
        let notifyFullCache!: () => void;
        const fullCached = new Promise<void>(resolve => { notifyFullCache = resolve; });
        const originalSet = cache.setKthNextEdit.bind(cache);
        cache.setKthNextEdit = (docId, entry) => {
            originalSet(docId, entry);
            if (entry.documentBeforeEdit === source && entry.edit.includes('late2();')) notifyFullCache();
        };
        const log = { info() {}, debug() {}, error() {} };
        const workflow = new NesWorkflow(
            config as never,
            { getAdapter: () => adapter } as never,
            log as never,
            cache,
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
            editWindowLines: source.split('\n'),
            editWindowRange: { start: 0, endExclusive: 5 },
        });
        const bounded = async <T>(promise: Promise<T>): Promise<T> => {
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
                return await Promise.race([
                    promise,
                    new Promise<never>((_, reject) => {
                        timeout = setTimeout(() => reject(new Error('NES stream did not advance')), 2000);
                    }),
                ]);
            } finally {
                if (timeout) clearTimeout(timeout);
            }
        };
        try {
            const first = await bounded(workflow.execute(document, position, true));
            assert.ok(first.editResult);
            assert.strictEqual(first.editResult.range.start.line, 1);
            assert.strictEqual(first.editResult.edit, 'new');

            releaseTail();
            await bounded(fullCached);
            const docId = DocumentId.create(document.uri.toString());
            assert.ok(cache.lookupNextEdit(docId, document, position)?.edit.includes('late2();'));
            const start = document.offsetAt(first.editResult.range.start);
            const end = document.offsetAt(first.editResult.range.end);
            const afterFirst = source.slice(0, start) + first.editResult.edit + source.slice(end);
            assert.ok(cache.lookupNextEdit(docId, { getText: () => afterFirst }, { line: 1 })?.edit.includes('late2();'));
            first.editResult.cacheEntry!.rejected = true;
            assert.strictEqual(cache.lookupNextEdit(docId, document, position), undefined);
        } finally {
            releaseTail();
            workflow.dispose();
        }
    });

    test('stages a later edit before the response ends after the first edit is accepted', async () => {
        const source = ['keep();', 'old();', 'anchor();', 'late();', 'more();'].join('\n');
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: source });
        let releaseTail!: () => void;
        const tailGate = new Promise<void>(resolve => { releaseTail = resolve; });
        let releaseEnd!: () => void;
        const endGate = new Promise<void>(resolve => { releaseEnd = resolve; });
        const adapter = {
            async *sendStream() {
                yield '###remain edit start boundary line###\nkeep();\nnew();\nanchor();\n';
                await tailGate;
                yield 'late2();\nmore();\n';
                await endGate;
                yield '###remain edit end boundary line###';
                return { text: '' };
            },
        };
        const config = {
            enabled: true, endpoint: 'chat/completions', baseUrl: '', apiKey: '', model: 'test', family: 'standard',
            maxOutputTokens: 256, stream: true, presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { supports: { thinking: false, reasoning_effort: '' } },
            suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
        };
        const cache = new NextEditCache();
        let notifyFollowing!: () => void;
        const followingCached = new Promise<void>(resolve => { notifyFollowing = resolve; });
        let acceptedText = '';
        const originalSet = cache.setKthNextEdit.bind(cache);
        cache.setKthNextEdit = (docId, entry) => {
            originalSet(docId, entry);
            if (entry.documentBeforeEdit === acceptedText && entry.edit.includes('late2();')) notifyFollowing();
        };
        const workflow = new NesWorkflow(
            config as never, { getAdapter: () => adapter } as never,
            { info() {}, debug() {}, error() {} } as never, cache,
        );
        const internals = workflow as unknown as {
            _semanticContext: { collect: () => Promise<[]> };
            _promptAssembler: { assemble: () => unknown };
        };
        internals._semanticContext.collect = async () => [];
        internals._promptAssembler.assemble = () => ({
            promptPieces: {}, systemPrompt: 'edit code', userPrompt: 'edit code',
            editWindowLines: source.split('\n'), editWindowRange: { start: 0, endExclusive: 5 },
        });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const first = await Promise.race([
                workflow.execute(document, new vscode.Position(1, 0), true),
                new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('first edit waited for tail')), 2000); }),
            ]);
            assert.ok(first.editResult);
            assert.strictEqual(first.editResult.edit, 'new');
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, first.editResult.range, first.editResult.edit);
            assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
            acceptedText = document.getText();
            assert.notStrictEqual(acceptedText, source);

            releaseTail();
            await Promise.race([
                followingCached,
                new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('following edit was not staged')), 2000); }),
            ]);
            const docId = DocumentId.create(document.uri.toString());
            assert.ok(cache.lookupNextEdit(docId, document, new vscode.Position(1, 0))?.edit.includes('late2();'));
        } finally {
            if (timeout) clearTimeout(timeout);
            releaseTail();
            releaseEnd();
            workflow.dispose();
        }
    });
});
