import * as assert from 'assert';
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { isEligibleForInlineCompletion, isUnavailableForInlineCompletion, shouldSkipAutomaticCompletionOnMeteredConnection } from '../../completions/shared/documentEligibility';

suite('Document eligibility', () => {
    test('metered connection detection does not require the proposed API grant', () => {
        assert.doesNotThrow(() => shouldSkipAutomaticCompletionOnMeteredConnection(
            vscode.InlineCompletionTriggerKind.Automatic,
        ));
        assert.strictEqual(shouldSkipAutomaticCompletionOnMeteredConnection(
            vscode.InlineCompletionTriggerKind.Invoke,
        ), false);
    });

    test('skips VS Code chat input even when a provider is invoked explicitly', () => {
        const document = { uri: vscode.Uri.parse('vscode-chat-input:/copilot') } as vscode.TextDocument;
        assert.strictEqual(isEligibleForInlineCompletion(document), false);
        assert.strictEqual(isEligibleForInlineCompletion(document, true), false);
    });

    test('respects the editor inline suggestion switch', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = 1;',
        });
        const config = vscode.workspace.getConfiguration('editor.inlineSuggest', {
            uri: document.uri, languageId: document.languageId,
        });
        const previous = config.inspect<boolean>('enabled')?.globalLanguageValue;
        try {
            await config.update('enabled', false, vscode.ConfigurationTarget.Global, true);
            assert.strictEqual(isEligibleForInlineCompletion(document), false);
            assert.strictEqual(isUnavailableForInlineCompletion(document), false);
        } finally {
            await config.update('enabled', previous, vscode.ConfigurationTarget.Global, true);
        }
    });

    test('keeps file exclusions distinct from disabled language suggestions', async () => {
        const document = {
            uri: vscode.Uri.file(path.join(os.tmpdir(), 'cc-menu-excluded.ts')),
            languageId: 'typescript',
        } as vscode.TextDocument;
        const config = vscode.workspace.getConfiguration('localalot', document.uri);
        const previousExclude = config.inspect<string[]>('exclude')?.globalValue;
        const previousEnable = config.inspect<Record<string, boolean>>('enable')?.globalValue;
        try {
            await config.update('exclude', ['**/cc-menu-excluded.ts'], vscode.ConfigurationTarget.Global);
            await config.update('enable', { '*': false }, vscode.ConfigurationTarget.Global);
            assert.strictEqual(isUnavailableForInlineCompletion(document), true);
            assert.strictEqual(isEligibleForInlineCompletion(document), false);
        } finally {
            await config.update('exclude', previousExclude, vscode.ConfigurationTarget.Global);
            await config.update('enable', previousEnable, vscode.ConfigurationTarget.Global);
        }
    });
});
