import * as assert from 'assert';
import { renderCompletionPrompt, toUniquePath } from '../../completions/nes/promptCraftingUtils';
import { DocumentId } from '../../completions/nes/stubs/types';

suite('toUniquePath', () => {
    test('compares Windows drive letters without changing the relative result', () => {
        const documentId = DocumentId.create('file:///C:/Project/src/main.ts');
        assert.strictEqual(toUniquePath(documentId, '/c:/Project'),
            process.platform === 'win32' ? 'src/main.ts' : documentId.path);
    });

    test('preserves a path outside the workspace root', () => {
        const documentId = DocumentId.create('file:///C:/Other/src/main.ts');
        assert.strictEqual(toUniquePath(documentId, '/c:/Project'), documentId.path);
    });
});

suite('renderCompletionPrompt', () => {

    const DEFAULT_TEMPLATE = [
        '<|im_start|>system',
        '{system}<|im_end|>',
        '<|im_start|>user',
        '{user}<|im_end|>',
        '<|im_start|>assistant',
        '',
        '',
    ].join('\n');

    test('replaces system and user placeholders', () => {
        const result = renderCompletionPrompt(DEFAULT_TEMPLATE, 'You are helpful', 'Hello');
        assert.ok(result.includes('You are helpful'));
        assert.ok(result.includes('Hello'));
        assert.ok(!result.includes('{system}'));
        assert.ok(!result.includes('{user}'));
    });

    test('returns template unchanged when no placeholders present', () => {
        const template = 'plain text with no placeholders';
        const result = renderCompletionPrompt(template, 'sys', 'usr');
        assert.strictEqual(result, template);
    });

    test('handles empty system and user', () => {
        const result = renderCompletionPrompt(DEFAULT_TEMPLATE, '', '');
        assert.ok(!result.includes('{system}'));
        assert.ok(!result.includes('{user}'));
    });

    test('preserves literal placeholders inside inserted content', () => {
        const result = renderCompletionPrompt(DEFAULT_TEMPLATE, 'literal {user}', 'literal {system}');
        assert.ok(result.includes('literal {user}<|im_end|>'));
        assert.ok(result.includes('literal {system}<|im_end|>'));
    });

    test('fills the user slot when system text contains a user placeholder', () => {
        const result = renderCompletionPrompt(DEFAULT_TEMPLATE, 'explain how to use {user}', 'Hello');
        assert.ok(result.includes('explain how to use {user}<|im_end|>'));
        assert.ok(result.includes('Hello<|im_end|>'));
    });

    test('keeps system placeholders in user text', () => {
        const result = renderCompletionPrompt(DEFAULT_TEMPLATE, 'You are helpful', 'explain the {system} concept');
        assert.ok(result.includes('explain the {system} concept'));
    });

    test('keeps replacement-like characters in both messages', () => {
        const result = renderCompletionPrompt('{system}|{user}', 'say $& and $\' here', 'show $` there');
        assert.strictEqual(result, 'say $& and $\' here|show $` there');
    });

    test('preserves trailing newlines from template', () => {
        const template = '{system}\n{user}\n\n';
        const result = renderCompletionPrompt(template, 'S', 'U');
        assert.strictEqual(result, 'S\nU\n\n');
    });
});
