import * as assert from 'assert';
import { DefaultMultilineStrategy } from '../../../completions/ghost/multiline/DefaultMultilineStrategy';
import { IMultilineDetector } from '../../../completions/ghost/multiline/types';
import { createMockContext } from './helpers';
import { getGhostGenerationOptions } from '../../../completions/ghost/generationStrategy';

function stubDetector(name: string, decision: 'multiline' | 'singleline' | 'defer'): IMultilineDetector {
    return { name, detect: async () => ({ decision }) };
}

suite('DefaultMultilineStrategy', () => {
    test('_serviceBrand is undefined (DI compliance)', () => {
        const strategy = new DefaultMultilineStrategy();
        assert.strictEqual(strategy._serviceBrand, undefined);
    });

    test('constructor assembles parser and language detectors in chain', () => {
        const strategy = new DefaultMultilineStrategy();
        assert.strictEqual(strategy._serviceBrand, undefined);
        assert.strictEqual(strategy['chain'].name, 'Chain[ServerMode→FileSizeGuard→NewLine→EmptyBlock→MLModel]');
    });

    test('afterAccept forces multiline regardless of chain', async () => {
        const forceSingleline = stubDetector('Single', 'singleline');
        const strategy = new DefaultMultilineStrategy(forceSingleline, forceSingleline, forceSingleline, forceSingleline, forceSingleline);
        const ctx = createMockContext({ afterAccept: true });
        assert.strictEqual(await strategy.determineMultiline(ctx), true);
    });

    test('afterAccept=false delegates to chain', async () => {
        const forceSingleline = stubDetector('Single', 'singleline');
        const strategy = new DefaultMultilineStrategy(forceSingleline, forceSingleline, forceSingleline, forceSingleline, forceSingleline);
        const ctx = createMockContext({ afterAccept: false, languageId: 'python' });
        assert.strictEqual(await strategy.determineMultiline(ctx), false);
    });

    test('afterAccept=false with multiline detector returns true', async () => {
        const forceMultiline = stubDetector('Multi', 'multiline');
        const deferAll = stubDetector('Defer', 'defer');
        const strategy = new DefaultMultilineStrategy(deferAll, forceMultiline, deferAll, deferAll, deferAll);
        const ctx = createMockContext({ afterAccept: false, languageId: 'python' });
        assert.strictEqual(await strategy.determineMultiline(ctx), true);
    });

    test('native client-mode languages start single-line and expand after acceptance', async () => {
        const strategy = new DefaultMultilineStrategy();
        for (const languageId of ['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'go']) {
            const ctx = createMockContext({
                lines: ['function run() {', '    '], cursorLine: 1, cursorChar: 4,
                languageId,
            });
            assert.strictEqual(await strategy.determineMultiline(ctx), false, languageId);
            assert.strictEqual(await strategy.determineMultiline({ ...ctx, afterAccept: true }), true, languageId);
        }
    });

    test('YAML mapping key without a value uses multiline generation', async () => {
        const ctx = createMockContext({
            lines: ['services:', '  web:'],
            cursorLine: 1,
            cursorChar: 7,
            languageId: 'yaml',
            prefix: 'services:\n  web:',
            suffix: '',
        });
        const multiline = await new DefaultMultilineStrategy().determineMultiline(ctx);
        assert.strictEqual(multiline, true);
        const generation = getGhostGenerationOptions(multiline, 256, ['\n'], false, 2, undefined, 'yaml');
        assert.deepStrictEqual(generation, { maxTokens: 256, stop: [] });
    });

    test('JSON property without a value uses multiline generation', async () => {
        const ctx = createMockContext({
            lines: ['{', '  "services":'],
            cursorLine: 1,
            cursorChar: 13,
            languageId: 'json',
            prefix: '{\n  "services":',
            suffix: '',
        });
        assert.strictEqual(await new DefaultMultilineStrategy().determineMultiline(ctx), true);
    });

    test('native server-mode languages allow multiline at valid cursor positions', async () => {
        const strategy = new DefaultMultilineStrategy();
        for (const languageId of ['css', 'html', 'markdown', 'shellscript', 'plaintext']) {
            const ctx = createMockContext({
                lines: ['example:'], cursorLine: 0, cursorChar: 8, languageId,
                isMiddleOfTheLine: false,
            });
            assert.strictEqual(await strategy.determineMultiline(ctx), true, languageId);
        }
    });

    test('C++ uses native server-mode multiline at every valid cursor', async () => {
        const strategy = new DefaultMultilineStrategy();
        const scalar = createMockContext({
            lines: ['int count = '], cursorLine: 0, cursorChar: 12, languageId: 'cpp',
        });
        assert.strictEqual(await strategy.determineMultiline(scalar), true);
        const block = createMockContext({
            lines: ['void render() {', '    ', '}'], cursorLine: 1, cursorChar: 4, languageId: 'cpp',
        });
        assert.strictEqual(await strategy.determineMultiline(block), true);
    });

    test('Java, C# and PHP method bodies use native server-mode multiline', async () => {
        const strategy = new DefaultMultilineStrategy();
        for (const [languageId, lines, cursorLine] of [
            ['java', ['class App {', '  void run() {', '    ', '  }', '}'], 2],
            ['csharp', ['class App {', '  void Run() {', '    ', '  }', '}'], 2],
            ['php', ['<?php', 'function run() {', '    ', '}'], 2],
        ] as const) {
            const ctx = createMockContext({ lines: [...lines], cursorLine, cursorChar: 4, languageId });
            assert.strictEqual(await strategy.determineMultiline(ctx), true, languageId);
        }
    });

    test('new method bodies remain multiline before the closing brace is typed', async () => {
        const strategy = new DefaultMultilineStrategy();
        for (const [languageId, lines, cursorLine] of [
            ['cpp', ['void run() {', '    '], 1],
            ['java', ['class App {', '  void run() {', '    '], 2],
            ['csharp', ['class App {', '  void Run() {', '    '], 2],
            ['php', ['<?php', 'function run() {', '    '], 2],
        ] as const) {
            const ctx = createMockContext({ lines: [...lines], cursorLine, cursorChar: 4, languageId });
            assert.strictEqual(await strategy.determineMultiline(ctx), true, languageId);
        }
    });

    test('C# server mode does not depend on local brace parsing', async () => {
        const strategy = new DefaultMultilineStrategy();
        for (const source of ['// {', 'var text = "{']) {
            const ctx = createMockContext({
                lines: [source, '    '], cursorLine: 1, cursorChar: 4, languageId: 'csharp',
            });
            assert.strictEqual(await strategy.determineMultiline(ctx), true, source);
        }
    });

    test('server-mode request remains multiline in a long file', async () => {
        const ctx = createMockContext({ lines: ['a {'], cursorLine: 0, cursorChar: 3, languageId: 'css' });
        Object.defineProperty(ctx.document, 'lineCount', { value: 8000 });
        assert.strictEqual(await new DefaultMultilineStrategy().determineMultiline(ctx), true);
    });

    test('YAML block scalar and list entry use multiline generation', async () => {
        const strategy = new DefaultMultilineStrategy();
        for (const line of ['  command: |', '  command: >', '  command: |+', '  command: >-', '  command: |+2', '  command: >2-', '  command: {', '  -']) {
            const ctx = createMockContext({
                lines: [line],
                cursorLine: 0,
                cursorChar: line.length,
                languageId: 'yaml',
                prefix: line,
                suffix: '',
            });
            assert.strictEqual(await strategy.determineMultiline(ctx), true, line);
        }
    });

    test('YAML anchors and tags without a value use multiline generation', async () => {
        const strategy = new DefaultMultilineStrategy();
        for (const line of ['  config: &defaults', '  config: !!map', '  config: &defaults !!map', '  config: !!map &defaults']) {
            const ctx = createMockContext({
                lines: [line],
                cursorLine: 0,
                cursorChar: line.length,
                languageId: 'yaml',
                prefix: line,
                suffix: '',
            });
            assert.strictEqual(await strategy.determineMultiline(ctx), true, line);
        }
    });

    test('YAML indented blank line after a mapping key uses multiline generation', async () => {
        const strategy = new DefaultMultilineStrategy();
        const ctx = createMockContext({
            lines: ['services:', '  web:', '    '],
            cursorLine: 2,
            cursorChar: 4,
            languageId: 'yaml',
            prefix: 'services:\n  web:\n    ',
            suffix: '',
        });
        assert.strictEqual(await strategy.determineMultiline(ctx), true);
    });

    test('YAML blank line after a completed value can generate the next entry', async () => {
        const ctx = createMockContext({
            lines: ['services:', '  web:', '    image: nginx', '    '],
            cursorLine: 3,
            cursorChar: 4,
            languageId: 'yaml',
            prefix: 'services:\n  web:\n    image: nginx\n    ',
            suffix: '',
        });
        const multiline = await new DefaultMultilineStrategy().determineMultiline(ctx);
        assert.strictEqual(multiline, true);
        assert.deepStrictEqual(getGhostGenerationOptions(multiline, 256, ['\n'], false, 2, undefined, 'yaml'), {
            maxTokens: 256, stop: [],
        });
    });

    test('JSON blank line after a completed value can generate another property', async () => {
        const ctx = createMockContext({
            lines: ['{', '  "name": "demo",', '  '],
            cursorLine: 2,
            cursorChar: 2,
            languageId: 'json',
            prefix: '{\n  "name": "demo",\n  ',
            suffix: '',
        });
        assert.strictEqual(await new DefaultMultilineStrategy().determineMultiline(ctx), true);
    });

    test('completed YAML scalar can continue with a following key', async () => {
        const line = '  image: nginx';
        const ctx = createMockContext({
            lines: [line],
            cursorLine: 0,
            cursorChar: line.length,
            languageId: 'yaml',
            prefix: line,
            suffix: '',
        });
        assert.strictEqual(await new DefaultMultilineStrategy().determineMultiline(ctx), true);
    });

    test('large YAML file keeps multiline completion at a mapping key', async () => {
        const ctx = createMockContext({
            lines: ['services:', '  web:'],
            cursorLine: 1,
            cursorChar: 6,
            languageId: 'yaml',
        });
        Object.defineProperty(ctx.document, 'lineCount', { value: 8000 });
        assert.strictEqual(await new DefaultMultilineStrategy().determineMultiline(ctx), true);
    });

    test('structured data before closing punctuation still requests a full block', async () => {
        for (const languageId of ['yaml', 'json']) {
            const ctx = createMockContext({
                lines: ['  config: {}'],
                cursorLine: 0,
                cursorChar: 11,
                languageId,
                suffix: '}',
                isMiddleOfTheLine: true,
            });
            assert.strictEqual(await new DefaultMultilineStrategy().determineMultiline(ctx), true, languageId);
        }
    });

    test('ordinary Python continuation with later document text stays single-line', async () => {
        const ctx = createMockContext({
            lines: ['def render():', '    value = 1', '    return value', ''],
            cursorLine: 1,
            cursorChar: 16,
            languageId: 'python',
            prefix: 'def render():\n    value = 1',
            suffix: '\n    return value\n',
        });
        assert.strictEqual(await new DefaultMultilineStrategy().determineMultiline(ctx), false);
    });
});
