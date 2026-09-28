import * as assert from 'assert';
import { sliceCompleteCodePoints } from '../../common/unicodeSlice';

suite('Unicode prompt slicing', () => {
    test('keeps complete code points on both sides of a character budget', () => {
        assert.strictEqual(sliceCompleteCodePoints('a😀b', 2), 'a');
        assert.strictEqual(sliceCompleteCodePoints('a😀b', 2, true), 'b');
        assert.strictEqual(sliceCompleteCodePoints('a😀b', 3), 'a😀');
        assert.strictEqual(sliceCompleteCodePoints('a😀b', 3, true), '😀b');
        assert.strictEqual(sliceCompleteCodePoints('😀rest', 1), '');
        assert.strictEqual(sliceCompleteCodePoints('rest😀', 1, true), '');
    });
});
