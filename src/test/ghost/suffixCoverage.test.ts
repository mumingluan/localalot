import * as assert from 'assert';
import { calculateSuffixCoverage } from '../../completions/ghost/ghostTextComputer';

suite('GHOST suffix coverage', () => {
    test('covers the complete same-line suffix when it occurs in the completion', () => {
        assert.strictEqual(calculateSuffixCoverage('x, y);', ');\nnext();'), 2);
    });

    test('does not consume a suffix that the completion does not contain', () => {
        assert.strictEqual(calculateSuffixCoverage('x, y', ');\nnext();'), 0);
    });

    test('covers existing closers in a multiline completion', () => {
        assert.strictEqual(
            calculateSuffixCoverage('condition) {\n    return 1;', ') {\n    do();'),
            3,
        );
    });
});
