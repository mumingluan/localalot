import * as assert from 'assert';
import * as vscode from 'vscode';
import { RejectedEditHistory } from '../../completions/nes/rejectedEditHistory';

suite('NES rejected edit history', () => {
    test('suppresses the same network edit after unrelated text shifts its range', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'header\nconst value = 1;\ntail' });
        const history = new RejectedEditHistory();
        const range = new vscode.Range(1, 0, 1, 16);
        history.reject(document, range, 'const value = 2;');
        history.applyChanges(document.uri.toString(), [{
            range: new vscode.Range(0, 0, 0, 0),
            rangeOffset: 0,
            rangeLength: 0,
            text: '// note\n',
        }]);
        const updated = await vscode.workspace.openTextDocument({ language: 'typescript', content: '// note\nheader\nconst value = 1;\ntail' });
        // Use the original URI with the updated text to model a document edit.
        const view = { ...updated, uri: document.uri, offsetAt: updated.offsetAt.bind(updated) } as vscode.TextDocument;
        assert.strictEqual(history.isRejected(view, new vscode.Range(2, 0, 2, 16), 'const value = 2;'), true);
        assert.strictEqual(history.isRejected(view, new vscode.Range(2, 0, 2, 16), 'const value = 3;'), false);
    });

    test('releases a rejection when the edited range changes', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = 1;' });
        const history = new RejectedEditHistory();
        const range = new vscode.Range(0, 0, 0, 16);
        history.reject(document, range, 'const value = 2;');
        history.applyChanges(document.uri.toString(), [{
            range: new vscode.Range(0, 14, 0, 15),
            rangeOffset: 14,
            rangeLength: 1,
            text: '3',
        }]);
        assert.strictEqual(history.isRejected(document, range, 'const value = 2;'), false);
    });

    test('keeps a rejection when text is inserted immediately after its half-open range', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = 1;\ntail' });
        const history = new RejectedEditHistory();
        const range = new vscode.Range(0, 0, 0, 16);
        history.reject(document, range, 'const value = 2;');
        history.applyChanges(document.uri.toString(), [{
            range: new vscode.Range(0, 16, 0, 16),
            rangeOffset: 16,
            rangeLength: 0,
            text: ' // note',
        }]);
        const updated = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = 1; // note\ntail' });
        const view = { ...updated, uri: document.uri, offsetAt: updated.offsetAt.bind(updated) } as vscode.TextDocument;
        assert.strictEqual(history.isRejected(view, range, 'const value = 2;'), true);
    });
});
