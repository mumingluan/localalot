import * as assert from 'assert';
import * as vscode from 'vscode';
import { EditResultAssembler } from '../../../completions/nes/core/editResultAssembler';
import { EditWindowResolver } from '../../../completions/nes/core/editWindowResolver';
import { NextEditProvider } from '../../../completions/nes/nextEditProvider';
import { NextEditResult } from '../../../completions/nes/types';

suite('NES combined edit acceptance', () => {
    test('VS Code accepts every disjoint change in one inline edit item', async function () {
        this.timeout(12000);
        const content = 'const first = 1;\nkeep();\nconst second = 2;';
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content });
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        const cursor = new vscode.Position(0, 14);
        editor.selection = new vscode.Selection(cursor, cursor);
        const result = new EditResultAssembler(new EditWindowResolver()).assemble(
            ['const first = 10;', 'keep();', 'const second = 20;'],
            document, cursor, undefined, 0.99, 'high', undefined,
            { start: 0, endExclusive: 3 },
        );
        assert.strictEqual(result.edits.length, 2);
        const provider = new NextEditProvider(
            { createInstance: () => ({}) } as never,
            { enabled: true, eagernessSelection: 'medium', mimicGhostTextBehavior: false } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const list = (provider as unknown as {
            _toInlineItems(result: NextEditResult, doc: vscode.TextDocument,
                position: vscode.Position, requestId: string): vscode.InlineCompletionList;
        })._toInlineItems(result, document, cursor, 'combined-edit-acceptance');
        assert.strictEqual(list.items.length, 1);
        assert.strictEqual((list.items[0] as { isInlineEdit?: boolean }).isInlineEdit, true);
        let shown!: () => void;
        const shownPromise = new Promise<void>(resolve => { shown = resolve; });
        const wrappingProvider = {
            provideInlineCompletionItems: () => list,
            handleDidShowCompletionItem: () => shown(),
        };
        const registration = vscode.languages.registerInlineCompletionItemProvider(
            { scheme: 'untitled', language: 'typescript' }, wrappingProvider,
        );
        try {
            await vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
            await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    shownPromise,
                    new Promise<never>((_resolve, reject) => {
                        timeout = setTimeout(() => reject(new Error('combined NES item was not shown')), 5000);
                    }),
                ]);
            } finally {
                if (timeout) clearTimeout(timeout);
            }
            await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
            assert.strictEqual(document.getText(), 'const first = 10;\nkeep();\nconst second = 20;');
        } finally {
            registration.dispose();
        }
    });
});
