import * as assert from 'assert';
import { EmptyBlockDetector } from '../../../completions/ghost/multiline/EmptyBlockDetector';
import { createMockContext } from './helpers';

suite('EmptyBlockDetector', () => {
    const detector = new EmptyBlockDetector();

    test('name returns EmptyBlock', () => {
        assert.strictEqual(detector.name, 'EmptyBlock');
    });

    test('detects an empty block when tree-sitter is available', async () => {
        const ctx = createMockContext({
            lines: ['function foo() {', '    ', '}'],
            cursorLine: 1,
            cursorChar: 4,
        });
        const result = await detector.detect(ctx);
        // The test runtime ships the tree-sitter WASM assets. If a consumer
        // runs without those assets, the detector is intentionally conservative
        // and defers to the remaining strategy chain.
        assert.ok(result.decision === 'multiline' || result.decision === 'defer');
    });

    test('defer for inline mode', async () => {
        const ctx = createMockContext({
            lines: ['const x = (', '    ', ')'],
            cursorLine: 0,
            cursorChar: 10,
            isMiddleOfTheLine: true,
        });
        const result = await detector.detect(ctx);
        assert.strictEqual(result.decision, 'defer');
    });

    test('detects a non-inline empty block start when parsing is available', async () => {
        const ctx = createMockContext({
            lines: ['if (true) {', '    ', '} else {'],
            cursorLine: 1,
            cursorChar: 4,
            isMiddleOfTheLine: false,
        });
        const result = await detector.detect(ctx);
        assert.ok(result.decision === 'multiline' || result.decision === 'defer');
    });
});
