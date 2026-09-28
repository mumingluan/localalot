import * as assert from 'assert';
import * as vscode from 'vscode';
import { EditResultAssembler } from '../../../completions/nes/core/editResultAssembler';
import { EditWindowResolver } from '../../../completions/nes/core/editWindowResolver';
import { NesWorkflow } from '../../../completions/nes/core/nesWorkflow';
import { NextEditCache } from '../../../completions/nes/nextEditCache';
import { DocumentId } from '../../../completions/nes/stubs/types';

suite('NES consecutive edit cache', () => {
    test('reuses a same-file predicted edit from the original cursor window', async () => {
        const lines = Array.from({ length: 12 }, (_, index) => `line ${index}`);
        lines[8] = 'const value = 1;';
        const doc = await vscode.workspace.openTextDocument({ language: 'typescript', content: lines.join('\n') });
        const docId = DocumentId.create(doc.uri.toString());
        const cache = new NextEditCache();
        const config = { enabled: true, revision: 0, suffixOverlapThreshold: 1, suffixOverlapType: 'high' };
        const log = { info() {}, debug() {}, error() {} };
        const workflow = new NesWorkflow(config as never, {} as never, log as never, cache);
        try {
            const entry = {
                docId, documentBeforeEdit: doc.getText(),
                editWindow: { startLine: 8, endLineExclusive: 9 },
                edit: 'const value = 2;', cacheTime: Date.now(),
            };
            cache.setKthNextEdit(docId, entry);
            const result = new EditResultAssembler(new EditWindowResolver()).assemble(
                ['const value = 2;'], doc, new vscode.Position(8, 0), entry,
                1, 'high', undefined, { start: 8, endExclusive: 9 },
            );
            workflow.cacheSameFileCursorJumpEdit(doc, { startLine: 1, endLineExclusive: 3 },
                new vscode.Position(8, 0), result);

            const fromOriginal = await workflow.execute(doc, new vscode.Position(1, 0), true);
            assert.strictEqual(fromOriginal.editResult?.range.start.line, 8);
            assert.strictEqual(fromOriginal.editResult?.cursorPrediction?.kind, 'sameFile');
            const atTarget = await workflow.execute(doc, new vscode.Position(8, 0), true);
            assert.strictEqual(atTarget.editResult?.range.start.line, 8);
            assert.strictEqual(atTarget.editResult?.cursorPrediction, undefined);
        } finally {
            workflow.dispose();
        }
    });

    test('rebases a cached window after an unrelated edit above it', async () => {
        const cache = new NextEditCache();
        const doc = await vscode.workspace.openTextDocument({ language: 'typescript', content: [
            'header', 'target one', 'target two', 'tail',
        ].join('\n') });
        const docId = DocumentId.create(doc.uri.toString());
        cache.setKthNextEdit(docId, {
            docId,
            documentBeforeEdit: doc.getText(),
            editWindow: { startLine: 1, endLineExclusive: 3 },
            edit: 'target changed one\ntarget changed two',
            cacheTime: Date.now(),
        });
        const shifted = ['new header', 'header', 'target one', 'target two', 'tail'].join('\n');
        const rebased = cache.lookupNextEdit(docId, { getText: () => shifted }, { line: 2 });
        assert.strictEqual(rebased?.editWindow.startLine, 2);
        assert.strictEqual(rebased?.isFromSpeculativeRequest, true);
    });

    test('preserves a suggestion after the user types its prefix', async () => {
        const cache = new NextEditCache();
        const doc = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'value = ;\n' });
        const docId = DocumentId.create(doc.uri.toString());
        cache.setKthNextEdit(docId, {
            docId,
            documentBeforeEdit: doc.getText(),
            editWindow: { startLine: 0, endLineExclusive: 1 },
            edit: 'value = calculate();',
            cacheTime: Date.now(),
        });
        const typed = { getText: () => 'value = calculate(\n' };
        const rebased = cache.lookupNextEdit(docId, typed, { line: 0 });
        assert.strictEqual(rebased?.edit, 'value = calculate();');
    });

    test('accepting the first change exposes the next change', async () => {
        const original = [
            'const a = 1;', 'keep A', 'keep B', 'keep C',
            'const b = 2;', 'keep D', 'keep E', 'keep F',
        ].join('\n');
        const targetLines = [
            'const a = 10;', 'keep A', 'keep B', 'keep C',
            'const b = 20;', 'keep D', 'keep E', 'keep F',
        ];
        const doc = await vscode.workspace.openTextDocument({ language: 'typescript', content: original });
        const cache = new NextEditCache();
        const config = { suffixOverlapThreshold: 0.95, suffixOverlapType: 'high' };
        const log = { info() {}, debug() {}, error() {} };
        const workflow = new NesWorkflow(config as never, {} as never, log as never, cache);
        const assembler = new EditResultAssembler(new EditWindowResolver());
        const position = new vscode.Position(2, 0);
        const first = assembler.assemble([
            'const a = 10;', 'keep A', 'keep B', 'keep C',
            'const b = 2;', 'keep D', 'keep E', 'keep F',
        ], doc, position);

        const internal = workflow as unknown as {
            _stageFollowingEdit(document: vscode.TextDocument, text: string, window: { start: number; endExclusive: number }, lines: string[], result: typeof first): void;
            _buildResultFromCached(entry: NonNullable<ReturnType<NextEditCache['lookupNextEdit']>>, document: vscode.TextDocument, position: vscode.Position): typeof first;
        };
        internal._stageFollowingEdit(doc, original, { start: 0, endExclusive: 8 }, targetLines, first);
        const afterFirst = original.slice(0, doc.offsetAt(first.range.start)) + first.edit + original.slice(doc.offsetAt(first.range.end));
        assert.ok(afterFirst.includes('const a = 10;'));
        const cached = cache.lookupNextEdit(DocumentId.create(doc.uri.toString()), { getText: () => afterFirst }, { line: 4 });
        assert.ok(cached, 'the post-acceptance document should have a cached next edit');
        const updatedDoc = await vscode.workspace.openTextDocument({ language: 'typescript', content: afterFirst });
        const second = internal._buildResultFromCached(cached, updatedDoc, new vscode.Position(4, 0));
        const afterSecond = afterFirst.slice(0, updatedDoc.offsetAt(second.range.start)) + second.edit + afterFirst.slice(updatedDoc.offsetAt(second.range.end));
        assert.ok(afterSecond.includes('const b = 20;'));
    });

    test('keeps a later edit aligned when the first accepted edit inserts a line', async () => {
        const original = [
            'const a = 1;', 'keep A', 'keep B', 'keep C',
            'const b = 2;', 'keep D', 'keep E', 'keep F',
        ].join('\n');
        const targetLines = [
            'const a = 10;', 'const inserted = true;', 'keep A', 'keep B', 'keep C',
            'const b = 20;', 'keep D', 'keep E', 'keep F',
        ];
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: original });
        const cache = new NextEditCache();
        const workflow = new NesWorkflow(
            { suffixOverlapThreshold: 0.95, suffixOverlapType: 'high' } as never,
            {} as never,
            { info() {}, debug() {}, error() {} } as never,
            cache,
        );
        const first = new EditResultAssembler(new EditWindowResolver()).assemble(
            [
                'const a = 10;', 'const inserted = true;', 'keep A', 'keep B', 'keep C',
                'const b = 2;', 'keep D', 'keep E', 'keep F',
            ], document, new vscode.Position(0, 0),
            undefined, 0.95, 'high', undefined, { start: 0, endExclusive: 8 },
        );
        const internal = workflow as unknown as {
            _stageFollowingEdit(doc: vscode.TextDocument, text: string,
                window: { start: number; endExclusive: number }, lines: string[], result: typeof first): void;
            _buildResultFromCached(entry: NonNullable<ReturnType<NextEditCache['lookupNextEdit']>>,
                doc: vscode.TextDocument, position: vscode.Position): typeof first;
        };
        try {
            assert.ok(first.edits.length > 0);
            const afterFirst = original.slice(0, document.offsetAt(first.range.start))
                + first.edit + original.slice(document.offsetAt(first.range.end));
            assert.ok(afterFirst.includes('const inserted = true;'));
            assert.ok(afterFirst.includes('const b = 2;'));
            internal._stageFollowingEdit(document, original, { start: 0, endExclusive: 8 }, targetLines, first);
            const cached = cache.lookupNextEdit(DocumentId.create(document.uri.toString()),
                { getText: () => afterFirst }, { line: 5 });
            assert.ok(cached, 'the shifted document should have a cached later edit');
            const acceptedDocument = await vscode.workspace.openTextDocument({
                language: 'typescript', content: afterFirst,
            });
            const second = internal._buildResultFromCached(cached, acceptedDocument, new vscode.Position(5, 0));
            assert.strictEqual(second.range.start.line, 5);
            const afterSecond = afterFirst.slice(0, acceptedDocument.offsetAt(second.range.start))
                + second.edit + afterFirst.slice(acceptedDocument.offsetAt(second.range.end));
            assert.ok(afterSecond.includes('const b = 20;'));
        } finally {
            workflow.dispose();
        }
    });

    test('does not restage patches already accepted together in one inline edit', async () => {
        const original = 'const a = 1;\nkeep();\nconst b = 2;';
        const targetLines = ['const a = 10;', 'keep();', 'const b = 20;'];
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: original });
        const cache = new NextEditCache();
        const workflow = new NesWorkflow(
            { suffixOverlapThreshold: 0.95, suffixOverlapType: 'high' } as never,
            {} as never,
            { info() {}, debug() {}, error() {} } as never,
            cache,
        );
        try {
            const shown = new EditResultAssembler(new EditWindowResolver()).assemble(
                targetLines, document, new vscode.Position(0, 0),
                undefined, 0.95, 'high', undefined, { start: 0, endExclusive: 3 },
            );
            assert.strictEqual(shown.edits.length, 2);
            const afterAcceptance = original.slice(0, document.offsetAt(shown.range.start))
                + shown.edit + original.slice(document.offsetAt(shown.range.end));
            assert.strictEqual(afterAcceptance, targetLines.join('\n'));
            (workflow as unknown as {
                _stageFollowingEdit(doc: vscode.TextDocument, text: string,
                    window: { start: number; endExclusive: number }, lines: string[], result: typeof shown): void;
            })._stageFollowingEdit(document, original, { start: 0, endExclusive: 3 }, targetLines, shown);
            assert.strictEqual(cache.lookupNextEdit(DocumentId.create(document.uri.toString()),
                { getText: () => afterAcceptance }, { line: 2 }), undefined);
        } finally {
            workflow.dispose();
        }
    });

    test('does not stage a filtered import as the next suggestion', async () => {
        const original = [
            "import { oldName } from './module';", 'keep A', 'keep B',
            'const value = 1;', 'keep C', 'keep D',
        ].join('\n');
        const targetLines = [
            "import { newName } from './module';", 'keep A', 'keep B',
            'const value = 2;', 'keep C', 'keep D',
        ];
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: original });
        const cache = new NextEditCache();
        const workflow = new NesWorkflow(
            { suffixOverlapThreshold: 0.95, suffixOverlapType: 'high' } as never,
            {} as never,
            { info() {}, debug() {}, error() {} } as never,
            cache,
        );
        try {
            const first = new EditResultAssembler(new EditWindowResolver()).assemble(
                targetLines, document, new vscode.Position(3, 0),
                undefined, 0.95, 'high', undefined, { start: 0, endExclusive: 6 },
            );
            const internal = workflow as unknown as {
                _stageFollowingEdit(doc: vscode.TextDocument, text: string,
                    window: { start: number; endExclusive: number }, lines: string[], result: typeof first): void;
            };
            internal._stageFollowingEdit(document, original, { start: 0, endExclusive: 6 }, targetLines, first);
            const afterFirst = original.slice(0, document.offsetAt(first.range.start))
                + first.edit + original.slice(document.offsetAt(first.range.end));
            assert.strictEqual(cache.lookupNextEdit(
                DocumentId.create(document.uri.toString()),
                { getText: () => afterFirst }, { line: 0 },
            ), undefined);
        } finally {
            workflow.dispose();
        }
    });
});
