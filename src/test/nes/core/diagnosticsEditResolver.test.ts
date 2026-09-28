import * as assert from 'assert';
import * as vscode from 'vscode';
import { codeActionToNextEdit, resolveDiagnosticEdit } from '../../../completions/nes/diagnosticsEditResolver';
import { NextEditProvider } from '../../../completions/nes/nextEditProvider';
import { NesCompletionList, NextEditResult } from '../../../completions/nes/types';

suite('NES diagnostics inline edits', () => {
    test('converts one quick fix into a precise inline edit', async () => {
        const document = await vscode.workspace.openTextDocument({ content: 'const value = oldName;\n' });
        const range = new vscode.Range(0, 14, 0, 21);
        const action = new vscode.CodeAction('Replace identifier', vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, range, 'newName');

        const result = codeActionToNextEdit(action, document);
        assert.strictEqual(result?.edit, 'newName');
        assert.ok(result?.range.isEqual(range));
        assert.strictEqual(result?.displayLocation?.label, 'Replace identifier');
    });

    test('supports quick fixes that change more than one location', async () => {
        const document = await vscode.workspace.openTextDocument({ content: 'oldName + oldName\n' });
        const action = new vscode.CodeAction('Replace all', vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, new vscode.Range(0, 0, 0, 7), 'newName');
        action.edit.replace(document.uri, new vscode.Range(0, 10, 0, 17), 'newName');
        const result = codeActionToNextEdit(action, document);
        assert.ok(result);
        assert.strictEqual(result?.edits.length, 2);
    });

    test('offers an available diagnostic quick fix near the cursor', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'javascript', content: 'badName\n' });
        const range = new vscode.Range(0, 0, 0, 7);
        const diagnostic = new vscode.Diagnostic(range, 'Unknown name', vscode.DiagnosticSeverity.Error);
        const collection = vscode.languages.createDiagnosticCollection('nes-quick-fix-test');
        const provider = vscode.languages.registerCodeActionsProvider('javascript', {
            provideCodeActions: () => {
                const action = new vscode.CodeAction('Fix name', vscode.CodeActionKind.QuickFix);
                action.edit = new vscode.WorkspaceEdit();
                action.edit.replace(document.uri, range, 'goodName');
                action.isPreferred = true;
                return [action];
            },
        }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] });
        collection.set(document.uri, [diagnostic]);
        try {
            let result;
            for (let attempt = 0; attempt < 20; attempt++) {
                result = await resolveDiagnosticEdit(document, new vscode.Position(0, 0),
                    new vscode.CancellationTokenSource().token);
                if (result) break;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            assert.strictEqual(result?.edit, 'goodName');
        } finally {
            collection.dispose();
            provider.dispose();
        }
    });

    test('combines multiple edits from one quick fix into one inline preview', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const a = 1;\nconst b = 2;\n' });
        const action = new vscode.CodeAction('Fix both', vscode.CodeActionKind.QuickFix);
        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.replace(document.uri, new vscode.Range(0, 6, 0, 7), 'alpha');
        workspaceEdit.replace(document.uri, new vscode.Range(1, 6, 1, 7), 'beta');
        action.edit = workspaceEdit;

        const result = codeActionToNextEdit(action, document);
        assert.ok(result);
        assert.strictEqual(result?.edits.length, 2);
        assert.strictEqual(result?.range.start.line, 0);
        assert.strictEqual(result?.range.end.line, 1);
        assert.strictEqual(result?.edit, 'alpha = 1;\nconst beta');
    });

    test('keeps a quick-fix command for the native inline edit menu', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = oldName;\n' });
        const action = new vscode.CodeAction('Fix and organize imports', vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, new vscode.Range(0, 14, 0, 21), 'newName');
        action.command = { command: 'editor.action.organizeImports', title: 'Organize Imports' };
        const result = codeActionToNextEdit(action, document);
        assert.strictEqual(result?.action?.command, 'editor.action.organizeImports');
    });

    test('does not redisplay the same stale quick fix immediately after acceptance', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = badName;',
        });
        const range = new vscode.Range(0, 14, 0, 21);
        const makeEdit = (text: string): NextEditResult => ({
            range, edit: text, fullEditText: text, documentBeforeEdits: 'badName',
            edits: [{ replaceRange: range, newText: text }],
        });
        const provider = new NextEditProvider(
            { createInstance: () => ({}) } as never,
            { enabled: true, eagernessSelection: 'medium', mimicGhostTextBehavior: false } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const toItems = (edit: NextEditResult): NesCompletionList =>
            (provider as unknown as { _toInlineItems: (...args: unknown[]) => NesCompletionList })
                ._toInlineItems(edit, document, new vscode.Position(0, 22), 'request',
                    new vscode.Position(0, 22), document, 'diagnostic');
        const first = toItems(makeEdit('goodName'));
        assert.strictEqual(first.items.length, 1);
        provider.handleEndOfLifetime(first.items[0], { kind: 0 });
        assert.strictEqual(toItems(makeEdit('goodName')).items.length, 0);
        assert.strictEqual(toItems(makeEdit('otherName')).items.length, 1);
        (provider as unknown as { _recentlyAcceptedDiagnostic: { expires: number } })
            ._recentlyAcceptedDiagnostic.expires = Date.now() - 1;
        assert.strictEqual(toItems(makeEdit('goodName')).items.length, 1);
    });
});
