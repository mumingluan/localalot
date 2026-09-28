import * as assert from 'assert';
import * as vscode from 'vscode';
import { allowImportChanges, allowWhitespaceOnlyChanges, filterLineEdits } from '../../../completions/nes/response/lineEditFilters';
import { LineReplacement } from '../../../completions/nes/response/lineReplacement';

suite('NES line edit filters', () => {
    test('reads a language-specific whitespace preference', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'key: value' });
        const config = vscode.workspace.getConfiguration('localalot.nes', {
            uri: document.uri, languageId: document.languageId,
        });
        const previous = config.inspect<boolean>('allowWhitespaceOnlyChanges')?.globalLanguageValue;
        try {
            await config.update('allowWhitespaceOnlyChanges', false, vscode.ConfigurationTarget.Global, true);
            assert.strictEqual(allowWhitespaceOnlyChanges(document), false);
        } finally {
            await config.update('allowWhitespaceOnlyChanges', previous, vscode.ConfigurationTarget.Global, true);
        }
    });
    test('reads a language-specific import preference', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'import { value } from "./module";' });
        const config = vscode.workspace.getConfiguration('localalot.nes', {
            uri: document.uri, languageId: document.languageId,
        });
        const previous = config.inspect<boolean>('allowImportChanges')?.globalLanguageValue;
        try {
            await config.update('allowImportChanges', false, vscode.ConfigurationTarget.Global, true);
            assert.strictEqual(allowImportChanges(document), false);
        } finally {
            await config.update('allowImportChanges', previous, vscode.ConfigurationTarget.Global, true);
        }
    });
    test('allows import edits by default and filters them when configured', () => {
        const original = ["import { oldName } from './module';", 'keep();', 'const value = 1;'];
        const importEdit = new LineReplacement(
            { startLineNumber: 1, endLineNumberExclusive: 2 },
            ["import { newName } from './module';"],
        );
        const codeEdit = new LineReplacement(
            { startLineNumber: 3, endLineNumberExclusive: 4 },
            ['const value = 2;'],
        );
        assert.deepStrictEqual(filterLineEdits([importEdit, codeEdit], original, 'typescript'), [importEdit, codeEdit]);
        assert.deepStrictEqual(filterLineEdits([importEdit, codeEdit], original, 'typescript', true, false), [codeEdit]);
    });

    test('allows interior whitespace changes and filters blank-line insertions', () => {
        const original = ['const value  = 1;', 'next();'];
        const spacing = new LineReplacement(
            { startLineNumber: 1, endLineNumberExclusive: 2 },
            ['const value = 1;'],
        );
        const blankInsertion = new LineReplacement(
            { startLineNumber: 2, endLineNumberExclusive: 2 },
            [''],
        );
        assert.deepStrictEqual(filterLineEdits([spacing, blankInsertion], original, 'typescript'), [spacing]);
        assert.deepStrictEqual(filterLineEdits([spacing, blankInsertion], original, 'typescript', false), []);
    });

    test('keeps line wrapping by default while still ignoring indentation-only edits', () => {
        const wrapped = new LineReplacement(
            { startLineNumber: 1, endLineNumberExclusive: 2 }, ['call(', '    argument);'],
        );
        assert.deepStrictEqual(filterLineEdits([wrapped], ['call(argument);'], 'typescript'), [wrapped]);
        assert.deepStrictEqual(filterLineEdits([wrapped], ['call(argument);'], 'typescript', false), []);
        const indentation = new LineReplacement(
            { startLineNumber: 1, endLineNumberExclusive: 2 }, ['    call();'],
        );
        assert.deepStrictEqual(filterLineEdits([indentation], ['call();'], 'typescript'), []);
    });

    test('preserves substantive comments and code changes', () => {
        const original = ['// old note', 'const value = 1;'];
        const comment = new LineReplacement(
            { startLineNumber: 1, endLineNumberExclusive: 2 },
            ['// explain new behavior'],
        );
        const code = new LineReplacement(
            { startLineNumber: 2, endLineNumberExclusive: 3 },
            ['const value = 2;'],
        );
        assert.deepStrictEqual(filterLineEdits([comment, code], original, 'typescript'), [comment, code]);
    });
    test('filters replacement of code with only blank lines', () => {
        const blankReplacement = new LineReplacement(
            { startLineNumber: 1, endLineNumberExclusive: 2 },
            [''],
        );
        assert.deepStrictEqual(filterLineEdits([blankReplacement], ['remove();'], 'typescript'), []);
    });
});
