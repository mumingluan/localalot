import * as assert from 'assert';
import {
    EmptyEditFilter,
    NoopEditFilter,
    WhitespaceOnlyFilter,
    EditFilterChain,
} from '../../../completions/nes/response/editFilterChain';

suite('EmptyEditFilter', () => {
    test('rejects empty edit', () => {
        const filter = new EmptyEditFilter();
        assert.strictEqual(filter.shouldReject([''], ['a']), true);
    });

    test('rejects whitespace-only edit', () => {
        const filter = new EmptyEditFilter();
        assert.strictEqual(filter.shouldReject(['  ', '\t'], ['a']), true);
    });

    test('accepts non-empty edit', () => {
        const filter = new EmptyEditFilter();
        assert.strictEqual(filter.shouldReject(['code'], ['a']), false);
    });
});

suite('NoopEditFilter', () => {
    test('rejects identical edit', () => {
        const filter = new NoopEditFilter();
        assert.strictEqual(filter.shouldReject(['a', 'b'], ['a', 'b']), true);
    });

    test('accepts different content', () => {
        const filter = new NoopEditFilter();
        assert.strictEqual(filter.shouldReject(['a', 'changed'], ['a', 'b']), false);
    });

    test('accepts different length', () => {
        const filter = new NoopEditFilter();
        assert.strictEqual(filter.shouldReject(['a'], ['a', 'b']), false);
    });
});

suite('WhitespaceOnlyFilter', () => {
    test('rejects whitespace-only change', () => {
        const filter = new WhitespaceOnlyFilter();
        assert.strictEqual(
            filter.shouldReject(['  hello  '], ['hello']),
            true,
        );
    });

    test('allows interior spacing changes by default', () => {
        const chain = new EditFilterChain();
        assert.strictEqual(chain.apply(['const value = 1;'], ['const value  =  1;']), 'const value = 1;');
    });

    test('accepts actual content change', () => {
        const filter = new WhitespaceOnlyFilter();
        assert.strictEqual(
            filter.shouldReject(['new code'], ['old code']),
            false,
        );
    });
});

suite('EditFilterChain', () => {
    test('returns edit text when all filters pass', () => {
        const chain = new EditFilterChain();
        const result = chain.apply(['new code'], ['old code']);
        assert.strictEqual(result, 'new code');
    });

    test('returns undefined when empty edit', () => {
        const chain = new EditFilterChain();
        const result = chain.apply(['  '], ['old code']);
        assert.strictEqual(result, undefined);
    });

    test('returns undefined on noop edit', () => {
        const chain = new EditFilterChain();
        const result = chain.apply(['same'], ['same']);
        assert.strictEqual(result, undefined);
    });

    test('keeps a substantive line with an interior whitespace-only change', () => {
        const chain = new EditFilterChain();
        const result = chain.apply(['hello  world'], ['hello world']);
        assert.strictEqual(result, 'hello  world');
    });

    test('keeps a substantive comment-only change', () => {
        const chain = new EditFilterChain();
        const result = chain.apply(['// explain the next step'], ['// old note']);
        assert.strictEqual(result, '// explain the next step');
    });

    test('custom filters can be injected', () => {
        let called = false;
        const customFilter = {
            name: 'test',
            shouldReject: () => { called = true; return false; },
        };
        const chain = new EditFilterChain([customFilter]);
        chain.apply(['code'], ['old']);
        assert.strictEqual(called, true);
    });
});
