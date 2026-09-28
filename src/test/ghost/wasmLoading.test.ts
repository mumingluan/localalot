import * as assert from 'assert';
import * as path from 'path';
import { parseTreeSitterIncludingVersion } from '../../completions/ghost/multiline/treeSitter/parse';
import { setWasmDirPath } from '../../completions/ghost/multiline/treeSitter/fileLoader';

suite('Tree-sitter packaging', () => {
    test('bundled runtime and grammars parse supported languages', async () => {
        setWasmDirPath(path.resolve(__dirname, '../../..'));
        for (const [language, source] of [
            ['javascript', 'function f() { return 1; }'],
            ['typescript', 'const n: number = 1;'],
            ['python', 'def f():\n    return 1'],
        ]) {
            const [tree] = await parseTreeSitterIncludingVersion(language, source);
            assert.ok(tree.rootNode, language);
        }
    });
});
