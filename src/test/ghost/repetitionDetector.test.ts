import * as assert from 'assert';
import { isRepetitiveCompletion } from '../../completions/ghost/repetitionDetector';

suite('Ghost repetition filtering', () => {
    test('rejects a long single-line loop at the end of a completion', () => {
        assert.strictEqual(isRepetitiveCompletion('useful();\n' + Array(8).fill('  repeat();').join('\n')), true);
    });

    test('rejects a repeating two-line pattern', () => {
        assert.strictEqual(isRepetitiveCompletion(Array(4).fill('  open();\n  close();').join('\n')), true);
    });

    test('keeps short and varied completions', () => {
        assert.strictEqual(isRepetitiveCompletion(Array(7).fill('  repeat();').join('\n')), false);
        assert.strictEqual(isRepetitiveCompletion('  first();\n  second();\n  first();\n  third();'), false);
    });
});
