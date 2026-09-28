import * as assert from 'assert';
import { choiceTextForLineMode, completedSingleLineText, getGhostGenerationOptions, shouldTrimByIndentation } from '../../completions/ghost/generationStrategy';
import { BlockPositionType } from '../../completions/ghost/blockTrimmer';

suite('GHOST generation strategy', () => {
    test('finishes a streamed single line without discarding a leading newline', () => {
        assert.strictEqual(completedSingleLineText('image: nginx'), undefined);
        assert.strictEqual(completedSingleLineText('image: nginx\nother: value'), 'image: nginx');
        assert.strictEqual(completedSingleLineText('\n    image: nginx'), undefined);
        assert.strictEqual(completedSingleLineText('\n    image: nginx\n    ports:'), '\n    image: nginx');
        assert.strictEqual(completedSingleLineText('\r\n    image: nginx\r\n'), '\r\n    image: nginx');
    });
    test('limits reused choices to one generated line only in single-line mode', () => {
        assert.strictEqual(choiceTextForLineMode('first\nsecond', false), 'first');
        assert.strictEqual(choiceTextForLineMode('\n  first\n  second', false), '\n  first');
        assert.strictEqual(choiceTextForLineMode('first\r\nsecond', false), 'first');
        assert.strictEqual(choiceTextForLineMode('\r\n  first\r\n  second', false), '\r\n  first');
        assert.strictEqual(choiceTextForLineMode('\n  first\n  second', true), '\n  first\n  second');
    });
    test('keeps multiline requests open for server and parser-backed languages', () => {
        for (const language of ['yaml', 'json', 'cpp', 'markdown', 'python']) {
            assert.deepStrictEqual(getGhostGenerationOptions(true, 256, [], false, 2, undefined, language).stop,
                [], language);
        }
        for (const language of ['yaml', 'json', 'markdown']) {
            assert.deepStrictEqual(getGhostGenerationOptions(false, 256, [], false, 2, undefined, language).stop,
                [], language);
        }
    });

    test('stops parser-mode single-line requests on the server', () => {
        for (const language of ['python', 'ruby']) {
            assert.deepStrictEqual(getGhostGenerationOptions(false, 256, [], false, 2, undefined, language).stop,
                ['\n'], language);
        }
        for (const language of ['c', 'cpp', 'csharp', 'java', 'php']) {
            assert.deepStrictEqual(getGhostGenerationOptions(false, 256, [], false, 2, undefined, language).stop,
                [], language);
        }
        for (const language of ['javascript', 'typescript', 'go']) {
            assert.deepStrictEqual(getGhostGenerationOptions(false, 256, [], false, 2, undefined, language).stop,
                [], language);
        }
        assert.deepStrictEqual(getGhostGenerationOptions(true, 256, [], false, 2, undefined, 'python').stop,
            []);
    });

    test('matches native default server trimming by language', () => {
        for (const language of ['yaml', 'json', 'python', 'cpp']) {
            assert.strictEqual(shouldTrimByIndentation(language), true, language);
        }
        for (const language of ['ruby', 'javascript', 'typescript', 'go']) {
            assert.strictEqual(shouldTrimByIndentation(language), false, language);
        }
        assert.strictEqual(shouldTrimByIndentation('yaml', true), false);
        for (const language of ['python', 'c', 'cpp', 'csharp', 'java', 'php']) {
            assert.strictEqual(shouldTrimByIndentation(language, true), false, language);
        }
    });

    test('explicit single-line stops override the native defaults', () => {
        assert.deepStrictEqual(getGhostGenerationOptions(false, 256, ['END']), {
            maxTokens: 256,
            stop: ['END'],
        });
    });

    test('preserves an explicitly configured newline stop for single-line requests', () => {
        assert.deepStrictEqual(getGhostGenerationOptions(false, 256, ['\n', 'END']), {
            maxTokens: 256,
            stop: ['\n', 'END'],
        });
    });

    test('server-mode single-line requests keep the first generated line after a leading newline', () => {
        for (const language of ['yaml', 'json', 'markdown']) {
            assert.deepStrictEqual(getGhostGenerationOptions(false, 256, ['\n', 'END'], false, 2, undefined, language), {
                maxTokens: 256,
                stop: ['END'],
            }, language);
        }
    });

    test('multiline requests preserve line breaks and use configured output budget', () => {
        assert.deepStrictEqual(getGhostGenerationOptions(true, 180, ['END']), {
            maxTokens: 180,
            stop: ['END'],
        });
    });

    test('multiline requests remove a configured single-line newline stop', () => {
        assert.deepStrictEqual(getGhostGenerationOptions(true, 180, ['\n', 'END']), {
            maxTokens: 180,
            stop: ['END'],
        });
    });

    test('multiline token budget honors a configured limit above the default', () => {
        assert.strictEqual(getGhostGenerationOptions(true, 2048, []).maxTokens, 2048);
        assert.strictEqual(getGhostGenerationOptions(false, 2048, []).maxTokens, 2048);
    });

    test('accepted completion requests a bounded follow-up block', () => {
        assert.deepStrictEqual(getGhostGenerationOptions(true, 256, [], true), {
            maxTokens: 20,
            stop: ['\n\n'],
        });
    });

    test('accepted empty blocks use the short follow-up budget outside client block mode', () => {
        assert.deepStrictEqual(getGhostGenerationOptions(true, 256, [], true, 1, BlockPositionType.EmptyBlock), {
            maxTokens: 20,
            stop: ['\n\n'],
        });
    });
});
