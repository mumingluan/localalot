import * as assert from 'assert';
import { TrimCompletionSuffixOverlap } from '../../common/suffixOverlapTrim';

suite('TrimNESResponseSuffixOverlap', () => {
    test('should detect exact overlap', () => {
        const trimmer = new TrimCompletionSuffixOverlap(0.5, 'low');
        const newLines = ['function foo() {', '  return 1;', '}'];
        const suffixLines = ['}', ''];
        const overlap = trimmer.calculateOverlap(newLines, suffixLines);
        assert.strictEqual(overlap, 1);
    });

    test('should return 0 for no overlap', () => {
        const trimmer = new TrimCompletionSuffixOverlap(0.5, 'low');
        const newLines = ['function foo() {', '  return 1;', '}'];
        const suffixLines = ['completely', 'different', 'content'];
        const overlap = trimmer.calculateOverlap(newLines, suffixLines);
        assert.strictEqual(overlap, 0);
    });

    test('should return 0 for empty input', () => {
        const trimmer = new TrimCompletionSuffixOverlap(0.5, 'low');
        assert.strictEqual(trimmer.calculateOverlap([], []), 0);
        assert.strictEqual(trimmer.calculateOverlap(['a'], []), 0);
        assert.strictEqual(trimmer.calculateOverlap([], ['a']), 0);
    });

    test('should handle high mode', () => {
        const trimmer = new TrimCompletionSuffixOverlap(0.5, 'high');
        const newLines = ['lineA', 'lineB', 'lineC'];
        const suffixLines = ['lineB', 'lineC', 'lineD'];
        const overlap = trimmer.calculateOverlap(newLines, suffixLines);
        assert.ok(overlap >= 0);
    });

    test('counts only the overlapping tail when blank and useful lines precede it', () => {
        for (const type of ['low', 'high'] as const) {
            const trimmer = new TrimCompletionSuffixOverlap(0.6, type);
            const lines = ['', '    return result;', '}'];
            const overlap = trimmer.calculateOverlap(lines, ['', '}']);
            assert.strictEqual(overlap, 1);
            assert.deepStrictEqual(lines.slice(0, -overlap), ['', '    return result;']);
        }
    });
});
