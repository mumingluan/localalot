import * as assert from 'assert';
import { normalizeGhostIndent } from '../../completions/ghost/normalizeIndent';

suite('Ghost indentation normalization', () => {
    test('converts leading spaces to tabs using the editor tab size', () => {
        const result = normalizeGhostIndent('    return 1;', '    return 1;', { tabSize: 4, insertSpaces: false }, false);
        assert.strictEqual(result.completionText, '\treturn 1;');
        assert.strictEqual(result.displayText, '\treturn 1;');
    });

    test('converts leading tabs to spaces', () => {
        const result = normalizeGhostIndent('\t\treturn 1;', '\t\treturn 1;', { tabSize: 2, insertSpaces: true }, false);
        assert.strictEqual(result.completionText, '    return 1;');
    });

    test('rounds the first line on an empty spaces-based line', () => {
        const result = normalizeGhostIndent('   value', '   value', { tabSize: 4, insertSpaces: true }, true);
        assert.strictEqual(result.completionText, '    value');
    });

    test('rounds every generated line after a partially indented first line', () => {
        const generated = '  image: nginx\n    ports:\n      - 80';
        const result = normalizeGhostIndent(generated, generated, { tabSize: 4, insertSpaces: true }, true);
        assert.strictEqual(result.completionText, '    image: nginx\n        ports:\n            - 80');
        assert.strictEqual(result.displayText, result.completionText);
    });

    test('preserves a first-token newline and unindented following lines', () => {
        const generated = '\n    image: nginx\n  worker:';
        const result = normalizeGhostIndent(generated, generated, { tabSize: 4, insertSpaces: true }, true);
        assert.strictEqual(result.completionText, generated);
    });

    test('does not alter text when editor options are unavailable', () => {
        const result = normalizeGhostIndent('\tvalue', '\tvalue', undefined, true);
        assert.strictEqual(result.completionText, '\tvalue');
    });
});
