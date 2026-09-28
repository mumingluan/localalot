import * as assert from 'assert';
import * as vscode from 'vscode';
import { GhostTextComputer, buildVirtualGhostContext, ghostRelevantSourcesStable, ghostRequestScope, isDuplicateOfNextNonEmptyLine, mergeGhostRelatedFiles, selectGhostDiagnostics } from '../../completions/ghost/ghostTextComputer';
import { noteGhostDiagnosticsChanged } from '../../completions/ghost/diagnosticRevision';
import { DefaultMultilineStrategy } from '../../completions/ghost/multiline/DefaultMultilineStrategy';
import { trimCompletion } from '../../completions/ghost/blockTrimmer';
import { CurrentGhostText, LastGhostText } from '../../completions/ghost/ghostTextState';
import { GhostCompletionsCache } from '../../completions/ghost/completionsCache';
import { AsyncCompletionsManager } from '../../completions/ghost/asyncCompletions';
import { GhostPromptFactory } from '../../completions/ghost/promptFactory';
import { countO200kTokens, countPromptTokens } from '../../completions/nes/core/promptTokenizer';

suite('Ghost diagnostic context', () => {
    test('skips prompt and network work when the endpoint is unconfigured', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = ' });
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            { enabled: true, endpointConfigured: false } as never,
            new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => { throw new Error('network should not start'); } } as never,
            new AsyncCompletionsManager(), { info() {}, debug() {}, error() {} } as never,
            { determineMultiline: async () => { throw new Error('prompt should not be built'); } } as never,
        );
        assert.strictEqual(await computer.getGhostText(document, new vscode.Position(0, 14)), undefined);
    });

    test('includes nearby errors below the cursor and omits hints and distant diagnostics', () => {
        const diagnostic = (line: number, severity: vscode.DiagnosticSeverity, message: string) => {
            const item = new vscode.Diagnostic(new vscode.Range(line, 0, line, 1), message, severity);
            return item;
        };
        const selected = selectGhostDiagnostics([
            diagnostic(1, vscode.DiagnosticSeverity.Error, 'distant'),
            diagnostic(11, vscode.DiagnosticSeverity.Warning, 'below'),
            diagnostic(9, vscode.DiagnosticSeverity.Error, 'above'),
            diagnostic(10, vscode.DiagnosticSeverity.Hint, 'hint'),
            diagnostic(12, vscode.DiagnosticSeverity.Information, 'information'),
        ], 10, 2);
        assert.deepStrictEqual(selected.map(item => item.message), ['above', 'below']);
        assert.deepStrictEqual(selected.map(item => item.severity), ['error', 'warning']);
    });

    test('preserves diagnostic column, source, and code for the prompt', () => {
        const diagnostic = new vscode.Diagnostic(new vscode.Range(3, 7, 3, 10), 'Unknown name',
            vscode.DiagnosticSeverity.Error);
        diagnostic.source = 'ts';
        diagnostic.code = 2304;
        assert.deepStrictEqual(selectGhostDiagnostics([diagnostic], 3), [{
            line: 4, column: 8, severity: 'error', code: '2304', source: 'ts', message: 'Unknown name',
        }]);
    });
});

suite('Ghost related-file context', () => {
    test('keeps a distant lexical region from a file with a semantic definition', () => {
        const uri = 'file:///workspace/helper.ts';
        const related = mergeGhostRelatedFiles([{
            uri, relativePath: 'helper.ts', snippet: 'export interface Helper {}',
            lineRange: { startLine: 0, endLineExclusive: 1 }, score: 10,
        }], [{
            uri, path: 'helper.ts', snippet: 'related code (501)\nfunction useHelper() {}',
            startLine: 500, endLineExclusive: 501,
        }]);
        assert.strictEqual(related.length, 2);
        assert.ok(related[1].snippet.includes('useHelper'));
    });

    test('omits overlapping lexical source while preserving facts from the same file', () => {
        const uri = 'file:///workspace/helper.ts';
        const related = mergeGhostRelatedFiles([{
            uri, relativePath: 'helper.ts', snippet: 'function useHelper() {}',
            lineRange: { startLine: 500, endLineExclusive: 501 }, score: 10,
        }, {
            uri, relativePath: 'helper.ts', snippet: 'signature: useHelper(): void',
            lineRange: { startLine: 500, endLineExclusive: 501 }, score: 10, kind: 'facts',
        }], [{
            uri, path: 'helper.ts', snippet: 'related code (501)\nfunction useHelper() {}',
            startLine: 500, endLineExclusive: 501,
        }]);
        assert.strictEqual(related.length, 2);
        assert.ok(related.some(item => item.snippet.startsWith('signature:')));
    });
});

suite('YAML ghost completion request', () => {
    test('cache scope tracks open documents, language, and diagnostic changes', () => {
        const document = { uri: vscode.Uri.file('/workspace/main.ts'), version: 1, languageId: 'typescript' };
        const otherDocuments = Array.from({ length: 17 }, (_, index) => ({
            uri: vscode.Uri.file(`/workspace/helper${index}.ts`), version: 1, languageId: 'typescript',
        }));
        const config = {
            revision: 0, model: 'test', baseUrl: '', endpoint: 'completions' as const,
            promptTemplate: '{prefix}{suffix}', contextPlacement: 'prefix' as const,
        };
        const firstScope = ghostRequestScope(document, config, [document, ...otherDocuments]);
        assert.strictEqual(ghostRequestScope(document, config,
            [...otherDocuments].reverse().concat(document)), firstScope);
        const originalScope = JSON.parse(firstScope);
        assert.strictEqual(originalScope[1], 'typescript');
        assert.ok(originalScope.at(-1).some((entry: unknown[]) => entry[0] === otherDocuments[0].uri.toString()));
        assert.notStrictEqual(ghostRequestScope(document, config, [document,
            { ...otherDocuments[0], version: 2 }, ...otherDocuments.slice(1)]), firstScope);
        assert.notStrictEqual(ghostRequestScope({ ...document, languageId: 'javascript' }, config,
            [document, ...otherDocuments]), firstScope);
        const withNewDocument = ghostRequestScope(document, config, [document, ...otherDocuments,
            { uri: vscode.Uri.file('/workspace/new.ts'), version: 1, languageId: 'typescript' }]);
        assert.strictEqual(ghostRelevantSourcesStable(firstScope, withNewDocument, new Set()), true);
        const changedOlderDocument = ghostRequestScope(document, config, [document,
            { ...otherDocuments[0], version: 2 }, ...otherDocuments.slice(1)]);
        assert.strictEqual(ghostRelevantSourcesStable(firstScope, changedOlderDocument,
            new Set([otherDocuments[0].uri.toString()])), false);
        assert.strictEqual(ghostRelevantSourcesStable(firstScope, changedOlderDocument, new Set()), true);
        noteGhostDiagnosticsChanged(document.uri.toString());
        const changedDiagnostics = ghostRequestScope(document, config, [document, ...otherDocuments]);
        assert.notStrictEqual(changedDiagnostics, firstScope);
        assert.strictEqual(ghostRelevantSourcesStable(firstScope, changedDiagnostics, new Set()), false);
        const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 4), 'missing symbol');
        noteGhostDiagnosticsChanged(document.uri.toString(), [diagnostic]);
        const withDiagnostic = ghostRequestScope(document, config, [document, ...otherDocuments]);
        noteGhostDiagnosticsChanged(document.uri.toString(), [diagnostic]);
        assert.strictEqual(ghostRequestScope(document, config, [document, ...otherDocuments]), withDiagnostic);
        diagnostic.message = 'different symbol';
        noteGhostDiagnosticsChanged(document.uri.toString(), [diagnostic]);
        assert.notStrictEqual(ghostRequestScope(document, config, [document, ...otherDocuments]), withDiagnostic);
    });

    test('separates reopened document objects with the same URI and version', () => {
        const source = {
            uri: vscode.Uri.file('/workspace/reopened.ts'), version: 1,
            languageId: 'typescript', getText: () => 'value',
        };
        const neighbor = {
            uri: vscode.Uri.file('/workspace/dependency.ts'), version: 1,
            languageId: 'typescript', getText: () => 'helper',
        };
        const config = {
            revision: 0, model: 'test', baseUrl: '', endpoint: 'completions' as const,
            promptTemplate: '{prefix}{suffix}', contextPlacement: 'prefix' as const,
        };
        const scope = ghostRequestScope(source, config, [source, neighbor]);
        assert.notStrictEqual(ghostRequestScope({ ...source }, config, [neighbor]), scope);
        const reopenedNeighborScope = ghostRequestScope(source, config, [source, { ...neighbor }]);
        assert.notStrictEqual(reopenedNeighborScope, scope);
        assert.strictEqual(ghostRelevantSourcesStable(scope, reopenedNeighborScope,
            new Set([neighbor.uri.toString()])), false);
    });

    test('requests a fresh candidate when a reused result duplicates the next line', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = \n42;',
        });
        const config = {
            enabled: true, revision: 0, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
        };
        let networkCalls = 0;
        let waitCalls = 0;
        let queuedResult: Promise<{ completionText: string; finishReason: string }> | undefined;
        const asyncManager = {
            shouldWaitForAsyncCompletions: () => true,
            async getFirstMatchingRequest() {
                if (++waitCalls === 1) return { completionText: '42;', finishReason: 'stop' };
                return queuedResult;
            },
            queueCompletionRequest(
                _id: string, _prefix: string, _suffix: string, _cts: unknown,
                result: Promise<{ completionText: string; finishReason: string }>,
            ) {
                queuedResult = result;
                return result.then(() => undefined);
            },
            hasActiveWaiters: () => false,
        };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => ({ async send() {
                networkCalls++;
                return { text: '43;', finishReason: 'stop' };
            } }) } as never,
            asyncManager as never, { info() {}, debug() {}, error() {} } as never,
            { determineMultiline: async () => false } as never,
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        const result = await computer.getGhostText(document, new vscode.Position(0, 14));
        assert.strictEqual(result?.completions[0].completionText, '43;');
        assert.strictEqual(networkCalls, 1);
        assert.strictEqual(waitCalls, 2);
    });

    test('respects current single-line mode when reusing a multiline cached choice', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = ' });
        let networkCalls = 0;
        const config = {
            enabled: true, revision: 0, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
        };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(),
            { findAll: () => [{ text: 'first\nsecond', finishReason: 'stop' }] } as never,
            { recentEdits: [] } as never,
            { getAdapter: () => { networkCalls++; throw new Error('cache should satisfy request'); } } as never,
            new AsyncCompletionsManager(), { info() {}, debug() {}, error() {} } as never,
            { determineMultiline: async () => false } as never,
        );
        const result = await computer.getGhostText(document, new vscode.Position(0, 14));
        assert.strictEqual(result?.completions[0].completionText, 'first');
        assert.strictEqual(networkCalls, 0);
    });

    test('samples distinct candidates when explicitly cycling', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = ' });
        const requests: Array<{ n?: number; temperature: number }> = [];
        const adapter = {
            async send(request: { n?: number; temperature: number }) {
                requests.push({ n: request.n, temperature: request.temperature });
                return {
                    text: 'first', finishReason: 'stop',
                    choices: [
                        { text: 'first', finishReason: 'stop' },
                        { text: 'second', finishReason: 'stop' },
                    ],
                };
            },
        };
        const config = {
            enabled: true, revision: 0, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
        };
        const log = { info() {}, debug() {}, error() {} };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => adapter } as never,
            new AsyncCompletionsManager(), log as never, new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        const result = await computer.getGhostText(document, new vscode.Position(0, 14), undefined, false, true);
        assert.deepStrictEqual(requests, [{ n: 3, temperature: 0.2 }]);
        assert.deepStrictEqual(result?.completions.map(choice => choice.completionText), ['first', 'second']);
    });

    test('keeps the first generated line after a leading newline in a single-line response', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = ' });
        let requestStops: string[] | undefined;
        const config = {
            enabled: true, revision: 0, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
        };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => ({ async send(request: { stop?: string[] }) {
                requestStops = request.stop;
                return { text: '\n    calculateTotal(order);\nignored();', finishReason: 'stop' };
            } }) } as never,
            new AsyncCompletionsManager(), { info() {}, debug() {}, error() {} } as never,
            new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        const result = await computer.getGhostText(document, new vscode.Position(0, 14));
        assert.deepStrictEqual(requestStops, ['\n\n\n', '\n```']);
        assert.strictEqual(result?.completions[0].completionText, '\n    calculateTotal(order);');
        assert.strictEqual(result?.completions[0].displayText, '\n    calculateTotal(order);');
    });

    test('discards a model response when a related open file changes during generation', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = ' });
        const related = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'export const helper = 1;' });
        let finishModel!: (result: { text: string; finishReason: string }) => void;
        const modelPending = new Promise<{ text: string; finishReason: string }>(resolve => { finishModel = resolve; });
        let modelStarted!: () => void;
        const started = new Promise<void>(resolve => { modelStarted = resolve; });
        let appended = 0;
        const config = {
            enabled: true, revision: 0, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
        };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(),
            { findAll: () => [], append: () => { appended++; } } as never,
            { recentEdits: [] } as never,
            { getAdapter: () => ({ send: () => { modelStarted(); return modelPending; } }) } as never,
            new AsyncCompletionsManager(), { info() {}, debug() {}, error() {} } as never,
            new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<unknown[]> } })
            ._semanticContext.collect = async () => [{
                uri: related.uri.toString(), relativePath: 'helper.ts', snippet: 'export const helper = 1;',
                lineRange: { startLine: 0, endLineExclusive: 1 }, score: 10,
            }];

        const pending = computer.getGhostText(document, new vscode.Position(0, 14), undefined, false, true);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([started, new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('model request did not start')), 1_000);
            })]);
            if (timer) clearTimeout(timer);
            const edit = new vscode.WorkspaceEdit();
            edit.insert(related.uri, new vscode.Position(0, 0), '// updated\n');
            assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
            finishModel({ text: 'stale answer', finishReason: 'stop' });
            assert.strictEqual(await pending, undefined);
            assert.strictEqual(appended, 0);
        } finally {
            if (timer) clearTimeout(timer);
            finishModel({ text: 'stale answer', finishReason: 'stop' });
        }
    });

    test('keeps a model response when an unrelated open file changes during generation', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = ' });
        const unrelated = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'unrelated' });
        let finishModel!: (result: { text: string; finishReason: string }) => void;
        const modelPending = new Promise<{ text: string; finishReason: string }>(resolve => { finishModel = resolve; });
        let modelStarted!: () => void;
        const started = new Promise<void>(resolve => { modelStarted = resolve; });
        const config = {
            enabled: true, revision: 0, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
        };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => ({ send: () => { modelStarted(); return modelPending; } }) } as never,
            new AsyncCompletionsManager(), { info() {}, debug() {}, error() {} } as never,
            new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        const pending = computer.getGhostText(document, new vscode.Position(0, 14), undefined, false, true);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([started, new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('model request did not start')), 1_000);
            })]);
            if (timer) clearTimeout(timer);
            const edit = new vscode.WorkspaceEdit();
            edit.insert(unrelated.uri, new vscode.Position(0, 0), 'changed ');
            assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
            finishModel({ text: 'answer', finishReason: 'stop' });
            assert.strictEqual((await pending)?.completions[0].completionText, 'answer');
        } finally {
            if (timer) clearTimeout(timer);
            finishModel({ text: 'answer', finishReason: 'stop' });
        }
    });

    test('keeps a completion when semantic lookup opens a new definition file', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = ' });
        let modelCalls = 0;
        const scopes: string[] = [];
        const config = {
            enabled: true, revision: 0, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
        };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(),
            { findAll: () => [], append: (_prefix: string, _suffix: string, _choice: unknown, scope: string) => {
                scopes.push(scope);
            } } as never,
            { recentEdits: [] } as never,
            { getAdapter: () => ({ async send() { modelCalls++; return { text: 'answer', finishReason: 'stop' }; } }) } as never,
            new AsyncCompletionsManager(), { info() {}, debug() {}, error() {} } as never,
            new DefaultMultilineStrategy(),
        );
        let definition: vscode.TextDocument | undefined;
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => {
                definition = await vscode.workspace.openTextDocument({
                    language: 'typescript', content: 'export const helper = 1;',
                });
                return [];
            };

        const result = await computer.getGhostText(document, new vscode.Position(0, 14), undefined, false, true);
        assert.strictEqual(result?.completions[0].completionText, 'answer');
        assert.strictEqual(modelCalls, 1);
        assert.strictEqual(scopes.length, 1);
        assert.ok((JSON.parse(scopes[0]).at(-1) as Array<[string]>).some(entry => entry[0] === definition?.uri.toString()));
    });

    test('stops a canceled cycling request without caching its late choices', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'services:\n  web:' });
        let finishModel!: (result: { text: string; finishReason: string }) => void;
        const modelPending = new Promise<{ text: string; finishReason: string }>(resolve => { finishModel = resolve; });
        let modelStarted!: () => void;
        const started = new Promise<void>(resolve => { modelStarted = resolve; });
        let appended = 0;
        const adapter = { send: () => { modelStarted(); return modelPending; } };
        const config = {
            enabled: true, revision: 0, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
        };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(),
            { findAll: () => [], append: () => { appended++; } } as never,
            { recentEdits: [] } as never,
            { getAdapter: () => adapter } as never,
            new AsyncCompletionsManager(), { info() {}, debug() {}, error() {} } as never,
            new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];
        const cancellation = new vscode.CancellationTokenSource();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const pending = computer.getGhostText(document, new vscode.Position(1, 6), cancellation.token, false, true);
            await Promise.race([
                started,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error('cycling request did not start')), 500);
                }),
            ]);
            if (timer) clearTimeout(timer);
            cancellation.cancel();
            assert.strictEqual(await Promise.race([
                pending,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error('canceled cycling request kept waiting')), 500);
                }),
            ]), undefined);
            finishModel({ text: 'late choice', finishReason: 'stop' });
            await new Promise(resolve => setTimeout(resolve, 0));
            assert.strictEqual(appended, 0);
        } finally {
            if (timer) clearTimeout(timer);
            finishModel({ text: 'late choice', finishReason: 'stop' });
            cancellation.dispose();
        }
    });

    test('next_indent follows the next non-blank line, not the current key', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'yaml',
            content: 'services:\n  web:\n    environment:\n\n  worker:\n    image: redis',
        });
        const computer = Object.create(GhostTextComputer.prototype) as {
            _nextIndent(document: vscode.TextDocument, position: vscode.Position): number;
        };
        assert.strictEqual(computer._nextIndent(document, new vscode.Position(2, 16)), 2);
        assert.strictEqual(computer._nextIndent(document, new vscode.Position(4, 9)), 4);
        assert.strictEqual(computer._nextIndent(document, new vscode.Position(5, 16)), 0);
    });

    test('keeps the visible candidate first and adds cached alternatives while typing', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'shared prefix' });
        const cache = new GhostCompletionsCache();
        let calls = 0;
        const adapter = {
            async send() {
                calls++;
                return { text: 'variant', finishReason: 'stop' };
            },
        };
        const config = {
            enabled: true, revision: 0, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
        };
        const log = { info() {}, debug() {}, error() {} };
        const current = new CurrentGhostText();
        const computer = new GhostTextComputer(
            current, new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), cache,
            { recentEdits: [] } as never,
            { getAdapter: () => adapter } as never,
            new AsyncCompletionsManager(), log as never, new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        assert.strictEqual((await computer.getGhostText(document, new vscode.Position(0, 13)))?.completions[0].completionText, 'variant');
        const scope = (current as unknown as { _scope: string })._scope;
        cache.append('shared prefix', '', { text: 'value', finishReason: 'stop' }, scope);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(0, 13), 'v');
        assert.strictEqual(await vscode.workspace.applyEdit(edit), true);

        const result = await computer.getGhostText(document, new vscode.Position(0, 14));
        assert.deepStrictEqual(result?.completions.map(choice => choice.completionText), ['ariant', 'alue']);
        assert.deepStrictEqual(result?.completions.map(choice => choice.completionIndex), [0, 1]);
        assert.strictEqual(calls, 1);
    });

    test('does not reuse a completion across documents or configuration revisions', async () => {
        const firstDocument = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'shared prefix' });
        const secondDocument = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'shared prefix' });
        const generated = [' first', ' second', ' related', ' updated'];
        let calls = 0;
        const adapter = {
            async send() {
                return { text: generated[calls++], finishReason: 'stop' };
            },
        };
        const config = {
            enabled: true, revision: 0, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
        };
        const log = { info() {}, debug() {}, error() {} };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => adapter } as never,
            new AsyncCompletionsManager(), log as never, new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        const position = new vscode.Position(0, 13);
        assert.strictEqual((await computer.getGhostText(firstDocument, position))?.completions[0].completionText, ' first');
        assert.strictEqual((await computer.getGhostText(secondDocument, position))?.completions[0].completionText, ' second');
        const edit = new vscode.WorkspaceEdit();
        edit.insert(firstDocument.uri, new vscode.Position(0, 13), ' changed');
        assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
        assert.strictEqual((await computer.getGhostText(secondDocument, position))?.completions[0].completionText, ' related');
        config.revision++;
        assert.strictEqual((await computer.getGhostText(secondDocument, position))?.completions[0].completionText, ' updated');
        assert.strictEqual(calls, 4);
    });

    test('keeps same-line closers when a single-line request receives multiline output', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'if () {\n    existing();\n}',
        });
        const adapter = {
            async send() {
                return { text: 'ready) {\n    run();\n}', finishReason: 'stop' };
            },
        };
        const config = {
            enabled: true, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            suffixOverlapThreshold: 0.6, suffixOverlapType: 'low',
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
        };
        const log = { info() {}, debug() {}, error() {} };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => adapter } as never,
            new AsyncCompletionsManager(), log as never, new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        const result = await computer.getGhostText(document, new vscode.Position(0, 4));
        assert.ok(result?.completions[0]);
        assert.strictEqual(result.completions[0].completionText, 'ready) {');
        assert.strictEqual(result.completions[0].suffixCoverage, 3);
    });

    test('sends context through the selected transport on both completion endpoints', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'useHelper(',
        });
        for (const endpoint of ['completions', 'fim/completions'] as const) {
            for (const contextPlacement of ['extra', 'prefix'] as const) {
                let sentRequest: { prompt: string; suffix?: string; context?: string[]; extra?: Record<string, unknown> } | undefined;
                const adapter = {
                    async send(request: { prompt: string; suffix?: string; context?: string[] }) {
                        sentRequest = request;
                        return { text: 'value)', finishReason: 'stop' };
                    },
                };
                const config = {
                    enabled: true, model: 'test', baseUrl: '', apiKey: '', endpoint,
                    contextPlacement, maxOutputTokens: 256, delay: 0, stops: [], stream: false,
                    promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
                    presencePenalty: 0, frequencyPenalty: 0,
                    suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
                    capabilities: { limits: { max_context_window_tokens: 128_000 } },
                };
                const log = { info() {}, debug() {}, error() {} };
                const computer = new GhostTextComputer(
                    new CurrentGhostText(), new LastGhostText(), {} as never,
                    config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
                    { recentEdits: ['+ export function helper() {}'] } as never,
                    { getAdapter: () => adapter } as never,
                    new AsyncCompletionsManager(), log as never, new DefaultMultilineStrategy(),
                );
                (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
                    ._semanticContext.collect = async () => [];

                await computer.getGhostText(document, new vscode.Position(0, 10));
                assert.ok(sentRequest);
                if (contextPlacement === 'extra') {
                    assert.strictEqual(sentRequest.extra?.language, 'typescript');
                    assert.strictEqual(sentRequest.extra?.trim_by_indentation, false);
                    assert.ok((sentRequest.extra?.prompt_tokens as number) > 0);
                    assert.ok(sentRequest.context?.[0].includes('export function helper'));
                    assert.ok(!sentRequest.prompt.includes('<copilot-context>'));
                } else {
                    assert.strictEqual(sentRequest.extra, undefined);
                    assert.strictEqual(sentRequest.context, undefined);
                    assert.ok(sentRequest.prompt.includes('export function helper'));
                    assert.ok(sentRequest.prompt.includes('// </copilot-context>\n\nuseHelper('));
                }
                if (endpoint === 'completions') {
                    assert.ok(sentRequest.prompt.startsWith('<|fim_prefix|>'));
                    assert.ok(sentRequest.prompt.endsWith('<|fim_suffix|><|fim_middle|>'));
                    assert.strictEqual(sentRequest.suffix, undefined);
                } else {
                    assert.ok(sentRequest.prompt.endsWith('useHelper('));
                    assert.strictEqual(sentRequest.suffix, '');
                }
            }
        }
    });

    test('reuses empty context space for a long source prefix', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'x'.repeat(2_000) });
        let sentRequest: { prompt: string; context?: string[] } | undefined;
        const adapter = {
            async send(request: { prompt: string; context?: string[] }) {
                sentRequest = request;
                return { text: 'y', finishReason: 'stop' };
            },
        };
        const config = {
            enabled: true, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: ['\n'], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
            capabilities: { limits: { max_context_window_tokens: 1_024 } },
        };
        const log = { info() {}, debug() {}, error() {} };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => adapter } as never,
            new AsyncCompletionsManager(), log as never, new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        await computer.getGhostText(document, new vscode.Position(0, 2_000));
        assert.ok(sentRequest);
        const modelPrefix = sentRequest.prompt.slice(
            '<|fim_prefix|>'.length, sentRequest.prompt.indexOf('<|fim_suffix|>'),
        );
        const contextLength = sentRequest.context?.[0]?.length ?? 0;
        assert.ok(modelPrefix.length + contextLength > 512);
        assert.ok(modelPrefix.length + contextLength <= 2_748);
        assert.ok(modelPrefix.endsWith('x'.repeat(100)));
    });

    test('sends more existing suffix when the source prefix is short', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'plaintext', content: 'head\n' + 'z'.repeat(1_000),
        });
        let sentPrompt = '';
        const adapter = {
            async send(request: { prompt: string }) {
                sentPrompt = request.prompt;
                return { text: 'next', finishReason: 'stop' };
            },
        };
        const config = {
            enabled: true, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
            capabilities: { limits: { max_context_window_tokens: 1_024 } },
        };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => adapter } as never,
            new AsyncCompletionsManager(), { info() {}, debug() {}, error() {} } as never,
            new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        await computer.getGhostText(document, new vscode.Position(0, 4));
        const suffix = sentPrompt.split('<|fim_suffix|>')[1]?.split('<|fim_middle|>')[0];
        assert.ok(suffix?.startsWith('\n'));
        assert.ok(suffix.length > 300, `suffix length=${suffix?.length}`);
        assert.ok(sentPrompt.startsWith('<|fim_prefix|>head<|fim_suffix|>'));
    });

    test('keeps a GPT YAML FIM request within the exact token window', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'yaml',
            content: '配置项:' + Array(100).fill('\n  服务: nginx').join(''),
        });
        let sentRequest: {
            prompt: string;
            context?: string[];
            stop?: string[];
            extra?: { prompt_tokens: number; suffix_tokens: number };
        } | undefined;
        const adapter = { async send(request: typeof sentRequest) {
            sentRequest = request;
            return { text: '\n  image: nginx', finishReason: 'stop' };
        } };
        const config = {
            enabled: true, model: 'gpt-4o', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 128, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { limits: { max_context_window_tokens: 1_200 } },
        };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => adapter } as never,
            new AsyncCompletionsManager(), { info() {}, debug() {}, error() {} } as never,
            new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        await computer.getGhostText(document, new vscode.Position(0, 4));
        assert.ok(sentRequest);
        const context = sentRequest.context?.[0] ?? '';
        const modelPrefix = sentRequest.prompt.split('<|fim_prefix|>')[1]?.split('<|fim_suffix|>')[0] ?? '';
        const modelSuffix = sentRequest.prompt.split('<|fim_suffix|>')[1]?.split('<|fim_middle|>')[0] ?? '';
        assert.ok(modelSuffix.startsWith('\n'));
        assert.ok(countO200kTokens(modelSuffix) > 60);
        assert.ok(countO200kTokens(sentRequest.prompt) + countO200kTokens(context) <= 976);
        assert.strictEqual(sentRequest.extra?.prompt_tokens,
            countO200kTokens(modelPrefix) + countO200kTokens(context));
        assert.strictEqual(sentRequest.extra?.suffix_tokens, countO200kTokens(modelSuffix));
        assert.strictEqual(sentRequest.stop, undefined);
    });

    test('caps output and input together for a small completion model', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const result = calculateTotal(invoice);',
        });
        let sentRequest: { prompt: string; context?: string[]; max_tokens: number } | undefined;
        const adapter = { async send(request: typeof sentRequest) {
            sentRequest = request;
            return { text: '\nnext();', finishReason: 'stop' };
        } };
        const config = {
            enabled: true, model: 'gpt-4o', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 4_096, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { limits: { max_context_window_tokens: 1_024 } },
        };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => adapter } as never,
            new AsyncCompletionsManager(), { info() {}, debug() {}, error() {} } as never,
            new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        await computer.getGhostText(document, new vscode.Position(0, document.lineAt(0).text.length));
        assert.ok(sentRequest);
        const inputTokens = countO200kTokens(sentRequest.prompt)
            + countO200kTokens(sentRequest.context?.[0] ?? '');
        assert.ok(sentRequest.max_tokens <= 461);
        assert.ok(inputTokens + sentRequest.max_tokens <= 1_024 - 81);
    });

    test('uses the native prompt ceiling for a long file on a large model', async () => {
        const source = Array(2_000).fill('const filler = calculateValue();').join('\n')
            + '\nconst target = compute(';
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: source });
        let sentRequest: { prompt: string; context?: string[]; max_tokens: number } | undefined;
        const adapter = { async send(request: typeof sentRequest) {
            sentRequest = request;
            return { text: 'value)', finishReason: 'stop' };
        } };
        const config = {
            enabled: true, model: 'gpt-4o', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 500, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
        };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => adapter } as never,
            new AsyncCompletionsManager(), { info() {}, debug() {}, error() {} } as never,
            new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        await computer.getGhostText(document, document.lineAt(document.lineCount - 1).range.end);
        assert.ok(sentRequest);
        const promptTokens = countO200kTokens(sentRequest.prompt)
            + countO200kTokens(sentRequest.context?.[0] ?? '');
        assert.ok(promptTokens <= 7_692, `prompt used ${promptTokens} tokens`);
        assert.ok(sentRequest.prompt.includes('const target = compute('));
        assert.ok(!sentRequest.prompt.includes('[...]'));
    });

    test('keeps the cursor tail when estimating a Unicode prompt for a local model', async () => {
        const source = Array(150).fill('配置项 = 计算服务费用(账单)\n').join('') + '返回最终配置项';
        const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: source });
        let sentRequest: { prompt: string; context?: string[]; max_tokens: number } | undefined;
        const adapter = { async send(request: typeof sentRequest) {
            sentRequest = request;
            return { text: '完成', finishReason: 'stop' };
        } };
        const config = {
            enabled: true, model: 'local-code', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { limits: { max_context_window_tokens: 1_024 } },
        };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => adapter } as never,
            new AsyncCompletionsManager(), { info() {}, debug() {}, error() {} } as never,
            new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        await computer.getGhostText(document, document.lineAt(document.lineCount - 1).range.end);
        assert.ok(sentRequest);
        const inputTokens = countPromptTokens(sentRequest.prompt, undefined)
            + countPromptTokens(sentRequest.context?.[0] ?? '', undefined);
        assert.ok(inputTokens + sentRequest.max_tokens <= 1_024 - 81);
        assert.ok(sentRequest.prompt.includes('返回最终配置项'));
    });

    test('a first-token newline remains visible after a mapping key', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'services:\n  web:\n  worker:' });
        let sentRequest: { prompt: string; max_tokens: number; stop?: string[]; extra?: { trim_by_indentation?: boolean } } | undefined;
        const modelText = '\n    image: nginx';
        const adapter = {
            async send(request: { prompt: string; max_tokens: number; stop?: string[]; extra?: { trim_by_indentation?: boolean } }) {
                sentRequest = request;
                return { text: modelText, finishReason: 'stop' };
            },
        };
        const config = {
            enabled: true, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: ['\n'], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
        };
        const log = { info() {}, debug() {}, error() {} };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => adapter } as never,
            new AsyncCompletionsManager(), log as never, new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        const result = await computer.getGhostText(document, new vscode.Position(1, 6));
        assert.ok(sentRequest);
        assert.strictEqual(sentRequest.max_tokens, 256);
        assert.strictEqual(sentRequest.stop, undefined);
        assert.strictEqual(sentRequest.extra?.trim_by_indentation, true);
        assert.strictEqual(sentRequest.prompt,
            '<|fim_prefix|>services:\n  web:<|fim_suffix|>\n  worker:<|fim_middle|>');
        assert.strictEqual(result?.completions[0].completionText, modelText);
    });

    test('uses the detected YAML language for a template file in plaintext mode', async () => {
        const source = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'services:\n  web:' });
        const fileUri = vscode.Uri.file('C:/project/docker-compose.yml.njk');
        const document = {
            uri: fileUri, languageId: 'plaintext', version: source.version, lineCount: source.lineCount,
            getText: (range?: vscode.Range) => source.getText(range),
            lineAt: (line: number) => source.lineAt(line),
            offsetAt: (position: vscode.Position) => source.offsetAt(position),
            positionAt: (offset: number) => source.positionAt(offset),
        } as vscode.TextDocument;
        let request: { stop?: string[]; context?: string[]; extra?: { language?: string; trim_by_indentation?: boolean } } | undefined;
        const config = {
            enabled: true, revision: 0, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: ['\n'], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
        };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => ({ async send(value: typeof request) {
                request = value;
                return { text: '\n    image: nginx', finishReason: 'stop' };
            } }) } as never,
            new AsyncCompletionsManager(), { info() {}, debug() {}, error() {} } as never,
            new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        const result = await computer.getGhostText(document, new vscode.Position(1, 6));
        assert.strictEqual(request?.extra?.language, 'yaml');
        assert.strictEqual(request?.extra?.trim_by_indentation, true);
        assert.strictEqual(request?.stop, undefined);
        assert.ok(request?.context?.[0].includes('# language: yaml'));
        assert.strictEqual(result?.completions[0].completionText, '\n    image: nginx');
    });

    test('trims only a whitespace-only final prompt line before a model request', async () => {
        const prompts: string[] = [];
        const adapter = {
            async send(request: { prompt: string }) {
                prompts.push(request.prompt);
                return { text: 'value', finishReason: 'stop' };
            },
        };
        const config = {
            enabled: true, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
        };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => adapter } as never,
            new AsyncCompletionsManager(), { info() {}, debug() {}, error() {} } as never,
            new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        const yaml = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'services:\n  web:\n    ' });
        await computer.getGhostText(yaml, new vscode.Position(2, 4));
        assert.ok(prompts[0].startsWith('<|fim_prefix|>services:\n  web:\n<|fim_suffix|>'), prompts[0]);

        const code = 'const x =  ';
        const typescript = await vscode.workspace.openTextDocument({ language: 'typescript', content: code });
        await computer.getGhostText(typescript, new vscode.Position(0, code.length));
        assert.ok(prompts[1].startsWith(`<|fim_prefix|>${code}<|fim_suffix|>`), prompts[1]);
    });

    test('separates existing trailing spaces from the model text for display', async () => {
        const source = 'const result =  ';
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: source });
        const adapter = { async send() { return { text: '  compute()', finishReason: 'stop' }; } };
        const config = {
            enabled: true, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
        };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => adapter } as never,
            new AsyncCompletionsManager(), { info() {}, debug() {}, error() {} } as never,
            new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];
        const result = await computer.getGhostText(document, new vscode.Position(0, source.length));
        assert.strictEqual(result?.completions[0].completionText, '  compute()');
        assert.strictEqual(result.completions[0].displayText, 'compute()');
        assert.strictEqual(result.completions[0].displayNeedsWsOffset, false);
    });

    test('selected IntelliSense insertion supplies its trailing space to display adjustment', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'run(hel);' });
        let requestPrompt = '';
        let requestTokens = 0;
        let requestStops: string[] | undefined;
        const adapter = { async send(request: { prompt: string; max_tokens: number; stop?: string[] }) {
            requestPrompt = request.prompt;
            requestTokens = request.max_tokens;
            requestStops = request.stop;
            return { text: ' value);', finishReason: 'stop' };
        } };
        const config = {
            enabled: true, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
        };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => adapter } as never,
            new AsyncCompletionsManager(), { info() {}, debug() {}, error() {} } as never,
            new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];
        const selected: vscode.SelectedCompletionInfo = {
            range: new vscode.Range(0, 4, 0, 7), text: 'helper ',
        };
        const result = await computer.getGhostText(document, new vscode.Position(0, 7),
            undefined, false, false, selected);
        assert.ok(requestPrompt.includes('run(helper <|fim_suffix|>);'));
        assert.strictEqual(requestTokens, 256);
        assert.deepStrictEqual(requestStops, ['\n\n\n', '\n```']);
        assert.strictEqual(result?.completions[0].displayText, 'value);');
        assert.strictEqual(result?.completions[0].suffixCoverage, 2);
    });

    test('canceled editor request exits while its model result remains reusable', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'services:\n  web:' });
        let finishModel!: (result: { text: string; finishReason: string }) => void;
        const modelPending = new Promise<{ text: string; finishReason: string }>(resolve => { finishModel = resolve; });
        let modelStarted!: () => void;
        const started = new Promise<void>(resolve => { modelStarted = resolve; });
        const adapter = { send: () => { modelStarted(); return modelPending; } };
        const config = {
            enabled: true, revision: 0, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
        };
        const manager = new AsyncCompletionsManager();
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => adapter } as never,
            manager, { info() {}, debug() {}, error() {} } as never, new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];
        const cancellation = new vscode.CancellationTokenSource();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const first = computer.getGhostText(document, new vscode.Position(1, 6), cancellation.token);
            await Promise.race([
                started,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error('ghost model request did not start')), 500);
                }),
            ]);
            if (timer) clearTimeout(timer);
            cancellation.cancel();
            assert.strictEqual(await Promise.race([
                first,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error('canceled ghost request kept waiting')), 500);
                }),
            ]), undefined);
            assert.strictEqual(manager.hasActiveWaiters(), false);
            finishModel({ text: '\n    image: nginx', finishReason: 'stop' });
            await new Promise(resolve => setTimeout(resolve, 0));
            const next = await computer.getGhostText(document, new vscode.Position(1, 6));
            assert.strictEqual(next?.completions[0].completionText, '\n    image: nginx');
        } finally {
            if (timer) clearTimeout(timer);
            finishModel({ text: '\n    image: nginx', finishReason: 'stop' });
            cancellation.dispose();
        }
    });

    test('feeds streaming partial text into pending-request matching', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'services:\n  web:' });
        const partials: string[] = [];
        const asyncManager = new AsyncCompletionsManager();
        const originalUpdate = asyncManager.updateCompletion.bind(asyncManager);
        asyncManager.updateCompletion = (id, text) => {
            partials.push(text);
            originalUpdate(id, text);
        };
        const adapter = {
            async send(): Promise<never> { throw new Error('streaming request used send()'); },
            async *sendStream(request: { stream?: boolean }) {
                assert.strictEqual(request.stream, true);
                yield '\n    image:';
                yield ' nginx';
                return { text: '\n    image: nginx', finishReason: 'stop' };
            },
        };
        const config = {
            enabled: true, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: true,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
        };
        const log = { info() {}, debug() {}, error() {} };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => adapter } as never,
            asyncManager, log as never, new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        const result = await computer.getGhostText(document, new vscode.Position(1, 6));
        assert.deepStrictEqual(partials, ['\n    image:', '\n    image: nginx']);
        assert.strictEqual(result?.completions[0].completionText, '\n    image: nginx');
    });

    test('closes a streamed single-line request once its display line is complete', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'if () {\n    existing();\n}',
        });
        let produced = 0;
        let closed = false;
        const adapter = {
            async send(): Promise<never> { throw new Error('streaming request used send()'); },
            async *sendStream() {
                try {
                    produced++; yield 'ready) {';
                    produced++; yield '\n';
                    produced++; yield 'ignored();';
                    return { text: 'ready) {\nignored();', finishReason: 'stop' };
                } finally {
                    closed = true;
                }
            },
        };
        const config = {
            enabled: true, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: true,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
        };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => adapter } as never,
            new AsyncCompletionsManager(), { info() {}, debug() {}, error() {} } as never,
            new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        const result = await computer.getGhostText(document, new vscode.Position(0, 4));
        assert.strictEqual(result?.completions[0].completionText, 'ready) {');
        assert.strictEqual(produced, 2);
        assert.strictEqual(closed, true);
    });

    test('starts the model request when semantic context exceeds its deadline', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'services:\n  web:' });
        let releaseSemantic!: (value: []) => void;
        const semanticPending = new Promise<[]>(resolve => { releaseSemantic = resolve; });
        let semanticToken: vscode.CancellationToken | undefined;
        let requested = false;
        const adapter = {
            async send() {
                requested = true;
                return { text: '\n    image: nginx', finishReason: 'stop' };
            },
        };
        const config = {
            enabled: true, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
        };
        const log = { info() {}, debug() {}, error() {} };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => adapter } as never,
            new AsyncCompletionsManager(), log as never, new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: (
            document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken,
        ) => Promise<[]> } })
            ._semanticContext.collect = (_document, _position, token) => {
                semanticToken = token;
                return semanticPending;
            };

        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([
                computer.getGhostText(document, new vscode.Position(1, 6)),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error('semantic context blocked the network request')), 800);
                }),
            ]);
            assert.strictEqual(requested, true);
            assert.strictEqual(result?.completions[0].completionText, '\n    image: nginx');
            assert.strictEqual(semanticToken?.isCancellationRequested, true);
        } finally {
            if (timer) clearTimeout(timer);
            releaseSemantic([]);
        }
    });

    test('cancels semantic lookup immediately when the editor request is canceled', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'helper(' });
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            {} as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            {} as never, new AsyncCompletionsManager(),
            { info() {}, debug() {}, error() {} } as never, new DefaultMultilineStrategy(),
        );
        let semanticToken: vscode.CancellationToken | undefined;
        (computer as unknown as { _semanticContext: { collect: (
            document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken,
        ) => Promise<[]> } })._semanticContext.collect = (_document, _position, token) => {
            semanticToken = token;
            return new Promise<[]>(() => {});
        };
        const parent = new vscode.CancellationTokenSource();
        try {
            const pending = (computer as unknown as { _collectSemanticContextWithin: (
                document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken,
            ) => Promise<[]> })._collectSemanticContextWithin(document, new vscode.Position(0, 7), parent.token);
            parent.cancel();
            const started = Date.now();
            assert.deepStrictEqual(await pending, []);
            assert.ok(Date.now() - started < 100, 'canceled request waited for the semantic deadline');
            assert.strictEqual(semanticToken?.isCancellationRequested, true);
        } finally {
            parent.dispose();
        }
    });

    test('includes semantic facts that finish within the ghost deadline', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'helper(' });
        let sentContext = '';
        const adapter = {
            async send(request: { context?: string[] }) {
                sentContext = request.context?.[0] ?? '';
                return { text: 'value)', finishReason: 'stop' };
            },
        };
        const config = {
            enabled: true, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false, contextPlacement: 'extra',
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
        };
        const log = { info() {}, debug() {}, error() {} };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => adapter } as never,
            new AsyncCompletionsManager(), log as never, new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<Array<{ uri: string; relativePath: string; snippet: string }>> } })
            ._semanticContext.collect = async () => [{
                uri: document.uri.toString(), relativePath: 'src/helper.ts', snippet: 'function helper(value: string): void',
            }];
        const result = await computer.getGhostText(document, new vscode.Position(0, 7));
        assert.ok(result?.completions.length);
        assert.ok(sentContext.includes('function helper(value: string): void'));
    });

    test('generates after a selected item replaces trailing code', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = oldName.tail',
        });
        const selected: vscode.SelectedCompletionInfo = {
            range: new vscode.Range(0, 14, 0, document.lineAt(0).text.length),
            text: 'newName',
        };
        let sentPrompt = '';
        const adapter = {
            async send(request: { prompt: string }) {
                sentPrompt = request.prompt;
                return { text: '.length', finishReason: 'stop' };
            },
        };
        const config = {
            enabled: true, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: ['\n'], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
            suffixOverlapThreshold: 0.95, suffixOverlapType: 'high',
            capabilities: { limits: { max_context_window_tokens: 128_000 } },
        };
        const log = { info() {}, debug() {}, error() {} };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => adapter } as never,
            new AsyncCompletionsManager(), log as never, new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        const result = await computer.getGhostText(document, new vscode.Position(0, 17), undefined, false, false, selected);
        assert.ok(sentPrompt.includes('<|fim_prefix|>const value = newName<|fim_suffix|>'));
        assert.strictEqual(result?.completions[0].completionText, '.length');
    });
});

suite('Ghost virtual follow-up context', () => {
    test('keeps the normal block budget after an accepted completion in a parser-detected block', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'python', content: 'def run():\n    ',
        });
        const requests: Array<{ max_tokens: number; stop?: string[]; extra?: { trim_by_indentation: boolean } }> = [];
        const config = {
            enabled: true, revision: 0, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
        };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => ({ async send(request: typeof requests[number]) {
                requests.push(request);
                return { text: 'pass', finishReason: 'stop' };
            } }) } as never,
            new AsyncCompletionsManager(), { info() {}, debug() {}, error() {} } as never,
            { determineMultiline: async () => true } as never,
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        await computer.getGhostText(document, new vscode.Position(1, 4), undefined, false, false, undefined, {
            range: new vscode.Range(1, 4, 1, 4), text: 'if ready:\n        ',
        });
        assert.strictEqual(requests.length, 1);
        assert.strictEqual(requests[0].max_tokens, 256);
        assert.strictEqual(requests[0].stop, undefined);
        assert.strictEqual(requests[0].extra?.trim_by_indentation, true);
    });

    test('requests the progressive multiline budget after accepting a TypeScript completion', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'function run() {\n  ',
        });
        const requests: Array<{ max_tokens: number; stop?: string[]; extra?: { trim_by_indentation: boolean } }> = [];
        const config = {
            enabled: true, revision: 0, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
        };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => ({ async send(request: typeof requests[number]) {
                requests.push(request);
                return { text: 'work();', finishReason: 'stop' };
            } }) } as never,
            new AsyncCompletionsManager(), { info() {}, debug() {}, error() {} } as never,
            { determineMultiline: async () => false } as never,
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        await computer.getGhostText(document, new vscode.Position(1, 2), undefined, false, false, undefined, {
            range: new vscode.Range(1, 2, 1, 2), text: 'if (ready) {\n    ',
        });
        assert.strictEqual(requests.length, 1);
        assert.strictEqual(requests[0].max_tokens, 200);
        assert.strictEqual(requests[0].stop, undefined);
        assert.strictEqual(requests[0].extra?.trim_by_indentation, false);
    });

    test('uses the short accepted follow-up budget in a long TypeScript file', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = 1;\n'.repeat(7999) + 'function run() {\n  ',
        });
        const requests: Array<{ max_tokens: number; stop?: string[] }> = [];
        const config = {
            enabled: true, revision: 0, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions',
            maxOutputTokens: 256, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            presencePenalty: 0, frequencyPenalty: 0,
        };
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), new GhostCompletionsCache(),
            { recentEdits: [] } as never,
            { getAdapter: () => ({ async send(request: typeof requests[number]) {
                requests.push(request);
                return { text: 'work();\nnext();\nthird();', finishReason: 'stop' };
            } }) } as never,
            new AsyncCompletionsManager(), { info() {}, debug() {}, error() {} } as never,
            new DefaultMultilineStrategy(),
        );
        (computer as unknown as { _semanticContext: { collect: () => Promise<[]> } })
            ._semanticContext.collect = async () => [];

        const result = await computer.getGhostText(document, new vscode.Position(8000, 2), undefined, false, false, undefined, {
            range: new vscode.Range(8000, 2, 8000, 2), text: 'if (ready) {\n    ',
        });
        assert.strictEqual(requests.length, 1);
        assert.strictEqual(requests[0].max_tokens, 20);
        assert.deepStrictEqual(requests[0].stop, ['\n\n']);
        assert.strictEqual(result?.completions[0].completionText, 'work();\nnext();');
    });

    test('uses the inserted YAML block as the next FIM prefix', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'services:\n  web:\n  worker:' });
        const result = buildVirtualGhostContext(document, {
            range: new vscode.Range(1, 6, 1, 6),
            text: '\n    image: nginx',
        });
        assert.ok(result);
        assert.strictEqual(result.prefix, 'services:\n  web:\n    image: nginx');
        assert.strictEqual(result.suffix, '\n  worker:');
        assert.deepStrictEqual(result.position, new vscode.Position(2, 16));
        assert.strictEqual(result.document.lineAt(result.position.line).text, '    image: nginx');
        assert.strictEqual(result.document.lineAt(3).text, '  worker:');
        assert.strictEqual(result.document.offsetAt(result.position), result.document.getText().indexOf('\n  worker:'));
    });

    test('replaces the covered same-line suffix before prefetching', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'call(x);' });
        const result = buildVirtualGhostContext(document, {
            range: new vscode.Range(0, 5, 0, 6),
            text: 'value',
        });
        assert.ok(result);
        assert.strictEqual(result.prefix, 'call(value');
        assert.strictEqual(result.suffix, ');');
        assert.deepStrictEqual(result.position, new vscode.Position(0, 10));
        assert.strictEqual(result.document.lineAt(0).text, 'call(value);');
    });

    test('uses the virtual YAML key for multiline detection and trimming', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'services:\n  web:\n  worker:' });
        const result = buildVirtualGhostContext(document, {
            range: new vscode.Range(1, 6, 1, 6),
            text: '\n    environment:',
        });
        assert.ok(result);
        const multiline = await new DefaultMultilineStrategy().determineMultiline({
            document: result.document,
            position: result.position,
            prefix: result.prefix,
            suffix: result.suffix,
            languageId: 'yaml',
            isMiddleOfTheLine: false,
            afterAccept: false,
        });
        assert.strictEqual(multiline, true);
        assert.strictEqual(await trimCompletion(
            result.document, result.position, result.prefix,
            '\n      FOO: bar\n  worker: duplicate', multiline,
        ), '\n      FOO: bar');
    });

    test('keeps CRLF offsets and ranges aligned after a virtual edit', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'services:\r\n  web:\r\n  worker:' });
        const result = buildVirtualGhostContext(document, {
            range: new vscode.Range(1, 6, 1, 6),
            text: '\r\n    image: nginx',
        });
        assert.ok(result);
        assert.strictEqual(result.prefix, 'services:\n  web:\n    image: nginx');
        assert.strictEqual(result.suffix, '\n  worker:');
        assert.deepStrictEqual(result.position, new vscode.Position(2, 16));
        assert.strictEqual(result.document.offsetAt(result.position), 'services:\r\n  web:\r\n    image: nginx'.length);
        assert.strictEqual(result.document.getText(new vscode.Range(2, 4, 2, 9)), 'image');
        assert.deepStrictEqual(result.document.lineAt(2).rangeIncludingLineBreak.end, new vscode.Position(3, 0));
    });

    test('reuses a virtual follow-up cache entry after acceptance in a CRLF file', async () => {
        const before = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const x = 1;\r\nconsole.' });
        const virtual = buildVirtualGhostContext(before, {
            range: new vscode.Range(1, 8, 1, 8), text: 'log',
        });
        assert.ok(virtual);
        const after = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const x = 1;\r\nconsole.log' });
        assert.ok(after.getText().includes('\r\n'));
        const config = {
            enabled: true, revision: 0, model: 'test', baseUrl: '', apiKey: '', endpoint: 'completions' as const,
            maxOutputTokens: 500, delay: 0, stops: [], stream: false,
            promptTemplate: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            contextPlacement: 'prefix' as const,
            presencePenalty: 0, frequencyPenalty: 0,
        };
        const cache = new GhostCompletionsCache();
        cache.append(virtual.prefix, virtual.suffix, { text: '(x);', finishReason: 'stop' },
            ghostRequestScope(after, config, vscode.workspace.textDocuments));
        const computer = new GhostTextComputer(
            new CurrentGhostText(), new LastGhostText(), {} as never,
            config as never, new GhostPromptFactory(), cache,
            { recentEdits: [] } as never,
            { getAdapter: () => { throw new Error('the virtual prefetch should satisfy the real request'); } } as never,
            new AsyncCompletionsManager(), { info() {}, debug() {}, error() {} } as never,
            { determineMultiline: async () => false } as never,
        );
        const result = await computer.getGhostText(after, new vscode.Position(1, 11));
        assert.strictEqual(result?.completions[0].completionText, '(x);');
    });
});

suite('Ghost duplicate-line filtering', () => {
    test('keeps useful code before a repeated model tail', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'function run() {' });
        const computer = Object.create(GhostTextComputer.prototype) as GhostTextComputer;
        const process = computer as unknown as {
            _postProcessChoiceInContext(choice: { text: string; finishReason: string },
                document: vscode.TextDocument, position: vscode.Position): { text: string };
        };
        const result = process._postProcessChoiceInContext(
            { text: '\n  useful();\n' + Array(8).fill('  repeat();').join('\n'), finishReason: 'length' },
            document, new vscode.Position(0, 16),
        );
        assert.strictEqual(result.text, '\n  useful();');
    });

    test('reads only the first non-empty following line in a large document', () => {
        const computer = Object.create(GhostTextComputer.prototype) as {
            _matchesNextDocumentLine(text: string, document: vscode.TextDocument, position: vscode.Position): boolean;
        };
        let reads = 0;
        const document = {
            lineCount: 1_000_000,
            lineAt(line: number) {
                reads++;
                if (line === 1) return { text: '   ' };
                if (line === 2) return { text: 'render()' };
                throw new Error('read past first non-empty line');
            },
        } as vscode.TextDocument;
        assert.strictEqual(computer._matchesNextDocumentLine('render()', document, new vscode.Position(0, 0)), true);
        assert.strictEqual(reads, 2);
        assert.strictEqual(computer._matchesNextDocumentLine('render()\nmore()', document, new vscode.Position(0, 0)), false);
        assert.strictEqual(reads, 2);
    });

    test('compares only the first non-empty line after the cursor', () => {
        assert.strictEqual(isDuplicateOfNextNonEmptyLine('render()', ['', 'render()', '']), true);
    });

    test('does not scan past the first non-empty line', () => {
        assert.strictEqual(isDuplicateOfNextNonEmptyLine('render()', ['other()', '', 'render()']), false);
    });

    test('does not compare multiline completions as a single line', () => {
        assert.strictEqual(isDuplicateOfNextNonEmptyLine('render()\nreturn value', ['render()']), false);
    });

    test('preserves indentation when the native client block mode compares the next line', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'if (ready) {\nrender();',
        });
        const computer = Object.create(GhostTextComputer.prototype) as unknown as {
            _postProcessChoiceInContext(choice: { text: string; finishReason: string },
                document: vscode.TextDocument, position: vscode.Position, isMoreMultiline: boolean): { text: string };
        };
        const position = new vscode.Position(0, 12);
        const choice = { text: '    render();', finishReason: 'stop' };
        assert.strictEqual(computer._postProcessChoiceInContext(choice, document, position, true).text, '    render();');
        assert.strictEqual(computer._postProcessChoiceInContext(choice, document, position, false).text, '');
        assert.strictEqual(computer._postProcessChoiceInContext(
            { text: 'render();', finishReason: 'stop' }, document, position, true,
        ).text, '');
    });
});

suite('Ghost completion indentation', () => {
    test('filters a closing-only suggestion before an existing else block', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'if (ready) {\n} else {\n    fallback();\n}',
        });
        const computer = Object.create(GhostTextComputer.prototype) as GhostTextComputer;
        const process = computer as unknown as {
            _postProcessChoiceInContext(choice: { text: string; finishReason: string },
                document: vscode.TextDocument, position: vscode.Position): { text: string };
        };
        const result = process._postProcessChoiceInContext(
            { text: '\n}', finishReason: 'stop' }, document, new vscode.Position(0, 12),
        );
        assert.strictEqual(result.text, '');
    });

    test('snips a generated JSON closing brace already present with a comment', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'jsonc', content: '{\n  "foo": 1,\n} // existing close',
        });
        const computer = Object.create(GhostTextComputer.prototype) as GhostTextComputer;
        const process = computer as unknown as {
            _postProcessChoiceInContext(choice: { text: string; finishReason: string },
                document: vscode.TextDocument, position: vscode.Position): { text: string };
        };
        const result = process._postProcessChoiceInContext(
            { text: '\n  "bar": 2\n}', finishReason: 'stop' }, document, new vscode.Position(1, 11),
        );
        assert.strictEqual(result.text, '\n  "bar": 2');
    });

    test('snips an existing TypeScript closing line with trailing text', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const fn = () => {\n  work();\n}); // existing close',
        });
        const computer = Object.create(GhostTextComputer.prototype) as GhostTextComputer;
        const process = computer as unknown as {
            _postProcessChoiceInContext(choice: { text: string; finishReason: string },
                document: vscode.TextDocument, position: vscode.Position): { text: string };
        };
        const result = process._postProcessChoiceInContext(
            { text: '\n  extra();\n});', finishReason: 'stop' },
            document, new vscode.Position(1, 9),
        );
        assert.strictEqual(result.text, '\n  extra();');
    });

    test('snips an existing array closing bracket with trailing punctuation', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const values = [\n  first,\n];',
        });
        const computer = Object.create(GhostTextComputer.prototype) as GhostTextComputer;
        const process = computer as unknown as {
            _postProcessChoiceInContext(choice: { text: string; finishReason: string },
                document: vscode.TextDocument, position: vscode.Position): { text: string };
        };
        const result = process._postProcessChoiceInContext(
            { text: '\n  second,\n]', finishReason: 'stop' },
            document, new vscode.Position(1, 8),
        );
        assert.strictEqual(result.text, '\n  second,');
    });

    test('snips a final generated line that prefixes the next existing line', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'function run() {\n  first();\n  calculateTotal(order);',
        });
        const computer = Object.create(GhostTextComputer.prototype) as GhostTextComputer;
        const process = computer as unknown as {
            _postProcessChoiceInContext(choice: { text: string; finishReason: string },
                document: vscode.TextDocument, position: vscode.Position): { text: string };
        };
        const result = process._postProcessChoiceInContext(
            { text: '\n  second();\n  calculateTotal', finishReason: 'stop' },
            document, new vscode.Position(1, 10),
        );
        assert.strictEqual(result.text, '\n  second();');
    });

    test('keeps CRLF when snipping an existing final line', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'function run() {\r\n  first();\r\n  calculateTotal(order);',
        });
        const computer = Object.create(GhostTextComputer.prototype) as GhostTextComputer;
        const process = computer as unknown as {
            _postProcessChoiceInContext(choice: { text: string; finishReason: string },
                document: vscode.TextDocument, position: vscode.Position): { text: string };
        };
        const result = process._postProcessChoiceInContext(
            { text: '\r\n  second();\r\n  calculateTotal', finishReason: 'stop' },
            document, new vscode.Position(1, 10),
        );
        assert.strictEqual(result.text, '\r\n  second();');
    });

    test('keeps a closing line at a different indentation level', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'if (ready) {\n  work();\n    } // inner close',
        });
        const computer = Object.create(GhostTextComputer.prototype) as GhostTextComputer;
        const process = computer as unknown as {
            _postProcessChoiceInContext(choice: { text: string; finishReason: string },
                document: vscode.TextDocument, position: vscode.Position): { text: string };
        };
        const suggestion = '\n  extra();\n}';
        const result = process._postProcessChoiceInContext(
            { text: suggestion, finishReason: 'stop' },
            document, new vscode.Position(1, 9),
        );
        assert.strictEqual(result.text, suggestion);
    });

    test('preserves a generated else branch when the existing line only has a closing brace', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'if (ready) {\n}',
        });
        const computer = Object.create(GhostTextComputer.prototype) as GhostTextComputer;
        const process = computer as unknown as {
            _postProcessChoiceInContext(choice: { text: string; finishReason: string },
                document: vscode.TextDocument, position: vscode.Position): { text: string };
        };
        const suggestion = '\n    work();\n} else {';
        const result = process._postProcessChoiceInContext(
            { text: suggestion, finishReason: 'stop' }, document, new vscode.Position(0, 12),
        );
        assert.strictEqual(result.text, suggestion);
    });

    test('preserves useful code after a line copied from the following line', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'if (ready) {\nwork();',
        });
        const computer = Object.create(GhostTextComputer.prototype) as GhostTextComputer;
        const process = computer as unknown as {
            _postProcessChoiceInContext(choice: { text: string; finishReason: string },
                document: vscode.TextDocument, position: vscode.Position): { text: string };
        };
        const suggestion = '\nwork(); extra();';
        const result = process._postProcessChoiceInContext(
            { text: suggestion, finishReason: 'stop' }, document, new vscode.Position(0, 12),
        );
        assert.strictEqual(result.text, suggestion);
    });

    test('preserves dedented closing braces from the model', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'function run() {\n    if (ready) {\n        work();',
        });
        const computer = Object.create(GhostTextComputer.prototype) as GhostTextComputer;
        const process = computer as unknown as {
            _postProcessChoiceInContext(choice: { text: string; finishReason: string },
                document: vscode.TextDocument, position: vscode.Position): { text: string };
        };
        const result = process._postProcessChoiceInContext(
            { text: '\n    }\n}', finishReason: 'stop' }, document, new vscode.Position(2, 15),
        );
        assert.strictEqual(result.text, '\n    }\n}');
    });

    test('preserves a YAML sibling key after nested content', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'yaml', content: 'services:\n  web:\n    image: nginx',
        });
        const computer = Object.create(GhostTextComputer.prototype) as GhostTextComputer;
        const process = computer as unknown as {
            _postProcessChoiceInContext(choice: { text: string; finishReason: string },
                document: vscode.TextDocument, position: vscode.Position): { text: string };
        };
        const result = process._postProcessChoiceInContext(
            { text: '\n  worker:\n    image: redis', finishReason: 'stop' }, document, new vscode.Position(2, 16),
        );
        assert.strictEqual(result.text, '\n  worker:\n    image: redis');
    });
});

suite('_trimLineSuffixOverlap', () => {
    function trimLineSuffixOverlap(text: string, suffix: string): string {
        const computer = Object.create(GhostTextComputer.prototype) as GhostTextComputer;
        (computer as unknown as { _log: object })._log = { info() {} };
        return computer._trimLineSuffixOverlap(text, suffix);
    }

    test('no overlap — returns text unchanged', () => {
        const result = trimLineSuffixOverlap('line1\nline2\nline3', 'cursorTail\nother1\nother2');
        assert.strictEqual(result, 'line1\nline2\nline3');
    });

    test('partial overlap — trims overlapping lines', () => {
        const result = trimLineSuffixOverlap('hello\nworld\nfoo', 'cursorTail\nworld\nfoo\nbar');
        assert.strictEqual(result, 'hello');
    });

    test('keeps YAML keys at a different indentation level', () => {
        const generated = '\n    image: nginx\n    ports:';
        const suffix = '\n  image: nginx\n  ports:';
        assert.strictEqual(trimLineSuffixOverlap(generated, suffix), generated);
    });

    test('does not leave a dangling carriage return after trimming CRLF lines', () => {
        assert.strictEqual(
            trimLineSuffixOverlap('hello\r\nworld', 'cursorTail\nworld'),
            'hello',
        );
        assert.strictEqual(
            trimLineSuffixOverlap('\r\nhello\r\nworld', 'cursorTail\nworld'),
            '\r\nhello',
        );
    });

    test('keeps a meaningful replacement of similar text on the cursor line', () => {
        assert.strictEqual(
            trimLineSuffixOverlap('return value', 'return other'),
            'return value',
        );
        assert.strictEqual(
            trimLineSuffixOverlap('return value\n}', 'return other\n}'),
            'return value',
        );
    });

    test('keeps useful body when only a closing line repeats the suffix', () => {
        assert.strictEqual(
            trimLineSuffixOverlap('\n    return result;\n}', '\n}'),
            '\n    return result;',
        );
    });

    test('full overlap — returns empty string', () => {
        const result = trimLineSuffixOverlap('hello\nworld', 'cursorTail\nhello\nworld');
        assert.strictEqual(result, '');
    });

    test('empty input text — returns empty', () => {
        const result = trimLineSuffixOverlap('', 'suffix');
        assert.strictEqual(result, '');
    });

    test('empty suffix — returns text unchanged', () => {
        const result = trimLineSuffixOverlap('hello\nworld', '');
        assert.strictEqual(result, 'hello\nworld');
    });

    test('single line no overlap — unchanged', () => {
        const result = trimLineSuffixOverlap('hello', 'world');
        assert.strictEqual(result, 'hello');
    });

    test('does not remove a similar but different following line', () => {
        const result = trimLineSuffixOverlap('prefix\nmyFunction', 'cursorTail\nmyFuncion\nrest');
        assert.strictEqual(result, 'prefix\nmyFunction');
    });
});
