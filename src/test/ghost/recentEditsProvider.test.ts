import * as assert from 'assert';
import * as vscode from 'vscode';
import { RecentEditsProvider } from '../../completions/ghost/recentEditsProvider';

suite('RecentEditsProvider', () => {
    test('records workspace changes after registration', async () => {
        const provider = new RecentEditsProvider({ debug() {} } as never);
        const subscription = provider.register();
        try {
            const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: '' });
            const editor = await vscode.window.showTextDocument(document);
            await editor.edit(edit => edit.insert(new vscode.Position(0, 0), 'const total = 42;'));
            await new Promise(resolve => setTimeout(resolve, 550));
            assert.ok(provider.recentEdits.some(edit => edit.includes('const total = 42;')));
        } finally {
            subscription.dispose();
        }
    });

    test('merges rapid replacements in a newly opened file against its original text', async () => {
        const provider = new RecentEditsProvider({ debug() {} } as never);
        const subscription = provider.register();
        try {
            const document = await vscode.workspace.openTextDocument({
                language: 'typescript', content: 'const total = 1;\nuse(total);',
            });
            const editor = await vscode.window.showTextDocument(document);
            await editor.edit(edit => edit.replace(new vscode.Range(0, 14, 0, 15), '2'));
            await editor.edit(edit => edit.replace(new vscode.Range(0, 14, 0, 15), '3'));
            await new Promise(resolve => setTimeout(resolve, 550));
            const edits = provider.recentEdits;
            assert.strictEqual(edits.length, 1);
            assert.ok(edits[0].includes('@@'));
            assert.ok(edits[0].includes('-const total = 1; --- IGNORE ---'));
            assert.ok(edits[0].includes('+const total = 3;'));
            assert.ok(edits[0].indexOf('+const total = 3;') < edits[0].indexOf('-const total = 1;'));
            assert.ok(edits[0].includes(' use(total);'));
            assert.ok(edits[0].includes('--- a/'));
            assert.ok(edits[0].includes('+++ b/'));
        } finally {
            subscription.dispose();
        }
    });

    test('keeps distant changes as separate recent edits', async () => {
        const provider = new RecentEditsProvider({ debug() {} } as never);
        const subscription = provider.register();
        try {
            const document = await vscode.workspace.openTextDocument({
                language: 'typescript', content: [
                    'const first = 1;', 'line one', 'line two', 'line three', 'line four', 'const last = 1;',
                ].join('\n'),
            });
            const editor = await vscode.window.showTextDocument(document);
            await editor.edit(edit => edit.replace(new vscode.Range(0, 14, 0, 15), '2'));
            await editor.edit(edit => edit.replace(new vscode.Range(5, 13, 5, 14), '3'));
            await new Promise(resolve => setTimeout(resolve, 550));
            assert.strictEqual(provider.recentEdits.length, 2);
            assert.ok(provider.recentEdits[0].includes('+const first = 2;'));
            assert.ok(provider.recentEdits[1].includes('+const last = 3;'));
        } finally {
            subscription.dispose();
        }
    });

    test('omits nearby active-file edits while keeping distant and other-file edits', async () => {
        const provider = new RecentEditsProvider({ debug() {} } as never);
        const subscription = provider.register();
        try {
            const lines = Array.from({ length: 140 }, (_, index) => `const value${index} = 1;`);
            const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: lines.join('\n') });
            const editor = await vscode.window.showTextDocument(document);
            await editor.edit(edit => edit.replace(new vscode.Range(0, 15, 0, 16), '2'));
            await editor.edit(edit => edit.replace(new vscode.Range(130, 17, 130, 18), '3'));
            await new Promise(resolve => setTimeout(resolve, 550));
            assert.strictEqual(provider.recentEdits.length, 2);
            const nearStart = provider.getRecentEditsFor(document, new vscode.Position(0, 0));
            assert.strictEqual(nearStart.length, 1);
            assert.ok(nearStart[0].includes('value130'));
            const nearEnd = provider.getRecentEditsFor(document, new vscode.Position(130, 0));
            assert.strictEqual(nearEnd.length, 1);
            assert.ok(nearEnd[0].includes('value0'));
            const other = await vscode.workspace.openTextDocument({ language: 'typescript', content: '' });
            assert.strictEqual(provider.getRecentEditsFor(other, new vscode.Position(0, 0)).length, 2);
        } finally {
            subscription.dispose();
        }
    });

    test('rebases an earlier edit after lines are inserted above it', async () => {
        const provider = new RecentEditsProvider({ debug() {} } as never);
        const subscription = provider.register();
        try {
            const lines = Array.from({ length: 140 }, (_, index) => `const value${index} = 1;`);
            const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: lines.join('\n') });
            const editor = await vscode.window.showTextDocument(document);
            await editor.edit(edit => edit.replace(new vscode.Range(130, 17, 130, 18), '2'));
            await new Promise(resolve => setTimeout(resolve, 550));
            await editor.edit(edit => edit.insert(new vscode.Position(0, 0), 'header\n'.repeat(120)));
            await new Promise(resolve => setTimeout(resolve, 550));
            assert.strictEqual(provider.recentEdits.length, 1);
            assert.ok(provider.recentEdits[0].includes('@@ -248,7 +248,7 @@'), provider.recentEdits[0]);
            assert.ok(provider.getRecentEditsFor(document, new vscode.Position(130, 0))
                .some(edit => edit.includes('value130')));
            assert.ok(!provider.getRecentEditsFor(document, new vscode.Position(250, 0))
                .some(edit => edit.includes('value130')));
        } finally {
            subscription.dispose();
        }
    });

    test('drops an old hunk after a later edit replaces the same line', async () => {
        const provider = new RecentEditsProvider({ debug() {} } as never);
        const subscription = provider.register();
        try {
            const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = 1;' });
            const editor = await vscode.window.showTextDocument(document);
            await editor.edit(edit => edit.replace(new vscode.Range(0, 14, 0, 15), '2'));
            await new Promise(resolve => setTimeout(resolve, 550));
            await editor.edit(edit => edit.replace(new vscode.Range(0, 14, 0, 15), '3'));
            await new Promise(resolve => setTimeout(resolve, 550));
            assert.strictEqual(provider.recentEdits.length, 1);
            assert.ok(provider.recentEdits[0].includes('+const value = 3;'));
        } finally {
            subscription.dispose();
        }
    });
});
