import * as assert from 'assert';
import * as vscode from 'vscode';
import { PromptAssembler } from '../../../completions/nes/core/promptAssembler';
import { EditWindowResolver } from '../../../completions/nes/core/editWindowResolver';
import { countPromptTokens, ensurePromptTokenizerLoaded } from '../../../completions/nes/core/promptTokenizer';
import { estimatePromptTokens, takeEstimatedPromptTokens } from '../../../completions/nes/core/promptTokenEstimate';

suite('NES exact prompt tokenizer', () => {
    test('fallback clipping respects estimated tokens for Unicode on both sides', () => {
        const source = 'services:\n  web: # 服务配置😀\n    image: nginx';
        for (const limit of [1, 3, 5, 10, 20]) {
            const head = takeEstimatedPromptTokens(source, limit);
            const tail = takeEstimatedPromptTokens(source, limit, true);
            assert.ok(source.startsWith(head));
            assert.ok(source.endsWith(tail));
            assert.ok(estimatePromptTokens(head) <= limit);
            assert.ok(estimatePromptTokens(tail) <= limit);
        }
    });

    test('fallback clipping never emits half of a surrogate pair', () => {
        assert.strictEqual(takeEstimatedPromptTokens('😀suffix', 1), '');
        assert.strictEqual(takeEstimatedPromptTokens('prefix😀', 1, true), '');
        assert.strictEqual(takeEstimatedPromptTokens('x😀suffix', 1), 'x');
        assert.strictEqual(takeEstimatedPromptTokens('prefix😀x', 1, true), 'x');
    });

    test('loads the bundled o200k dictionary and keeps other families on the fallback', async () => {
        assert.strictEqual(await ensurePromptTokenizerLoaded(), true);
        assert.strictEqual(countPromptTokens('Hello world', 'standard'), 2);
        assert.strictEqual(countPromptTokens('服务配置', 'openai-gpt5'), 2);
        assert.strictEqual(countPromptTokens('服务配置', 'anthropic'), 4);
    });

    test('uses exact counts when assembling a GPT-family edit prompt', async () => {
        assert.strictEqual(await ensurePromptTokenizerLoaded(), true);
        const document = await vscode.workspace.openTextDocument({ language: 'yaml', content: '服务配置:\n  web:' });
        const assembly = new PromptAssembler({ family: 'standard' } as never, new EditWindowResolver())
            .assemble(document, new vscode.Position(1, 6), false);
        assert.strictEqual(assembly.promptPieces.computeTokens('服务配置'), 2);
    });
});
