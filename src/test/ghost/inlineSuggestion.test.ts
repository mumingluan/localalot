import * as assert from 'assert';
import { isInlineSuggestionFromTextAfterCursor } from '../../completions/ghost/inlineSuggestion';

suite('isInlineSuggestion', () => {

    suite('end of line → false (allow normal completion)', () => {
        test('empty', () => {
            assert.strictEqual(isInlineSuggestionFromTextAfterCursor(''), false);
        });
        test('whitespace only', () => {
            assert.strictEqual(isInlineSuggestionFromTextAfterCursor('   '), false);
            assert.strictEqual(isInlineSuggestionFromTextAfterCursor('\t'), false);
        });
    });

    suite('valid inline → true (allow inline completion)', () => {
        const validCases = [
            [')'], ['];'], [');'], [')  '], [') {\n'],
            ['>'], [']'], ['}'],
            ['"'], ["'"], ['`'],
            [':'], [';'], [','],
            ['):'], ['): '], [') {  '],
        ];
        for (const [input] of validCases) {
            test(`"${input}"`, () => {
                const result = isInlineSuggestionFromTextAfterCursor(input as string);
                assert.strictEqual(result, true, `expected true for "${input}", got ${result}`);
            });
        }
    });

    suite('invalid mid-line → undefined (abort)', () => {
        const invalidCases = [
            ['foo'],
            ['bar()'],
            ['add(a + b);'],
            ['+ 1'],
            ['= 5'],
            ['('],
            ['['],
            ['d(a + b);'],
            ['// comment'],
            ['* 42'],
            ['/ 2'],
            ['% x'],
            ['&& true'],
            ['|| false'],
            ['? a : b'],
            ['.method()'],
            ['.'],
            ['<T>'],
            ['!'],
            ['~'],
            ['- 1'],
            ['x + y'],
            ['"hello" +'],
        ];
        for (const [input] of invalidCases) {
            test(`"${input}"`, () => {
                const result = isInlineSuggestionFromTextAfterCursor(input as string);
                assert.strictEqual(result, undefined, `expected undefined for "${input}", got ${result}`);
            });
        }
    });
});
