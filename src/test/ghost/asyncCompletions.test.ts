import * as assert from 'assert';
import { AsyncCompletionsManager, AsyncCompletionResult } from '../../completions/ghost/asyncCompletions';

suite('Ghost asynchronous request reuse', () => {
    test('speculative lookup cannot cancel an in-flight visible completion', async () => {
        const manager = new AsyncCompletionsManager();
        let finishVisible!: (value: AsyncCompletionResult) => void;
        let canceledVisible = false;
        const result = new Promise<AsyncCompletionResult>(resolve => { finishVisible = resolve; });
        const queued = manager.queueCompletionRequest('visible', 'const answer = ', '', {
            cancel() { canceledVisible = true; },
        }, result, 'same-scope', 'file-a');
        const visible = manager.getFirstMatchingRequest(
            'visible', 'const answer = ', '', undefined, 'same-scope', undefined, 'file-a', false,
        );

        const speculative = await manager.getFirstMatchingRequest(
            'prefetch', 'const different = ', '', 20, 'same-scope', undefined, 'file-a', true,
        );
        assert.strictEqual(speculative, undefined);
        assert.strictEqual(canceledVisible, false);

        finishVisible({ completionText: '42;', finishReason: 'stop' });
        assert.deepStrictEqual(await visible, { completionText: '42;', finishReason: 'stop' });
        await queued;
    });

    test('a request in another document does not cancel the first document', async () => {
        const manager = new AsyncCompletionsManager();
        let finishA!: (value: AsyncCompletionResult) => void;
        let finishB!: (value: AsyncCompletionResult) => void;
        let canceledA = false;
        const resultA = new Promise<AsyncCompletionResult>(resolve => { finishA = resolve; });
        const resultB = new Promise<AsyncCompletionResult>(resolve => { finishB = resolve; });
        const queuedA = manager.queueCompletionRequest('a', 'const a = ', '', {
            cancel() { canceledA = true; },
        }, resultA, 'scope-a', 'file-a');
        const waitingA = manager.getFirstMatchingRequest('a', 'const a = ', '', undefined, 'scope-a', undefined, 'file-a');
        const queuedB = manager.queueCompletionRequest('b', 'const b = ', '', { cancel() {} }, resultB, 'scope-b', 'file-b');
        const waitingB = manager.getFirstMatchingRequest('b', 'const b = ', '', undefined, 'scope-b', undefined, 'file-b');

        assert.strictEqual(canceledA, false);
        finishA({ completionText: '1;', finishReason: 'stop' });
        finishB({ completionText: '2;', finishReason: 'stop' });
        assert.deepStrictEqual(await waitingA, { completionText: '1;', finishReason: 'stop' });
        assert.deepStrictEqual(await waitingB, { completionText: '2;', finishReason: 'stop' });
        await Promise.all([queuedA, queuedB]);
    });

    test('a stream can be canceled after another document becomes active', async () => {
        const manager = new AsyncCompletionsManager();
        let finishA!: (value: AsyncCompletionResult) => void;
        let finishB!: (value: AsyncCompletionResult) => void;
        let canceledA = false;
        const queuedA = manager.queueCompletionRequest('a', 'const a = ', '', {
            cancel() { canceledA = true; },
        }, new Promise(resolve => { finishA = resolve; }), 'scope-a', 'file-a');
        const waitingA = manager.getFirstMatchingRequest('a-new', 'const a = x', '', undefined, 'scope-a', undefined, 'file-a');
        const queuedB = manager.queueCompletionRequest('b', 'const b = ', '', { cancel() {} },
            new Promise(resolve => { finishB = resolve; }), 'scope-b', 'file-b');
        const waitingB = manager.getFirstMatchingRequest('b', 'const b = ', '', undefined, 'scope-b', undefined, 'file-b');

        manager.updateCompletion('a', 'wrong');
        assert.strictEqual(canceledA, true);
        assert.strictEqual(await waitingA, undefined);
        finishA({ completionText: 'wrong', finishReason: 'stop' });
        finishB({ completionText: '2;', finishReason: 'stop' });
        assert.deepStrictEqual(await waitingB, { completionText: '2;', finishReason: 'stop' });
        await Promise.all([queuedA, queuedB]);
    });

    test('a canceled stale request cannot return after settling late', async () => {
        const manager = new AsyncCompletionsManager();
        let finish!: (value: AsyncCompletionResult) => void;
        let canceled = false;
        const result = new Promise<AsyncCompletionResult>(resolve => { finish = resolve; });
        const queued = manager.queueCompletionRequest('old', 'const a = ', '', {
            cancel() { canceled = true; },
        }, result, 'old-scope', 'file-a');
        const waiting = manager.getFirstMatchingRequest('old', 'const a = ', '', undefined, 'old-scope', undefined, 'file-a');
        assert.strictEqual(await manager.getFirstMatchingRequest('new', 'const a = ', '', 20, 'new-scope', undefined, 'file-a'), undefined);
        assert.strictEqual(canceled, true);
        assert.strictEqual(await waiting, undefined);
        finish({ completionText: 'stale;', finishReason: 'stop' });
        await queued;
        assert.strictEqual(manager.shouldWaitForAsyncCompletions('const a = ', '', 'old-scope'), false);
    });

    test('clearing pending requests releases waiters and ignores late responses', async () => {
        const manager = new AsyncCompletionsManager();
        let finish!: (value: AsyncCompletionResult) => void;
        let canceled = false;
        const result = new Promise<AsyncCompletionResult>(resolve => { finish = resolve; });
        const queued = manager.queueCompletionRequest('old', 'prefix', '', {
            cancel() { canceled = true; },
        }, result, 'scope-a', 'file-a');
        const waiting = manager.getFirstMatchingRequest('old', 'prefix', '', undefined, 'scope-a', undefined, 'file-a');
        manager.clear();
        assert.strictEqual(canceled, true);
        assert.strictEqual(await waiting, undefined);
        finish({ completionText: 'answer', finishReason: 'stop' });
        await queued;
        assert.strictEqual(manager.shouldWaitForAsyncCompletions('prefix', '', 'scope-a'), false);
    });

    test('does not reuse an in-flight request from another source scope', async () => {
        const manager = new AsyncCompletionsManager();
        let complete!: (value: AsyncCompletionResult) => void;
        const pending = new Promise<AsyncCompletionResult>(resolve => { complete = resolve; });
        const queued = manager.queueCompletionRequest('file-a', 'const value = ', '', { cancel() {} }, pending, 'file-a:model-a');
        assert.strictEqual(manager.shouldWaitForAsyncCompletions('const value = ', '', 'file-b:model-a'), false);
        assert.strictEqual(manager.shouldWaitForAsyncCompletions('const value = ', '', 'file-a:model-a'), true);
        complete({ completionText: 'fromA', finishReason: 'stop' });
        await queued;
        assert.strictEqual(await manager.getFirstMatchingRequest('file-b', 'const value = ', '', 20, 'file-b:model-a'), undefined);
        assert.deepStrictEqual(await manager.getFirstMatchingRequest('file-a-next', 'const value = ', '', 20, 'file-a:model-a'), {
            completionText: 'fromA', finishReason: 'stop',
        });
    });

    test('returns immediately when no candidate remains', async () => {
        const manager = new AsyncCompletionsManager();
        assert.strictEqual(await manager.getFirstMatchingRequest('new', 'prefix', ''), undefined);
        assert.strictEqual(manager.hasActiveWaiters(), false);
    });

    test('a timed-out reused request does not block a later completion', async () => {
        const manager = new AsyncCompletionsManager();
        let complete!: (value: AsyncCompletionResult) => void;
        const pending = new Promise<AsyncCompletionResult>(resolve => { complete = resolve; });
        const queued = manager.queueCompletionRequest('old', 'services:\n  web:', '', { cancel() {} }, pending);
        const start = Date.now();
        assert.strictEqual(await manager.getFirstMatchingRequest('new', 'services:\n  web:', '', 20), undefined);
        assert.ok(Date.now() - start < 1000);
        assert.strictEqual(manager.hasActiveWaiters(), false);

        complete({ completionText: '\n    image: nginx', finishReason: 'stop' });
        await queued;
        assert.deepStrictEqual(await manager.getFirstMatchingRequest('later', 'services:\n  web:', ''), {
            completionText: '\n    image: nginx', finishReason: 'stop',
        });
        assert.strictEqual(manager.hasActiveWaiters(), false);
    });

    test('a live pending request still resolves within the reuse window', async () => {
        const manager = new AsyncCompletionsManager();
        let complete!: (value: AsyncCompletionResult) => void;
        const pending = new Promise<AsyncCompletionResult>(resolve => { complete = resolve; });
        const queued = manager.queueCompletionRequest('old', 'const value = ', '', { cancel() {} }, pending);
        const reused = manager.getFirstMatchingRequest('new', 'const value = ', '', 200);
        complete({ completionText: '42;', finishReason: 'stop' });
        assert.deepStrictEqual(await reused, { completionText: '42;', finishReason: 'stop' });
        await queued;
        assert.strictEqual(manager.hasActiveWaiters(), false);
    });

    test('a canceled editor waiter exits while its pending request remains reusable', async () => {
        const manager = new AsyncCompletionsManager();
        let complete!: (value: AsyncCompletionResult) => void;
        const pending = new Promise<AsyncCompletionResult>(resolve => { complete = resolve; });
        const queued = manager.queueCompletionRequest('old', 'services:\n  web:', '', { cancel() {} }, pending);
        const controller = new AbortController();
        const waiting = manager.getFirstMatchingRequest('old', 'services:\n  web:', '', undefined, '', controller.signal);
        assert.strictEqual(manager.hasActiveWaiters(), true);
        controller.abort();
        assert.strictEqual(await waiting, undefined);
        assert.strictEqual(manager.hasActiveWaiters(), false);
        complete({ completionText: '\n    image: nginx', finishReason: 'stop' });
        await queued;
        assert.deepStrictEqual(await manager.getFirstMatchingRequest('next', 'services:\n  web:', ''), {
            completionText: '\n    image: nginx', finishReason: 'stop',
        });
    });

    test('waiters for another request do not keep a canceled request alive', async () => {
        const manager = new AsyncCompletionsManager();
        let finishFirst!: (value: AsyncCompletionResult) => void;
        let finishSecond!: (value: AsyncCompletionResult) => void;
        const firstResult = new Promise<AsyncCompletionResult>(resolve => { finishFirst = resolve; });
        const secondResult = new Promise<AsyncCompletionResult>(resolve => { finishSecond = resolve; });
        const secondQueued = manager.queueCompletionRequest('second', 'const value = ', '', { cancel() {} }, secondResult);
        const secondWait = manager.getFirstMatchingRequest('second', 'const value = ', '');
        const firstQueued = manager.queueCompletionRequest('first', 'const value = ', '', { cancel() {} }, firstResult);
        const controller = new AbortController();
        const firstWait = manager.getFirstMatchingRequest('first', 'const value = ', '', undefined, '', controller.signal);

        assert.strictEqual(manager.hasActiveWaiters('first'), true);
        assert.strictEqual(manager.hasActiveWaiters('second'), true);
        controller.abort();
        assert.strictEqual(await firstWait, undefined);
        assert.strictEqual(manager.hasActiveWaiters('first'), false);
        assert.strictEqual(manager.hasActiveWaiters('second'), true);

        finishFirst({ completionText: '1;', finishReason: 'stop' });
        finishSecond({ completionText: '2;', finishReason: 'stop' });
        assert.deepStrictEqual(await secondWait, { completionText: '2;', finishReason: 'stop' });
        await Promise.all([firstQueued, secondQueued]);
        assert.strictEqual(manager.hasActiveWaiters(), false);
    });

    test('a partial stream rejects a newly typed prefix that conflicts with it', async () => {
        const manager = new AsyncCompletionsManager();
        let complete!: (value: AsyncCompletionResult) => void;
        let canceled = false;
        const pending = new Promise<AsyncCompletionResult>(resolve => { complete = resolve; });
        const queued = manager.queueCompletionRequest('old', 'services:\n  web:', '', {
            cancel() { canceled = true; },
        }, pending);
        manager.updateCompletion('old', '\n    image: nginx');
        assert.strictEqual(manager.shouldWaitForAsyncCompletions('services:\n  web:x', ''), false);
        assert.strictEqual(await manager.getFirstMatchingRequest('new', 'services:\n  web:x', '', 20), undefined);
        assert.strictEqual(canceled, true);
        complete({ completionText: '\n    image: nginx', finishReason: 'stop' });
        await queued;
    });

    test('a user typing ahead of a YAML newline keeps the compatible stream', async () => {
        const manager = new AsyncCompletionsManager();
        let complete!: (value: AsyncCompletionResult) => void;
        let canceled = false;
        const pending = new Promise<AsyncCompletionResult>(resolve => { complete = resolve; });
        const queued = manager.queueCompletionRequest('old', 'services:\n  web:', '', {
            cancel() { canceled = true; },
        }, pending, 'yaml-scope', 'compose.yaml');
        manager.updateCompletion('old', '\n');
        const typedPrefix = 'services:\n  web:\n    ';
        assert.strictEqual(manager.shouldWaitForAsyncCompletions(typedPrefix, '', 'yaml-scope'), true);
        const reused = manager.getFirstMatchingRequest('new', typedPrefix, '', 200, 'yaml-scope', undefined, 'compose.yaml');
        manager.updateCompletion('old', '\n    image:');
        complete({ completionText: '\n    image: nginx', finishReason: 'stop' });
        assert.deepStrictEqual(await reused, { completionText: 'image: nginx', finishReason: 'stop' });
        assert.strictEqual(canceled, false);
        await queued;
    });
});
