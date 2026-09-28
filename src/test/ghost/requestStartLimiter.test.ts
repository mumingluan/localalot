import * as assert from 'assert';
import { RequestStartLimiter } from '../../completions/ghost/requestStartLimiter';

suite('Ghost request start limiter', () => {
    test('overlapping waits all settle and starts stay spaced', async () => {
        const limiter = new RequestStartLimiter();
        const starts: number[] = [];
        const results = await Promise.all(Array.from({ length: 3 }, async () => {
            const allowed = await limiter.wait(25, () => false);
            starts.push(Date.now());
            return allowed;
        }));
        assert.deepStrictEqual(results, [true, true, true]);
        assert.ok(starts[1] - starts[0] >= 15);
        assert.ok(starts[2] - starts[1] >= 15);
    });

    test('cancelled waiter releases the next caller', async () => {
        const limiter = new RequestStartLimiter();
        let cancelled = false;
        assert.strictEqual(await limiter.wait(20, () => false), true);
        const skipped = limiter.wait(20, () => cancelled);
        const next = limiter.wait(20, () => false);
        cancelled = true;
        assert.strictEqual(await skipped, false);
        assert.strictEqual(await next, true);
    });
});
