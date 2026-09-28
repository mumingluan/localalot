import * as assert from 'assert';
import { allocateGhostModelWindow, allocateGhostPromptBudget, allocateGhostTokenBudget, NATIVE_GHOST_PROMPT_TOKEN_LIMIT } from '../../completions/ghost/promptBudget';
import { GhostPromptFactory } from '../../completions/ghost/promptFactory';
import { GhostTextComputer } from '../../completions/ghost/ghostTextComputer';
import { countO200kTokens, ensurePromptTokenizerLoaded } from '../../completions/nes/core/promptTokenizer';

suite('Ghost prompt budget', () => {
    test('preserves native headroom on large models and source room on small models', () => {
        assert.deepStrictEqual(allocateGhostModelWindow(128_000, 500), {
            inputTokens: NATIVE_GHOST_PROMPT_TOKEN_LIMIT, outputTokens: 500, safetyTokens: 768,
        });
        const local = allocateGhostModelWindow(1_024, 500);
        assert.ok(local.inputTokens > 400);
        assert.strictEqual(local.inputTokens + local.outputTokens + local.safetyTokens, 1_024);
        const oversizedOutput = allocateGhostModelWindow(1_024, 4_096);
        assert.ok(oversizedOutput.outputTokens < 1_024 / 2);
        assert.strictEqual(oversizedOutput.inputTokens + oversizedOutput.outputTokens
            + oversizedOutput.safetyTokens, 1_024);
    });
    test('reserves suffix and bounded context inside total budget', () => {
        const budget = allocateGhostPromptBudget(10_000, 5_000, true);
        assert.strictEqual(budget.prefixChars + budget.suffixChars + budget.contextChars, 10_000);
        assert.ok(budget.suffixChars > 0);
        assert.ok(budget.contextChars <= 6_000);
    });

    test('returns unused suffix space to the source prefix', () => {
        const budget = allocateGhostPromptBudget(10_000, 2, true);
        assert.strictEqual(budget.suffixChars, 2);
        assert.strictEqual(budget.prefixChars + budget.contextChars, 9_998);
    });

    test('returns unused short-prefix space to a long FIM suffix', () => {
        const budget = allocateGhostPromptBudget(10_000, 8_000, false, 20, 200);
        assert.strictEqual(budget.prefixChars, 2_000);
        assert.strictEqual(budget.suffixChars, 8_000);
        assert.strictEqual(budget.prefixChars + budget.suffixChars, 10_000);
    });

    test('cascades unused prefix tokens to a long FIM suffix', () => {
        assert.deepStrictEqual(allocateGhostTokenBudget(300, 20, 250), {
            prefixTokens: 50, suffixTokens: 250,
        });
    });

    test('clips a long Unicode prefix by exact tokens while retaining cursor context', async () => {
        assert.strictEqual(await ensurePromptTokenizerLoaded(), true);
        const computer = Object.create(GhostTextComputer.prototype) as {
            _clipPrefixByTokens(prefix: string, maxTokens: number): string;
        };
        const prefix = 'import x;\n' + Array(100).fill('const 配置项 = "服务";').join('\n')
            + '\nfunction run() {\n  return 配置项';
        const clipped = computer._clipPrefixByTokens(prefix, 100);
        assert.ok(countO200kTokens(clipped) <= 100);
        assert.ok(clipped.endsWith('  return 配置项'));
    });

    test('keeps the cursor tail without an artificial marker', () => {
        const computer = Object.create(GhostTextComputer.prototype) as {
            _clipPrefix(prefix: string, maxChars: number): string;
        };
        const prefix = 'import value from "./value";\n' + 'x'.repeat(1_000) + '\nuse(value';
        for (const limit of [0, 5, 25, 100]) {
            const clipped = computer._clipPrefix(prefix, limit);
            assert.ok(clipped.length <= limit, `limit=${limit}, actual=${clipped.length}`);
            assert.ok(prefix.endsWith(clipped));
            assert.ok(!clipped.includes('[...]'));
        }
    });

    test('elides whole lines before the cursor tail when a multiline prefix is clipped', () => {
        const computer = Object.create(GhostTextComputer.prototype) as {
            _clipPrefix(prefix: string, maxChars: number): string;
        };
        const prefix = 'import x;\n' + Array(30).fill('const filler = 1;').join('\n')
            + '\nfunction run() {\n  return compute(';
        const clipped = computer._clipPrefix(prefix, 160);
        assert.ok(clipped.length <= 160);
        assert.ok(prefix.endsWith(clipped));
        assert.strictEqual(prefix[prefix.length - clipped.length - 1], '\n');
        assert.ok(clipped.endsWith('  return compute('));
        assert.ok(!clipped.includes('[...]'));
    });

    test('context truncation never exceeds the requested limit', () => {
        const prompt = new GhostPromptFactory().createPrompt({
            template: '{prefix}<|fim_suffix|>{suffix}',
            prefix: 'const value = ',
            suffix: '',
            languageId: 'typescript',
            diagnostics: [],
            recentEdits: ['a'.repeat(100)],
            relatedFiles: [{ path: 'other.ts', snippet: 'b'.repeat(100) }],
            maxContextChars: 30,
        });
        const context = prompt.slice(0, prompt.indexOf('const value'));
        assert.ok(context.length <= 31);
    });

    test('a tiny context budget never emits an orphaned closing marker', () => {
        const factory = new GhostPromptFactory();
        for (const limit of [0, 1, 20, 30, 50]) {
            const context = factory.createContext({
                languageId: 'yaml', diagnostics: [], recentEdits: [], maxContextChars: limit,
            });
            assert.ok(context.length <= limit, `limit=${limit}, length=${context.length}`);
            assert.strictEqual(context.includes('</copilot-context>'), context.includes('<copilot-context>'));
        }
    });
});
