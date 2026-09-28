import * as assert from 'assert';
import * as vscode from 'vscode';
import { NextCursorPredictor, extractCursorPredictionText, parseCursorPrediction } from '../../../completions/nes/nextCursorPredictor';
import { PromptAssembler } from '../../../completions/nes/core/promptAssembler';
import { EditWindowResolver } from '../../../completions/nes/core/editWindowResolver';
import { countPromptTokens, ensurePromptTokenizerLoaded } from '../../../completions/nes/core/promptTokenizer';
import { DocumentId } from '../../../completions/nes/stubs/types';
import { StringText } from '../../../completions/nes/stubs/abstractText';
import { OffsetRange } from '../../../completions/nes/stubs/offsetRange';
import { renderCompletionPrompt } from '../../../completions/nes/promptCraftingUtils';
import { LLMError } from '../../../completions/shared/llm/llmRequest';

suite('NextCursorPredictor response parsing', () => {
    test('rejects a cursor coordinate cut off by the output limit', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = calculate();\nuse(value);',
        });
        const pieces = new PromptAssembler({} as never, new EditWindowResolver())
            .assemble(document, new vscode.Position(0, 14), false).promptPieces;
        const predictor = new NextCursorPredictor(
            {} as never,
            {
                nextCursorPredictionEnabled: true, endpoint: 'chat/completions', family: 'standard',
                model: 'test', baseUrl: '', apiKey: '', presencePenalty: 0, frequencyPenalty: 0,
                capabilities: { supports: { thinking: false, reasoning_effort: '' } },
            } as never,
            { getAdapter: () => ({ send: async () => ({ text: '1', finishReason: 'length' }) }) } as never,
            { debug() {}, info() {}, error() {} } as never,
        );
        const result = await predictor.predict(pieces);
        assert.ok(result.isError());
        assert.strictEqual(result.err, 'incompleteResponse');
    });

    test('recovers from a 404 after changing the cursor model configuration', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = calculate();\nuse(value);',
        });
        const pieces = new PromptAssembler({} as never, new EditWindowResolver())
            .assemble(document, new vscode.Position(0, 14), false).promptPieces;
        const config = {
            revision: 0, nextCursorPredictionEnabled: true,
            endpoint: 'chat/completions', family: 'standard', model: 'missing-model',
            baseUrl: '', apiKey: '', presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { supports: { thinking: false, reasoning_effort: '' } },
        };
        const predictor = new NextCursorPredictor(
            {} as never, config as never,
            { getAdapter: () => ({ send: async () => { throw new LLMError('model not found', 404); } }) } as never,
            { debug() {}, info() {}, error() {} } as never,
        );
        assert.ok((await predictor.predict(pieces)).isError());
        assert.strictEqual(predictor.isEnabled(), false);
        config.revision++;
        assert.strictEqual(predictor.isEnabled(), false);
        config.model = 'available-model';
        config.revision++;
        assert.strictEqual(predictor.isEnabled(), true);
    });

    test('does not disable cursor prediction for a non-404 error mentioning not found', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = calculate();\nuse(value);',
        });
        const pieces = new PromptAssembler({} as never, new EditWindowResolver())
            .assemble(document, new vscode.Position(0, 14), false).promptPieces;
        const predictor = new NextCursorPredictor(
            {} as never,
            {
                nextCursorPredictionEnabled: true, endpoint: 'chat/completions', family: 'standard',
                model: 'test', baseUrl: '', apiKey: '', presencePenalty: 0, frequencyPenalty: 0,
                capabilities: { supports: { thinking: false, reasoning_effort: '' } },
            } as never,
            { getAdapter: () => ({ send: async () => { throw new LLMError('gateway failed', 503, 'model not found in upstream log'); } }) } as never,
            { debug() {}, info() {}, error() {} } as never,
        );
        assert.ok((await predictor.predict(pieces)).isError());
        assert.strictEqual(predictor.isEnabled(), true);
    });

    test('discards a cursor answer after the model configuration changes', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = calculate();\nuse(value);',
        });
        const pieces = new PromptAssembler({} as never, new EditWindowResolver())
            .assemble(document, new vscode.Position(0, 14), false).promptPieces;
        const config = {
            revision: 0, nextCursorPredictionEnabled: true,
            endpoint: 'chat/completions', family: 'standard', model: 'old-model',
            baseUrl: '', apiKey: '', presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { supports: { thinking: false, reasoning_effort: '' } },
        };
        let resolveResponse!: (response: { text: string; finishReason: string }) => void;
        const pendingResponse = new Promise<{ text: string; finishReason: string }>(resolve => { resolveResponse = resolve; });
        let notifyStarted!: () => void;
        const started = new Promise<void>(resolve => { notifyStarted = resolve; });
        const predictor = new NextCursorPredictor(
            {} as never, config as never,
            { getAdapter: () => ({ send: () => { notifyStarted(); return pendingResponse; } }) } as never,
            { debug() {}, info() {}, error() {} } as never,
        );
        const resultPromise = predictor.predict(pieces);
        await started;
        config.revision++;
        resolveResponse({ text: '1', finishReason: 'stop' });
        const result = await resultPromise;
        assert.ok(result.isError());
        assert.strictEqual(result.err, 'aborted');
    });

    test('keeps the edit area and cursor in the location prompt', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = calculate();\nuse(value);',
        });
        const pieces = new PromptAssembler({} as never, new EditWindowResolver())
            .assemble(document, new vscode.Position(0, 14), false).promptPieces;
        const predictor = new NextCursorPredictor(
            {} as never, {} as never, {} as never,
            { debug() {}, info() {}, error() {} } as never,
        );

        const promptR = predictor.buildCursorPredictionPrompt(pieces);
        assert.ok(promptR.isOk());
        assert.ok(promptR.val.userMessage.includes('<|area_around_code_to_edit|>'));
        assert.ok(promptR.val.userMessage.includes('<|code_to_edit|>'));
        assert.ok(!promptR.val.userMessage.includes('###remain edit start boundary line###'));
        assert.ok(promptR.val.userMessage.includes('<|cursor|>'));
        assert.ok(promptR.val.userMessage.includes('calculate();'));
        assert.ok(!promptR.val.userMessage.includes('Examples: 15'));
        assert.ok(!promptR.val.userMessage.includes('please continue the developer'));
        assert.ok(promptR.val.keptRange.contains(0));
    });

    test('fits a small cursor model window while keeping the edit area', async () => {
        assert.strictEqual(await ensurePromptTokenizerLoaded(), true);
        const lines = Array.from({ length: 280 }, (_, index) =>
            `const generatedValue${index} = calculateTotal(order, ${index});`);
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: lines.join('\n') });
        const recentSource = Array.from({ length: 90 }, (_, index) =>
            `export const recentValue${index} = calculateTotal(order, ${index});`).join('\n');
        const history = [{
            kind: 'visibleRanges' as const,
            docId: DocumentId.create(vscode.Uri.file('/workspace/recent.ts').toString()),
            documentContent: new StringText(recentSource),
            visibleRanges: [new OffsetRange(0, recentSource.length)],
        }];
        const pieces = new PromptAssembler({} as never, new EditWindowResolver())
            .assemble(document, new vscode.Position(140, 25), false, history).promptPieces;
        const config = {
            endpoint: 'chat/completions', family: 'standard', model: 'small-model',
            maxOutputTokens: 512,
            capabilities: { limits: { max_context_window_tokens: 2_400 }, supports: { thinking: false, reasoning_effort: '' } },
        };
        const predictor = new NextCursorPredictor(
            {} as never, config as never, {} as never,
            { debug() {}, info() {}, error() {} } as never,
        );
        const promptR = predictor.buildCursorPredictionPrompt(pieces);
        assert.ok(promptR.isOk());
        const systemPrompt = (NextCursorPredictor as unknown as { NCP_SYSTEM_PROMPT: string }).NCP_SYSTEM_PROMPT;
        const inputTokens = countPromptTokens(`${systemPrompt}\n${promptR.val.userMessage}`, 'standard') + 32;
        assert.ok(inputTokens <= 2_400 - 40 - 128, `cursor prompt: ${inputTokens} tokens`);
        assert.ok(promptR.val.userMessage.includes('<|code_to_edit|>'));
        assert.ok(promptR.val.userMessage.includes('<|cursor|>'));
    });

    test('counts repeated user placeholders in a completion cursor request', async () => {
        const lines = Array.from({ length: 250 }, (_, index) =>
            `const generatedValue${index} = calculateTotal(order, ${index});`);
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: lines.join('\n') });
        const pieces = new PromptAssembler({} as never, new EditWindowResolver())
            .assemble(document, new vscode.Position(125, 25), false, []).promptPieces;
        const config = {
            endpoint: 'completions', family: 'standard', model: 'small-model', maxOutputTokens: 512,
            promptTemplate: 'SYSTEM:{system}\nUSER:{user}\nREPEAT:{user}',
            capabilities: { limits: { max_context_window_tokens: 4_500 }, supports: { thinking: false, reasoning_effort: '' } },
        };
        const predictor = new NextCursorPredictor(
            {} as never, config as never, {} as never,
            { debug() {}, info() {}, error() {} } as never,
        );
        const promptR = predictor.buildCursorPredictionPrompt(pieces);
        assert.ok(promptR.isOk(), promptR.isError() ? promptR.err : undefined);
        const systemPrompt = (NextCursorPredictor as unknown as { NCP_SYSTEM_PROMPT: string }).NCP_SYSTEM_PROMPT;
        const wirePrompt = renderCompletionPrompt(config.promptTemplate, systemPrompt, promptR.val.userMessage);
        assert.ok(countPromptTokens(wirePrompt, 'standard') <= 4_500 - 40 - 128);
        assert.ok(promptR.val.userMessage.includes('<|cursor|>'));
        assert.ok(promptR.val.userMessage.includes('<|code_to_edit|>'));
    });

    test('reduces current-file context for a tighter cursor model window', async () => {
        const lines = Array.from({ length: 320 }, (_, index) =>
            `const generatedValue${index} = calculateTotal(order, ${index});`);
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: lines.join('\n') });
        const pieces = new PromptAssembler({} as never, new EditWindowResolver())
            .assemble(document, new vscode.Position(160, 25), false, []).promptPieces;
        const predictor = new NextCursorPredictor(
            {} as never,
            {
                endpoint: 'chat/completions', family: 'standard', model: 'small-model', maxOutputTokens: 512,
                capabilities: { limits: { max_context_window_tokens: 1_600 }, supports: { thinking: false, reasoning_effort: '' } },
            } as never,
            {} as never, { debug() {}, info() {}, error() {} } as never,
        );
        const promptR = predictor.buildCursorPredictionPrompt(pieces);
        assert.ok(promptR.isOk(), promptR.isError() ? promptR.err : undefined);
        const systemPrompt = (NextCursorPredictor as unknown as { NCP_SYSTEM_PROMPT: string }).NCP_SYSTEM_PROMPT;
        const inputTokens = countPromptTokens(`${systemPrompt}\n${promptR.val.userMessage}`, 'standard') + 32;
        assert.ok(inputTokens <= 1_600 - 40 - 128, `cursor prompt: ${inputTokens} tokens`);
        assert.ok(promptR.val.userMessage.includes('<|code_to_edit|>'));
        assert.ok(promptR.val.userMessage.includes('<|cursor|>'));
    });

    test('bounds verbose diagnostics without losing the cursor location', async () => {
        const lines = Array.from({ length: 20 }, (_, index) => `const value${index} = ${index};`);
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: lines.join('\n') });
        const diagnostics = vscode.languages.createDiagnosticCollection('nes-cursor-budget');
        try {
            const verbose = Array.from({ length: 250 }, (_, index) => `problem${index} in module${index}`).join(' ');
            diagnostics.set(document.uri, Array.from({ length: 5 }, (_, index) =>
                new vscode.Diagnostic(
                    new vscode.Range(10 + index, 0, 10 + index, 5),
                    index === 0 ? 'fix the target variable' : verbose,
                    vscode.DiagnosticSeverity.Error,
                )));
            const pieces = new PromptAssembler({} as never, new EditWindowResolver())
                .assemble(document, new vscode.Position(10, 8), false).promptPieces;
            const predictor = new NextCursorPredictor(
                {} as never,
                {
                    endpoint: 'chat/completions', family: 'standard', model: 'small-model', maxOutputTokens: 512,
                    capabilities: { limits: { max_context_window_tokens: 1_600 }, supports: { thinking: false, reasoning_effort: '' } },
                } as never,
                {} as never, { debug() {}, info() {}, error() {} } as never,
            );
            const promptR = predictor.buildCursorPredictionPrompt(pieces);
            assert.ok(promptR.isOk(), promptR.isError() ? promptR.err : undefined);
            const systemPrompt = (NextCursorPredictor as unknown as { NCP_SYSTEM_PROMPT: string }).NCP_SYSTEM_PROMPT;
            const inputTokens = countPromptTokens(`${systemPrompt}\n${promptR.val.userMessage}`, 'standard') + 32;
            assert.ok(inputTokens <= 1_600 - 40 - 128, `cursor prompt: ${inputTokens} tokens`);
            assert.ok(promptR.val.userMessage.includes('<|cursor|>'));
            assert.ok(promptR.val.userMessage.includes('fix the target variable'));
        } finally {
            diagnostics.dispose();
        }
    });

    test('reuses collected semantic definitions when predicting a location', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const tax = calculateTax(invoice);',
        });
        const relatedUri = vscode.Uri.parse('file:///workspace/billing.ts').toString();
        const pieces = new PromptAssembler({} as never, new EditWindowResolver())
            .assemble(document, new vscode.Position(0, 15), false, [], [{
                uri: relatedUri, relativePath: 'billing.ts',
                snippet: 'export function calculateTax(invoice: Invoice) { return invoice.subtotal * invoice.rate; }',
                lineRange: { startLine: 120, endLineExclusive: 121 }, score: 15,
            }]).promptPieces;
        const predictor = new NextCursorPredictor(
            {} as never, {} as never, {} as never,
            { debug() {}, info() {}, error() {} } as never,
        );

        const promptR = predictor.buildCursorPredictionPrompt(pieces);
        assert.ok(promptR.isOk());
        assert.ok(promptR.val.userMessage.includes('code_snippet_file_path:'));
        assert.ok(promptR.val.userMessage.includes('export function calculateTax(invoice: Invoice)'));
    });

    test('uses the cursor-specific diagnostic severity policy in its prompt', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const left = 1;\nconst right = 2;',
        });
        const collection = vscode.languages.createDiagnosticCollection('nes-cursor-lint');
        try {
            collection.set(document.uri, [
                new vscode.Diagnostic(new vscode.Range(0, 0, 0, 5), 'warning for cursor', vscode.DiagnosticSeverity.Warning),
                new vscode.Diagnostic(new vscode.Range(1, 6, 1, 11), 'error for cursor', vscode.DiagnosticSeverity.Error),
            ]);
            const pieces = new PromptAssembler({} as never, new EditWindowResolver())
                .assemble(document, new vscode.Position(1, 8), false).promptPieces;
            const predictor = new NextCursorPredictor(
                {} as never, {} as never, {} as never,
                { debug() {}, info() {}, error() {} } as never,
            );
            const promptR = predictor.buildCursorPredictionPrompt(pieces);
            assert.ok(promptR.isOk());
            assert.ok(promptR.val.userMessage.includes('<|linter|>'));
            assert.ok(promptR.val.userMessage.includes('error for cursor'));
            assert.ok(!promptR.val.userMessage.includes('warning for cursor'));
        } finally {
            collection.dispose();
        }
    });

    test('a canceled request does not build a prompt or contact the endpoint', async () => {
        const cts = new vscode.CancellationTokenSource();
        cts.cancel();
        const predictor = new NextCursorPredictor(
            {} as never,
            {} as never,
            { getAdapter: () => { throw new Error('endpoint contacted'); } } as never,
            {} as never,
        );
        const result = await predictor.predict({} as never, cts.token);
        cts.dispose();
        assert.ok(result.isError());
        assert.strictEqual(result.err, 'aborted');
    });

    test('Anthropic cursor requests leave room for thinking and a visible line answer', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = calculate();\nuse(value);',
        });
        const pieces = new PromptAssembler({} as never, new EditWindowResolver())
            .assemble(document, new vscode.Position(0, 14), false).promptPieces;
        let maxTokens = 0;
        const predictor = new NextCursorPredictor(
            {} as never,
            {
                endpoint: 'messages', family: 'anthropic', model: 'claude-sonnet-5',
                baseUrl: '', apiKey: '', presencePenalty: 0, frequencyPenalty: 0,
                maxOutputTokens: 64,
                capabilities: { supports: { thinking: true, reasoning_effort: 'medium' } },
            } as never,
            { getAdapter: () => ({ send: async (request: { max_tokens: number }) => {
                maxTokens = request.max_tokens;
                return { text: '1', finishReason: 'stop' };
            } }) } as never,
            { debug() {}, info() {}, error() {} } as never,
        );
        const result = await predictor.predict(pieces);
        assert.ok(result.isOk());
        assert.strictEqual(maxTokens, 2048);
    });
    test('OpenAI reasoning cursor requests leave room for a visible line answer', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = calculate();\nuse(value);',
        });
        const pieces = new PromptAssembler({} as never, new EditWindowResolver())
            .assemble(document, new vscode.Position(0, 14), false).promptPieces;
        for (const family of ['openai-o', 'openai-gpt5']) {
            let maxTokens = 0;
            const predictor = new NextCursorPredictor(
                {} as never,
                {
                    endpoint: 'chat/completions', family, model: 'gpt-5',
                    baseUrl: '', apiKey: '', presencePenalty: 0, frequencyPenalty: 0,
                    maxOutputTokens: 64,
                    capabilities: { supports: { thinking: false, reasoning_effort: 'medium' } },
                } as never,
                { getAdapter: () => ({ send: async (request: { max_tokens: number }) => {
                    maxTokens = request.max_tokens;
                    return { text: '1', finishReason: 'stop' };
                } }) } as never,
                { debug() {}, info() {}, error() {} } as never,
            );
            assert.ok((await predictor.predict(pieces)).isOk());
            assert.strictEqual(maxTokens, 2048);
        }
    });
    test('fits a cursor prediction request into a small reasoning-model window', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = calculate();\nuse(value);',
        });
        const pieces = new PromptAssembler({} as never, new EditWindowResolver())
            .assemble(document, new vscode.Position(0, 14), false).promptPieces;
        const config = {
            endpoint: 'responses', family: 'openai-gpt5', model: 'small-reasoning-model',
            baseUrl: '', apiKey: '', presencePenalty: 0, frequencyPenalty: 0,
            nextCursorPredictionEnabled: true,
            capabilities: {
                limits: { max_context_window_tokens: 1_600 },
                supports: { thinking: false, reasoning_effort: 'medium' },
            },
        };
        let maxTokens = 0;
        const predictor = new NextCursorPredictor(
            {} as never, config as never,
            { getAdapter: () => ({ send: async (request: { max_tokens: number }) => {
                maxTokens = request.max_tokens;
                return { text: '1', finishReason: 'stop' };
            } }) } as never,
            { debug() {}, info() {}, error() {} } as never,
        );
        const promptR = predictor.buildCursorPredictionPrompt(pieces);
        assert.ok(promptR.isOk(), promptR.isError() ? promptR.err : undefined);
        const result = await predictor.predict(pieces);
        assert.ok(result.isOk(), result.isError() ? result.err : undefined);
        assert.strictEqual(maxTokens, 800);
        const systemPrompt = (NextCursorPredictor as unknown as { NCP_SYSTEM_PROMPT: string }).NCP_SYSTEM_PROMPT;
        const inputTokens = countPromptTokens(`${systemPrompt}\n${promptR.val.userMessage}`, 'openai-gpt5') + 32;
        assert.ok(inputTokens + maxTokens <= 1_600 - 128);
    });
    test('accepts a current-file line', () => {
        const result = parseCursorPrediction('42');
        assert.ok(result.isOk());
        assert.deepStrictEqual(result.val, { kind: 'sameFile', lineNumber: 42 });
    });

    test('accepts a path and line, including a Windows drive', () => {
        for (const input of ['src/utils.ts:15', 'C:\\repo\\utils.ts:15', 'src/utils.ts:15 extra']) {
            const result = parseCursorPrediction(input);
            assert.ok(result.isOk());
            assert.strictEqual(result.val.kind, 'differentFile');
            assert.strictEqual(result.val.lineNumber, 15);
        }
    });

    test('rejects partial numbers and invalid paths', () => {
        for (const input of ['42 extra', '-1', 'src/a.ts:-3', ':5', '9999999999999999999999999']) {
            assert.ok(parseCursorPrediction(input).isError(), input);
        }
    });

    test('keeps the answer between separate thinking blocks', () => {
        assert.strictEqual(extractCursorPredictionText('<think>first</think>src/a.ts:7<think>second</think>'), 'src/a.ts:7');
        assert.strictEqual(extractCursorPredictionText('<think>unfinished'), '');
    });

    test('unwraps only a complete single-line fenced cursor prediction', () => {
        assert.strictEqual(extractCursorPredictionText('```text\n42\n```'), '42');
        assert.strictEqual(extractCursorPredictionText('```\r\nsrc/a.ts:7\r\n```'), 'src/a.ts:7');
        for (const response of ['```\n42', '```\n42\n43\n```', '```\n42\n```\nextra']) {
            assert.ok(parseCursorPrediction(extractCursorPredictionText(response)).isError(), response);
        }
    });

    test('does not join multiple boundary lines into a different line number', () => {
        assert.strictEqual(extractCursorPredictionText(
            '###remain stat boundary line######\n15\n16\n###remain end boundary line######',
        ), '');
        assert.strictEqual(extractCursorPredictionText(
            '###remain stat boundary line######\n15\n###remain end boundary line######',
        ), '15');
        assert.strictEqual(extractCursorPredictionText(
            '###remain stat boundary line######\n15\n###remain end boundary line',
        ), '');
    });
});
