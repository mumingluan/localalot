import * as assert from 'assert';
import * as vscode from 'vscode';
import { getEditDiffHistory } from '../../completions/nes/diffHistoryForPrompt';
import { StringText } from '../../completions/nes/stubs/abstractText';
import { OffsetRange } from '../../completions/nes/stubs/offsetRange';
import { StringEdit, StringReplacement } from '../../completions/nes/stubs/stringEdit';
import { DocumentId, IXtabHistoryEditEntry } from '../../completions/nes/stubs/types';

suite('NES edit history prompt', () => {
    test('keeps the newest diffs while presenting them oldest to newest without extra headings', () => {
        const docId = DocumentId.create(vscode.Uri.file('nes-diff-history.ts').toString());
        const entry = (before: string, after: string): IXtabHistoryEditEntry => ({
            kind: 'edit', docId,
            edit: {
                base: new StringText(before),
                edit: StringEdit.single(new StringReplacement(new OffsetRange(0, before.length), after)),
            },
        });
        const result = getEditDiffHistory(
            { id: docId },
            [entry('const middle = 2;', 'const newest = 3;'), entry('const oldest = 1;', 'const middle = 2;')],
            new Set([docId]),
            text => text.length,
            { onlyForDocsInPrompt: true, maxTokens: 10_000, nEntries: 2, useRelativePaths: false },
        );

        assert.strictEqual(result.nDiffs, 2);
        assert.ok(result.promptPiece.indexOf('-const oldest = 1;') < result.promptPiece.indexOf('-const middle = 2;'));
        assert.ok(result.promptPiece.startsWith('--- '));
        assert.ok(result.promptPiece.endsWith('\n'));
        assert.ok(!result.promptPiece.includes('# Edit '));
    });
});
