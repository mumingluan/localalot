import * as assert from 'assert';
import * as vscode from 'vscode';
import { NesHistoryTracker } from '../../../completions/nes/core/nesHistoryTracker';
import { DocumentId } from '../../../completions/nes/stubs/types';

suite('NES history tracker', () => {
    test('does not treat a background document as fully viewed', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: Array(200).fill('const value = 1;').join('\n'),
        });
        assert.ok(!vscode.window.visibleTextEditors.some(editor => editor.document.uri.toString() === document.uri.toString()));

        const tracker = new NesHistoryTracker();
        try {
            const history = tracker.getHistory(DocumentId.create('file:///unrelated.ts'));
            assert.ok(!history.some(entry => entry.docId.uri === document.uri.toString()));
        } finally {
            tracker.dispose();
        }
    });
});
