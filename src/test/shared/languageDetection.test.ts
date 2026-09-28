import * as assert from 'assert';
import * as vscode from 'vscode';
import { detectLanguage } from '../../completions/shared/languageDetection';

suite('Native filename language detection', () => {
    const examples: Array<[string, string]> = [
        ['test.ts', 'typescript'], ['test.h', 'cpp'], ['test.c', 'cpp'],
        ['test.yml', 'yaml'], ['test.yml.njk', 'yaml'], ['test.blade.php', 'blade'],
        ['tsconfig.json', 'jsonc'], ['settings.json', 'jsonc'],
        ['Dockerfile.local', 'dockerfile'], ['test.unknown', 'plaintext'],
    ];
    for (const [name, expected] of examples) {
        test(`detects ${name}`, () => {
            const document = { uri: vscode.Uri.file(`C:/project/${name}`), languageId: 'plaintext' };
            assert.strictEqual(detectLanguage(document).languageId, expected);
        });
    }

    test('keeps the editor language for untitled and notebook documents', () => {
        assert.strictEqual(detectLanguage({ uri: vscode.Uri.parse('untitled:Untitled-1'), languageId: 'typescript' }).languageId, 'typescript');
        assert.strictEqual(detectLanguage({ uri: vscode.Uri.parse('vscode-notebook-cell:/cell'), languageId: 'python' }).languageId, 'python');
        assert.strictEqual(detectLanguage({ uri: vscode.Uri.parse('untitled:Untitled-2'), languageId: 'c' }).languageId, 'cpp');
    });

    test('keeps the original template suffix in the file extension', () => {
        assert.strictEqual(detectLanguage({ uri: vscode.Uri.file('C:/project/config.yaml.njk'), languageId: 'plaintext' }).fileExtension, '.yaml.njk');
    });
});
