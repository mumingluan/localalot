import * as assert from 'assert';
import * as vscode from 'vscode';
import { buildSelectedCompletionContext } from '../../completions/ghost/virtualDocument';
import { selectedCompletionPreview } from '../../completions/ghost/selectedCompletionPreview';
import { shouldRespectSelectedCompletionInfo } from '../../completions/ghost/ghostTextProvider';

suite('Ghost selected completion context', () => {
    test('follows quick suggestions unless explicitly configured', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = ' });
        const editorConfig = vscode.workspace.getConfiguration('editor');
        const completionConfig = vscode.workspace.getConfiguration('localalot');
        const previousQuickSuggestions = editorConfig.inspect('quickSuggestions')?.globalValue;
        const previousRespectSelected = completionConfig.inspect('respectSelectedCompletionInfo')?.globalValue;
        try {
            await completionConfig.update('respectSelectedCompletionInfo', undefined, vscode.ConfigurationTarget.Global);
            await editorConfig.update('quickSuggestions',
                { other: 'off', comments: 'off', strings: 'off' }, vscode.ConfigurationTarget.Global);
            assert.strictEqual(shouldRespectSelectedCompletionInfo(document.uri), true);
            await editorConfig.update('quickSuggestions',
                { other: 'on', comments: 'off', strings: 'off' }, vscode.ConfigurationTarget.Global);
            assert.strictEqual(shouldRespectSelectedCompletionInfo(document.uri), false);
            await completionConfig.update('respectSelectedCompletionInfo', true, vscode.ConfigurationTarget.Global);
            assert.strictEqual(shouldRespectSelectedCompletionInfo(document.uri), true);
            await editorConfig.update('quickSuggestions',
                { other: 'off', comments: 'off', strings: 'off' }, vscode.ConfigurationTarget.Global);
            await completionConfig.update('respectSelectedCompletionInfo', false, vscode.ConfigurationTarget.Global);
            assert.strictEqual(shouldRespectSelectedCompletionInfo(document.uri), false);
        } finally {
            await completionConfig.update('respectSelectedCompletionInfo', previousRespectSelected,
                vscode.ConfigurationTarget.Global);
            await editorConfig.update('quickSuggestions', previousQuickSuggestions, vscode.ConfigurationTarget.Global);
        }
    });

    test('moves the virtual prefix past the full selected IntelliSense range', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript',
            content: 'const value = oldName.tail',
        });
        const start = document.lineAt(0).text.indexOf('oldName');
        const position = new vscode.Position(0, start + 'old'.length);
        const selectedCompletionInfo: vscode.SelectedCompletionInfo = {
            range: new vscode.Range(0, start, 0, document.lineAt(0).text.length),
            text: 'newName',
        };
        const context = buildSelectedCompletionContext(document, position, selectedCompletionInfo);
        assert.strictEqual(context?.prefix, 'const value = newName');
        assert.strictEqual(context?.suffix, '');
        assert.deepStrictEqual(context?.position, new vscode.Position(0, 'const value = newName'.length));
    });

    test('keeps same-line closing text in the FIM suffix', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'run(hel);' });
        const position = new vscode.Position(0, 'run(hel'.length);
        const selected: vscode.SelectedCompletionInfo = {
            range: new vscode.Range(0, 4, 0, 7), text: 'helper',
        };
        const context = buildSelectedCompletionContext(document, position, selected);
        assert.strictEqual(context?.prefix, 'run(helper');
        assert.strictEqual(context?.suffix, ');');
    });

    test('does not inject snippet-like function text into the model prefix', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript',
            content: 'const value = hel();',
        });
        const position = new vscode.Position(0, 'const value = hel'.length);
        const start = new vscode.Position(0, 'const value = '.length);
        const selectedCompletionInfo: vscode.SelectedCompletionInfo = {
            range: new vscode.Range(start, position),
            text: 'hello(value)',
        };
        const context = buildSelectedCompletionContext(document, position, selectedCompletionInfo);
        assert.strictEqual(context, undefined);
    });

    test('inline preview uses the native whole-line replacement range', () => {
        const position = new vscode.Position(0, 7);
        const selected: vscode.SelectedCompletionInfo = {
            range: new vscode.Range(0, 4, 0, 7), text: 'helper',
        };
        const preview = selectedCompletionPreview(selected, position, 'run(', '(value)');
        assert.deepStrictEqual(preview?.range, new vscode.Range(0, 0, 0, 7));
        assert.strictEqual(preview?.text, 'run(helper(value)');
        const withSuffix = selectedCompletionPreview(selected, position, 'run(', ', option);', 2);
        assert.deepStrictEqual(withSuffix?.range, new vscode.Range(0, 0, 0, 9));
        assert.strictEqual(withSuffix?.text, 'run(helper, option);');
    });

    test('ignores a selected range unrelated to the caret', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'oldName.tail' });
        const selected: vscode.SelectedCompletionInfo = {
            range: new vscode.Range(0, 0, 0, 7), text: 'newName',
        };
        assert.strictEqual(buildSelectedCompletionContext(document, new vscode.Position(0, 12), selected), undefined);
        assert.strictEqual(selectedCompletionPreview(selected, new vscode.Position(0, 12), '', '(value)'), undefined);
    });
});
