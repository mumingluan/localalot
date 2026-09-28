import * as assert from 'assert';
import { estimatePromptTokens } from '../../../completions/nes/core/promptTokenEstimate';

suite('NES prompt token estimate', () => {
    test('never assigns zero cost to a nonempty short snippet', () => {
        assert.strictEqual(estimatePromptTokens(''), 0);
        assert.strictEqual(estimatePromptTokens('a'), 1);
        assert.strictEqual(estimatePromptTokens('abcd'), 1);
        assert.strictEqual(estimatePromptTokens('abcde'), 2);
    });

    test('counts Unicode code points separately from ASCII runs', () => {
        assert.strictEqual(estimatePromptTokens('服务配置'), 4);
        assert.strictEqual(estimatePromptTokens('ab中cd'), 3);
        assert.strictEqual(estimatePromptTokens('x😀y'), 4);
    });
});
