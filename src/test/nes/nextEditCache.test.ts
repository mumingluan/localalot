import * as assert from 'assert';
import * as vscode from 'vscode';
import { NextEditCache, CachedEdit } from '../../completions/nes/nextEditCache';
import { DocumentId } from '../../completions/nes/stubs/types';

suite('NextEditCache', () => {
    const atLine0 = { line: 0, character: 0 };

    test('limits a no-edit hit to the unchanged snapshot and reduced cursor window', () => {
        const cache = new NextEditCache();
        const docId = DocumentId.create('empty-result.ts');
        const source = Array.from({ length: 12 }, (_, line) => `line ${line}`).join('\n');
        cache.setNoNextEdit(docId, source, { startLine: 1, endLineExclusive: 9 }, 4);

        assert.strictEqual(cache.lookupNoNextEdit(docId, { getText: () => source }, { line: 4 }), true);
        assert.strictEqual(cache.lookupNoNextEdit(docId, { getText: () => source }, { line: 1 }), false);
        assert.strictEqual(cache.lookupNoNextEdit(docId, { getText: () => `${source}\nchanged` }, { line: 4 }), false);
        cache.clear(docId);
        assert.strictEqual(cache.lookupNoNextEdit(docId, { getText: () => source }, { line: 4 }), false);
    });

    test('uses compact keys for large Unicode snapshots without reusing changed content', () => {
        const cache = new NextEditCache();
        const docId = DocumentId.create('large-snapshot.ts');
        const source = 'const value = "😀";\n'.repeat(5000);
        cache.setNoNextEdit(docId, source, { startLine: 0, endLineExclusive: 4 }, 1);
        const keys = (cache as unknown as { _noEditCache: Map<string, unknown> })._noEditCache;
        assert.ok([...keys.keys()][0].length < 256);
        assert.ok(cache.getNoNextEdit(docId, { getText: () => source }, { line: 1 }));
        assert.strictEqual(cache.getNoNextEdit(docId, { getText: () => source + '!' }, { line: 1 }), undefined);
    });

    test('keeps cursor prediction pending until the outcome is recorded', () => {
        const cache = new NextEditCache();
        const docId = DocumentId.create('pending-cursor.ts');
        const source = 'first\nsecond\nthird';
        const promptPieces = { currentDocument: {} } as never;
        cache.setNoNextEdit(docId, source, { startLine: 0, endLineExclusive: 3 }, 1, promptPieces, 2);
        const pending = cache.getNoNextEdit(docId, { getText: () => source }, { line: 1 });
        assert.strictEqual(pending?.predictionComplete, false);
        assert.strictEqual(pending?.promptPieces, promptPieces);
        assert.strictEqual(cache.getNoNextEdit(docId, { getText: () => source }, { line: 0 }), undefined);
        assert.strictEqual(cache.getNoNextEdit(docId, { getText: () => source }, { line: 1, character: 3 }), undefined);

        const jump = { uri: 'file:///next.ts', line: 0, character: 0, targetDocumentText: 'target' };
        cache.markNoNextEditPredictionComplete(docId, source, 1, jump, 2);
        const completed = cache.getNoNextEdit(docId, { getText: () => source }, { line: 1 });
        assert.strictEqual(completed?.predictionComplete, true);
        assert.strictEqual(completed?.promptPieces, undefined);
        assert.deepStrictEqual(completed?.jump, jump);
        cache.setNoNextEdit(docId, source, { startLine: 0, endLineExclusive: 3 }, 1, promptPieces);
        assert.deepStrictEqual(cache.getNoNextEdit(docId, { getText: () => source }, { line: 1 })?.jump, jump);
    });

    test('invalidates a no-edit answer after an open context document changes', async () => {
        const active = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const result = calculateTax(invoice);',
        });
        const neighbor = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'export function calculateTax() { return 1; }',
        });
        const cache = new NextEditCache();
        const docId = DocumentId.create(active.uri.toString());
        cache.setNoNextEdit(docId, active.getText(), { startLine: 0, endLineExclusive: 1 }, 0);
        assert.ok(cache.getNoNextEdit(docId, active, atLine0));

        const edit = new vscode.WorkspaceEdit();
        edit.insert(neighbor.uri, new vscode.Position(0, neighbor.lineAt(0).text.length), ' // changed');
        assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
        assert.strictEqual(cache.getNoNextEdit(docId, active, atLine0), undefined);
    });

    function makeEdit(docId: DocumentId, docText: string, edit: string, editWindow?: { startLine: number; endLineExclusive: number }): CachedEdit {
        return {
            docId,
            documentBeforeEdit: docText,
            editWindow: editWindow || { startLine: 0, endLineExclusive: 5 },
            edit,
            cacheTime: Date.now(),
        };
    }

    test('invalidates a cached edit after an open context document changes', async () => {
        const active = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const result = calculateTax(invoice);',
        });
        const neighbor = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'export function calculateTax() { return 1; }',
        });
        const cache = new NextEditCache();
        const docId = DocumentId.create(active.uri.toString());
        cache.setKthNextEdit(docId, makeEdit(docId, active.getText(), 'const result = 1;', {
            startLine: 0, endLineExclusive: 1,
        }));
        assert.ok(cache.lookupNextEdit(docId, active, atLine0));

        const edit = new vscode.WorkspaceEdit();
        edit.insert(neighbor.uri, new vscode.Position(0, neighbor.lineAt(0).text.length), ' // changed');
        assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
        assert.strictEqual(cache.lookupNextEdit(docId, active, atLine0), undefined);
    });

    test('should cache and retrieve edit when cursor is within edit window', () => {
        const cache = new NextEditCache();
        const docId = DocumentId.create('test.ts');
        const docText = 'line1\nline2';
        const edit = makeEdit(docId, docText, 'new content');
        cache.setKthNextEdit(docId, edit);

        const found = cache.lookupNextEdit(docId, { getText: () => docText }, atLine0);
        assert.ok(found);
        assert.strictEqual(found!.edit, 'new content');
    });

    test('should return undefined when cursor is outside edit window', () => {
        const cache = new NextEditCache();
        const docId = DocumentId.create('test.ts');
        const docText = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8';
        // Cache an edit for cursor around line 2-7
        const edit = makeEdit(docId, docText, 'new content', { startLine: 2, endLineExclusive: 7 });
        cache.setKthNextEdit(docId, edit);

        // Cursor at line 0 — outside window
        const found = cache.lookupNextEdit(docId, { getText: () => docText }, { line: 0 });
        assert.strictEqual(found, undefined);
    });

    test('should return undefined for cache miss (different doc)', () => {
        const cache = new NextEditCache();
        const f1 = DocumentId.create('f1');
        const f2 = DocumentId.create('f2');
        cache.setKthNextEdit(f1, makeEdit(f1, 'text1', 'edit1'));
        const found = cache.lookupNextEdit(f2, { getText: () => 'text1' }, atLine0);
        assert.strictEqual(found, undefined);
    });

    test('should clear cache for specific doc', () => {
        const cache = new NextEditCache();
        const f1 = DocumentId.create('f1');
        cache.setKthNextEdit(f1, makeEdit(f1, 'text', 'edit1'));
        cache.clear(f1);
        assert.strictEqual(cache.lookupNextEdit(f1, { getText: () => 'text' }, atLine0), undefined);
    });

    test('should evict oldest entry when total limit exceeded', () => {
        const cache = new NextEditCache();
        const firstEntry = makeEdit(DocumentId.create('doc0'), 'text000', 'edit0');
        const firstKey = JSON.stringify([firstEntry.docId.uri, 'text000']);
        // Insert 51 entries — first should be evicted
        // Manually set at first position by inserting first entry first
        cache.setKthNextEdit(firstEntry.docId, firstEntry);
        for (let i = 1; i <= 50; i++) {
            const docId = DocumentId.create(`doc${i}`);
            cache.setKthNextEdit(docId, makeEdit(docId, `text${i}`, `edit${i}`));
        }
        // First entry should be evicted
        const foundOld = cache.lookupNextEdit(firstEntry.docId, { getText: () => 'text000' }, atLine0);
        assert.strictEqual(foundOld, undefined);
        // Last entry should still exist
        const lastDocId = DocumentId.create('doc50');
        const foundNew = cache.lookupNextEdit(lastDocId, { getText: () => 'text50' }, atLine0);
        assert.ok(foundNew);
    });

    test('should miss cache when document changed below the edit position', () => {
        // Simulates: edit at line 2 → NES caches → edit at line 4 below → NES at line 2 again
        const cache = new NextEditCache();
        const docId = DocumentId.create('test.ts');

        // Step 1: edit at line 2, cache an edit
        const docBeforeBelowEdit = 'line1\nline2_EDIT\nline3\nline4\nline5';
        const edit = makeEdit(docId, docBeforeBelowEdit, 'suggested fix', { startLine: 1, endLineExclusive: 3 });
        cache.setKthNextEdit(docId, edit);

        // Step 2: user edits below (line 4), document text changes
        const docAfterBelowEdit = 'line1\nline2_EDIT\nline3\nline4_MODIFIED\nline5';

        // Step 3: NES triggered at line 2 again — should MISS cache because document changed below
        const found = cache.lookupNextEdit(docId, { getText: () => docAfterBelowEdit }, { line: 1 });
        assert.strictEqual(found, undefined, 'should miss cache when document changed below');
    });

    test('should miss cache when document changed above the edit position', () => {
        // Simulates: edit at line 4 → NES caches → edit at line 1 above → NES at line 4 again
        const cache = new NextEditCache();
        const docId = DocumentId.create('test.ts');

        const docBefore = 'line1\nline2\nline3\nline4_EDIT\nline5';
        const edit = makeEdit(docId, docBefore, 'suggested fix', { startLine: 3, endLineExclusive: 5 });
        cache.setKthNextEdit(docId, edit);

        const docAfter = 'line1_MODIFIED\nline2\nline3\nline4_EDIT\nline5';

        const found = cache.lookupNextEdit(docId, { getText: () => docAfter }, { line: 3 });
        assert.strictEqual(found, undefined, 'should miss cache when document changed above');
    });

    test('should HIT cache when document text is identical (same position)', () => {
        // When user reverts all changes, document text matches cached state — legitimate hit
        const cache = new NextEditCache();
        const docId = DocumentId.create('test.ts');
        const docText = 'line1\nline2\nline3\nline4\nline5';

        const edit = makeEdit(docId, docText, 'suggested fix', { startLine: 1, endLineExclusive: 3 });
        cache.setKthNextEdit(docId, edit);

        const found = cache.lookupNextEdit(docId, { getText: () => docText }, { line: 1 });
        assert.ok(found, 'should hit cache when document text is identical');
        assert.strictEqual(found!.edit, 'suggested fix');
    });

    test('does not resurrect an explicitly rejected cached edit', () => {
        const cache = new NextEditCache();
        const docId = DocumentId.create('rejected.ts');
        const docText = 'line1\nline2\nline3';
        const entry = makeEdit(docId, docText, 'replacement', { startLine: 1, endLineExclusive: 2 });
        entry.rejected = true;
        cache.setKthNextEdit(docId, entry);
        assert.strictEqual(cache.lookupNextEdit(docId, { getText: () => docText }, { line: 1 }), undefined);
    });

    test('rebased rejection suppresses the same edit but allows changed content', () => {
        const cache = new NextEditCache();
        const docId = DocumentId.create('rejected-rebase.ts');
        const before = 'start\nreturn value;\nend';
        const entry = makeEdit(docId, before, 'return value;', { startLine: 1, endLineExclusive: 2 });
        entry.rejected = true;
        entry.rejectedEdit = entry.edit;
        cache.setKthNextEdit(docId, entry);

        const typedPrefix = 'start\nreturn val\nend';
        assert.strictEqual(cache.lookupNextEdit(docId, { getText: () => typedPrefix }, { line: 1 }), undefined);

        const changed = makeEdit(docId, before, 'return another;', { startLine: 1, endLineExclusive: 2 });
        changed.rejected = true;
        changed.rejectedEdit = 'return value;';
        cache.setKthNextEdit(docId, changed);
        const changedDoc = 'start\nreturn ano\nend';
        const found = cache.lookupNextEdit(docId, { getText: () => changedDoc }, { line: 1 });
        assert.ok(found);
        assert.strictEqual(found!.edit, 'return another;');
    });

    test('keeps a cached suggestion inside its window when cursor distance checking is off', () => {
        const cache = new NextEditCache();
        const docId = DocumentId.create('distance-default.ts');
        const docText = ['0', '1', '2', '3', '4', '5', '6'].join('\n');
        cache.setKthNextEdit(docId, {
            ...makeEdit(docId, docText, 'replacement', { startLine: 1, endLineExclusive: 6 }),
            cursorLineAtCacheTime: 2,
        });
        assert.ok(cache.lookupNextEdit(docId, { getText: () => docText }, { line: 5 }));
    });

    test('rejects a cached suggestion after the cursor moves farther when the check is enabled', () => {
        const cache = new NextEditCache(true);
        const docId = DocumentId.create('distance.ts');
        const docText = ['0', '1', '2', '3', '4', '5', '6'].join('\n');
        cache.setKthNextEdit(docId, {
            ...makeEdit(docId, docText, 'replacement', { startLine: 1, endLineExclusive: 6 }),
            cursorLineAtCacheTime: 2,
        });
        assert.ok(cache.lookupNextEdit(docId, { getText: () => docText }, { line: 2 }));
        assert.strictEqual(cache.lookupNextEdit(docId, { getText: () => docText }, { line: 5 }), undefined);
        assert.strictEqual(cache.lookupNextEdit(docId, { getText: () => docText }, { line: 2 }), undefined);
    });

    test('recently used snapshots survive shared-cache eviction', () => {
        const cache = new NextEditCache();
        const activeId = DocumentId.create('lru-active.ts');
        cache.setKthNextEdit(activeId, makeEdit(activeId, 'active', 'suggested'));
        for (let index = 0; index < 49; index++) {
            const id = DocumentId.create(`lru-${index}.ts`);
            cache.setKthNextEdit(id, makeEdit(id, `old-${index}`, 'edit'));
        }
        assert.ok(cache.lookupNextEdit(activeId, { getText: () => 'active' }, atLine0));
        const newestId = DocumentId.create('lru-new.ts');
        cache.setKthNextEdit(newestId, makeEdit(newestId, 'new', 'edit'));
        assert.ok(cache.lookupNextEdit(activeId, { getText: () => 'active' }, atLine0));
        const oldestId = DocumentId.create('lru-0.ts');
        assert.strictEqual(cache.lookupNextEdit(oldestId, { getText: () => 'old-0' }, atLine0), undefined);
    });

    test('rebases a cached window when the user inserts a blank line inside it', () => {
        const cache = new NextEditCache();
        const docId = DocumentId.create('test.ts');
        const before = 'start\nalpha\nbeta\nend';
        cache.setKthNextEdit(docId, makeEdit(docId, before, 'alpha\nbeta', { startLine: 1, endLineExclusive: 3 }));
        const after = 'start\nalpha\n\nbeta\nend';
        const found = cache.lookupNextEdit(docId, { getText: () => after }, { line: 2 });
        assert.ok(found);
        assert.strictEqual(found!.edit, 'alpha\nbeta');
        assert.strictEqual(found!.rebasedEdit, 'alpha\n\nbeta');
        assert.strictEqual(found!.editWindow.startLine, 1);
        assert.strictEqual(found!.editWindow.endLineExclusive, 4);
    });

    test('keeps a trailing blank line and user indentation in a rebased window', () => {
        const cache = new NextEditCache();
        const docId = DocumentId.create('insert-and-indent.ts');
        const before = 'start\n    oldCall()\n    nextCall()\nend';
        cache.setKthNextEdit(docId, makeEdit(docId, before, '    newCall()\n    nextCall()', {
            startLine: 1, endLineExclusive: 3,
        }));

        const after = 'start\n\toldCall()\n\tnextCall()\n\nend';
        const found = cache.lookupNextEdit(docId, { getText: () => after }, { line: 2 });
        assert.strictEqual(found?.rebasedEdit, '\tnewCall()\n\tnextCall()\n');
    });

    test('does not rebase a blank-line insertion when user and model indentation conflicts', () => {
        const cache = new NextEditCache();
        const docId = DocumentId.create('insert-indent-conflict.ts');
        const before = 'start\n    oldCall()\n    nextCall()\nend';
        cache.setKthNextEdit(docId, makeEdit(docId, before, '        newCall()\n    nextCall()', {
            startLine: 1, endLineExclusive: 3,
        }));

        const after = 'start\n\toldCall()\n\tnextCall()\n\nend';
        assert.strictEqual(cache.lookupNextEdit(docId, { getText: () => after }, { line: 2 }), undefined);
    });

    test('preserves cached line insertions and deletions after an unrelated document change', () => {
        for (const target of ['oldA\noldC', 'oldA\ninserted\noldB\noldC']) {
            const cache = new NextEditCache();
            const docId = DocumentId.create(`line-count-${target.length}.ts`);
            const beforeLines = [
                ...Array.from({ length: 10 }, (_, index) => `prefix${index}`),
                'oldA', 'oldB', 'oldC', 'tail0', 'tail1', 'tail2',
            ];
            const before = beforeLines.join('\n');
            cache.setKthNextEdit(docId, makeEdit(docId, before, target, { startLine: 10, endLineExclusive: 13 }));
            const afterLines = [...beforeLines];
            afterLines[0] = 'changed far above the window';
            const found = cache.lookupNextEdit(docId, { getText: () => afterLines.join('\n') }, { line: 11 });
            assert.ok(found, target);
            assert.strictEqual(found.rebasedEdit, target);
        }
    });

    test('does not replay a line-count-changing edit over changed window text', () => {
        const cache = new NextEditCache();
        const docId = DocumentId.create('line-count-conflict.ts');
        const beforeLines = [
            ...Array.from({ length: 10 }, (_, index) => `prefix${index}`),
            'oldA', 'oldB', 'oldC', 'tail0', 'tail1', 'tail2',
        ];
        cache.setKthNextEdit(docId, makeEdit(docId, beforeLines.join('\n'), 'oldA\noldC', {
            startLine: 10, endLineExclusive: 13,
        }));
        const afterLines = [...beforeLines];
        afterLines[10] = 'oldA typed';
        assert.strictEqual(cache.lookupNextEdit(docId, { getText: () => afterLines.join('\n') }, { line: 11 }), undefined);
    });

    test('keeps a cached edit when the user types a prefix of the target line', () => {
        const cache = new NextEditCache();
        const docId = DocumentId.create('test.ts');
        const before = 'start\nreturn value;\nend';
        cache.setKthNextEdit(docId, makeEdit(docId, before, 'return value;', { startLine: 1, endLineExclusive: 2 }));
        const after = 'start\nreturn val\nend';
        const found = cache.lookupNextEdit(docId, { getText: () => after }, { line: 1 });
        assert.ok(found);
        assert.strictEqual(found!.edit, 'return value;');
        assert.ok(found!.rebasedEdit);
    });

    test('preserves a user indentation change while rebasing a cached replacement', () => {
        const cache = new NextEditCache();
        const docId = DocumentId.create('indent.ts');
        const before = 'start\n    oldCall()\nend';
        cache.setKthNextEdit(docId, makeEdit(docId, before, '    newCall()', { startLine: 1, endLineExclusive: 2 }));

        const after = 'start\n\toldCall()\nend';
        const found = cache.lookupNextEdit(docId, { getText: () => after }, { line: 1 });
        assert.strictEqual(found?.rebasedEdit, '\tnewCall()');
    });

    test('regenerates when the model and user both change indentation', () => {
        const cache = new NextEditCache();
        const docId = DocumentId.create('indent-conflict.ts');
        const before = 'start\n    oldCall()\nend';
        cache.setKthNextEdit(docId, makeEdit(docId, before, '        newCall()', { startLine: 1, endLineExclusive: 2 }));

        const after = 'start\n\toldCall()\nend';
        assert.strictEqual(cache.lookupNextEdit(docId, { getText: () => after }, { line: 1 }), undefined);
    });

    test('does not choose between ambiguous rebased cache entries', () => {
        const cache = new NextEditCache();
        const docId = DocumentId.create('test.ts');
        const first = 'start\nalpha\nend';
        const second = 'prefix\nstart\nalpha\nend';
        cache.setKthNextEdit(docId, makeEdit(docId, first, 'alpha-one', { startLine: 1, endLineExclusive: 2 }));
        cache.setKthNextEdit(docId, makeEdit(docId, second, 'alpha-two\nend', { startLine: 2, endLineExclusive: 4 }));
        const found = cache.lookupNextEdit(docId, { getText: () => 'prefix\nstart\nalpha\n\nend' }, { line: 3 });
        assert.strictEqual(found, undefined);
    });

    test('same-file cursor jump cache serves both cursor windows', () => {
        const cache = new NextEditCache(true);
        const docId = DocumentId.create('cursor-jump.ts');
        const docText = Array.from({ length: 12 }, (_, index) => `line${index}`).join('\n');
        const edit: CachedEdit = {
            ...makeEdit(docId, docText, 'updated', { startLine: 8, endLineExclusive: 10 }),
            originalEditWindow: { startLine: 1, endLineExclusive: 3 },
            cursorLineAtCacheTime: 8,
        };
        cache.setKthNextEdit(docId, edit);
        const document = { getText: () => docText };

        assert.strictEqual(cache.lookupNextEdit(docId, document, { line: 1 }), edit);
        assert.strictEqual(cache.lookupNextEdit(docId, document, { line: 8 }), edit);
        assert.strictEqual(cache.lookupNextEdit(docId, document, { line: 5 }), undefined);
    });

    test('rebases a same-file cursor jump while the source window is unchanged', () => {
        const cache = new NextEditCache();
        const docId = DocumentId.create('rebased-cursor-jump.ts');
        const lines = ['source()', 'source tail',
            ...Array.from({ length: 8 }, (_, index) => `gap${index}`),
            'oldTarget()', 'target tail', 'after0', 'after1', 'after2'];
        const before = lines.join('\n');
        cache.setKthNextEdit(docId, {
            ...makeEdit(docId, before, 'newTarget()\ntarget tail', { startLine: 10, endLineExclusive: 12 }),
            originalEditWindow: { startLine: 0, endLineExclusive: 2 },
            targetPosition: { line: 10, character: 2 },
        });

        const changed = [...lines];
        changed.splice(4, 0, 'new unrelated line');
        const document = { getText: () => changed.join('\n') };
        const found = cache.lookupNextEdit(docId, document, { line: 0 });
        assert.ok(found);
        assert.deepStrictEqual(found.editWindow, { startLine: 11, endLineExclusive: 13 });
        assert.deepStrictEqual(found.targetPosition, { line: 11, character: 2 });
        assert.strictEqual(found.rebasedEdit, 'newTarget()\ntarget tail');

        changed[0] = 'different source()';
        assert.strictEqual(cache.lookupNextEdit(docId, document, { line: 0 }), undefined);
    });

    test('keeps cross-file cache entries anchored to the owner document', () => {
        const cache = new NextEditCache();
        const owner = DocumentId.create('owner.ts');
        const target = DocumentId.create('target.ts');
        const entry: CachedEdit = {
            docId: owner,
            documentBeforeEdit: 'const request = true;',
            editWindow: { startLine: 0, endLineExclusive: 1 },
            edit: 'export const result = true;',
            cacheTime: Date.now(),
            targetDocId: target,
            targetDocumentBeforeEdit: 'export const result = false;',
            targetEditWindow: { startLine: 0, endLineExclusive: 1 },
            targetPosition: { line: 0, character: 0 },
        };
        cache.setKthNextEdit(owner, entry);

        const found = cache.lookupNextEdit(owner, { getText: () => entry.documentBeforeEdit }, { line: 0 });
        assert.strictEqual(found?.targetDocId, target);
        assert.strictEqual(found?.targetDocumentBeforeEdit, 'export const result = false;');

        // Target changes invalidate the association when the workflow checks
        // the stored target snapshot; clearing either side must also remove it.
        cache.clear(target);
        assert.strictEqual(cache.lookupNextEdit(owner, { getText: () => entry.documentBeforeEdit }, { line: 0 }), undefined);
    });
});
