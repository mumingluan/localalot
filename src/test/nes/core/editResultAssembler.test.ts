import * as assert from 'assert';
import * as vscode from 'vscode';
import { EditResultAssembler, trimLineEditSuffixOverlaps } from '../../../completions/nes/core/editResultAssembler';
import { EditWindowResolver } from '../../../completions/nes/core/editWindowResolver';
import { LineReplacement } from '../../../completions/nes/response/lineReplacement';

suite('NES edit result assembler', () => {
    test('keeps a progressive cursor-line replacement even when the next line matches', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'call();\ncall(extra);',
        });
        const assembler = new EditResultAssembler(new EditWindowResolver());
        const result = assembler.assemble(
            ['call(extra);'], document, new vscode.Position(0, 0),
            undefined, 1, 'high', undefined, { start: 0, endExclusive: 1 },
            { skipDuplicateAdditions: true },
        );
        const source = document.getText();
        const accepted = source.slice(0, document.offsetAt(result.range.start)) + result.edit
            + source.slice(document.offsetAt(result.range.end));
        assert.strictEqual(accepted, 'call(extra);\ncall(extra);');
        assert.strictEqual(result.edits.length, 1);
    });

    test('suffix dedup keeps the full old replacement range', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'old();\nremove();\n}',
        });
        const result = new EditResultAssembler(new EditWindowResolver()).assemble(
            ['new();', '}'], document, new vscode.Position(0, 0),
            undefined, 0.85, 'high', undefined, { start: 0, endExclusive: 2 },
        );
        const source = document.getText();
        const actual = source.slice(0, document.offsetAt(result.range.start)) + result.edit
            + source.slice(document.offsetAt(result.range.end));
        assert.strictEqual(actual, 'new();\n}');
        assert.strictEqual(result.fullEditText, 'new();');
    });

    test('suffix-only replacement deletes the old line', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'remove();\n}',
        });
        const result = new EditResultAssembler(new EditWindowResolver()).assemble(
            ['}'], document, new vscode.Position(0, 0),
            undefined, 0.85, 'high', undefined, { start: 0, endExclusive: 1 },
        );
        assert.strictEqual(result.edits.length, 1);
        const source = document.getText();
        const actual = source.slice(0, document.offsetAt(result.range.start)) + result.edit
            + source.slice(document.offsetAt(result.range.end));
        assert.strictEqual(actual, '}');
    });

    test('suffix-only insertion remains a no-op', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'keep();\n}',
        });
        const result = new EditResultAssembler(new EditWindowResolver()).assemble(
            ['keep();', '}'], document, new vscode.Position(0, 0),
            undefined, 0.85, 'high', undefined, { start: 0, endExclusive: 1 },
        );
        assert.deepStrictEqual(result.edits, []);
    });

    test('duplicate-only insertion does not suppress a later disjoint edit', () => {
        const lines = ['head', 'duplicate', 'keep one', 'keep two', 'old', 'tail'];
        const edits = trimLineEditSuffixOverlaps([
            new LineReplacement({ startLineNumber: 1, endLineNumberExclusive: 1 }, ['duplicate']),
            new LineReplacement({ startLineNumber: 4, endLineNumberExclusive: 5 }, ['new']),
        ], { lineCount: lines.length, lineText: index => lines[index] }, 0.99, 'high');

        assert.strictEqual(edits.length, 1);
        assert.deepStrictEqual(edits[0].newLines, ['new']);
        assert.strictEqual(edits[0].lineRange.startLineNumber, 4);
    });

    test('trims a secondary patch against the following document line', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript',
            content: ['const first = 1;', 'keep one', 'keep two', 'const second = 2;', 'tail'].join('\n'),
        });
        const result = new EditResultAssembler(new EditWindowResolver()).assemble([
            'const first = 10;', 'keep one', 'keep two', 'const second = 20;', 'tail',
        ], document, new vscode.Position(0, 0), undefined, 0.99, 'high', undefined,
        { start: 0, endExclusive: 4 });

        assert.strictEqual(result.edits.length, 2);
        assert.strictEqual(result.range.start.line, 0);
        assert.strictEqual(result.range.end.line, 3);
        assert.strictEqual(result.edits[1].newText, '0');
        const original = document.getText();
        const accepted = original.slice(0, document.offsetAt(result.range.start)) + result.edit
            + original.slice(document.offsetAt(result.range.end));
        assert.strictEqual(accepted, [
            'const first = 10;', 'keep one', 'keep two', 'const second = 20;', 'tail',
        ].join('\n'));
    });

    test('default exact matching preserves a similar but different following line', () => {
        const lines = ['old', 'following()'];
        const edits = trimLineEditSuffixOverlaps([
            new LineReplacement({ startLineNumber: 0, endLineNumberExclusive: 1 },
                ['changed()', 'following( )']),
        ], { lineCount: lines.length, lineText: index => lines[index] }, 1, 'high');

        assert.deepStrictEqual(edits[0].newLines, ['changed()', 'following( )']);
    });

    test('exact duplicate matching also removes copied prefix and middle context', () => {
        const lines = ['old', 'following()', 'second()', 'tail'];
        const source = { lineCount: lines.length, lineText: (index: number) => lines[index] };
        const range = { startLineNumber: 0, endLineNumberExclusive: 1 };
        const prefix = trimLineEditSuffixOverlaps([
            new LineReplacement(range, ['following()', 'fresh()']),
        ], source, 1, 'high');
        const middle = trimLineEditSuffixOverlaps([
            new LineReplacement(range, ['start()', 'following()', 'second()', 'end()']),
        ], source, 1, 'high');

        assert.deepStrictEqual(prefix[0].newLines, ['fresh()']);
        assert.deepStrictEqual(middle[0].newLines, ['start()', 'end()']);
    });

    test('exact matching removes a copied continuation longer than 100 lines', () => {
        const continuation = Array.from({ length: 101 }, (_, index) => `existing-${index}();`);
        const sourceLines = ['old();', ...continuation];
        const edits = trimLineEditSuffixOverlaps([
            new LineReplacement({ startLineNumber: 0, endLineNumberExclusive: 1 },
                ['new();', ...continuation]),
        ], { lineCount: sourceLines.length, lineText: index => sourceLines[index] }, 1, 'high');

        assert.deepStrictEqual(edits[0].newLines, ['new();']);
    });

    test('drops an unrelated import edit but keeps a separate code change', async () => {
        const original = [
            "import { oldName } from './module';",
            'keep one',
            'keep two',
            'const value = 1;',
            'keep three',
            'keep four',
        ];
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: original.join('\n'),
        });
        const response = [
            "import { newName } from './module';",
            'keep one',
            'keep two',
            'const value = 2;',
            'keep three',
            'keep four',
        ];
        const result = new EditResultAssembler(new EditWindowResolver()).assemble(
            response, document, new vscode.Position(3, 0), undefined, 0.99, 'high', undefined,
            { start: 0, endExclusive: original.length },
        );
        assert.strictEqual(result.edits.length, 1);
        assert.strictEqual(result.range.start.line, 3);
        assert.strictEqual(result.edit, '2');
    });

    test('deletes a complete non-final line without joining its neighbors', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'keep();\nremove();\nnext();',
        });
        const result = new EditResultAssembler(new EditWindowResolver()).assemble(
            [], document, new vscode.Position(1, 0), undefined, 0.99, 'high', undefined,
            { start: 1, endExclusive: 2 },
        );
        assert.strictEqual(result.edit, '');
        assert.strictEqual(result.edits.length, 1);
        assert.strictEqual(result.range.start.line, 1);
        assert.strictEqual(result.range.end.line, 2);
        assert.strictEqual(result.range.end.character, 0);
        const text = document.getText();
        assert.strictEqual(text.slice(0, document.offsetAt(result.range.start))
            + text.slice(document.offsetAt(result.range.end)), 'keep();\nnext();');
    });

    test('deletes a final line together with its preceding newline', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'keep();\nremove();',
        });
        const result = new EditResultAssembler(new EditWindowResolver()).assemble(
            [], document, new vscode.Position(1, 0), undefined, 0.99, 'high', undefined,
            { start: 1, endExclusive: 2 },
        );
        assert.strictEqual(result.edit, '');
        assert.strictEqual(result.edits.length, 1);
        const text = document.getText();
        assert.strictEqual(text.slice(0, document.offsetAt(result.range.start))
            + text.slice(document.offsetAt(result.range.end)), 'keep();');
    });

    test('accepts disjoint model edits through one inline replacement', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript',
            content: [
                'const first = 1;',
                'keep one',
                'keep two',
                'const second = 2;',
                'keep three',
                'keep four',
            ].join('\n'),
        });
        const assembler = new EditResultAssembler(new EditWindowResolver());
        const result = assembler.assemble([
            'const first = 10;',
            'keep one',
            'keep two',
            'const second = 20;',
            'keep three',
            'keep four',
        ], document, new vscode.Position(0, 0), undefined, 0.99, 'high', undefined, {
            start: 0,
            endExclusive: document.lineCount,
        });

        assert.strictEqual(result.edits.length, 2);
        assert.strictEqual(result.edits[0].newText, '0');
        assert.strictEqual(result.edits[1].newText, '0');
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, result.range, result.edit);
        assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
        assert.strictEqual(document.getText(), [
            'const first = 10;', 'keep one', 'keep two',
            'const second = 20;', 'keep three', 'keep four',
        ].join('\n'));
    });

    test('keeps CRLF while combining edits separated by unchanged lines', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript',
            content: 'const first = 1;\r\nkeep();\r\nconst second = 2;',
        });
        const result = new EditResultAssembler(new EditWindowResolver()).assemble(
            ['const first = 10;', 'keep();', 'const second = 20;'],
            document, new vscode.Position(0, 0), undefined, 0.99, 'high', undefined,
            { start: 0, endExclusive: 3 },
        );
        assert.strictEqual(result.edits.length, 2);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, result.range, result.edit);
        assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
        assert.strictEqual(document.getText(), 'const first = 10;\r\nkeep();\r\nconst second = 20;');
    });

    test('places cursor at the actual end of a partial multiline replacement', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript',
            content: ['const value = old;', 'next();'].join('\n'),
        });
        const assembler = new EditResultAssembler(new EditWindowResolver());
        const result = assembler.assemble(
            ['const value = newValue();'],
            document,
            new vscode.Position(0, 13),
            undefined,
            0.99,
            'high',
            undefined,
            { start: 0, endExclusive: 1 },
        );
        assert.deepStrictEqual(result.cursorAfterEdit, new vscode.Position(
            result.range.start.line, result.range.start.character + result.edit.length,
        ));
    });

    test('keeps unchanged line suffix outside a single-line replacement', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = foo();',
        });
        const assembler = new EditResultAssembler(new EditWindowResolver());
        const result = assembler.assemble(
            ['const value = foo(bar);'],
            document,
            new vscode.Position(0, 0),
            undefined,
            0.99,
            'high',
            undefined,
            { start: 0, endExclusive: 1 },
        );
        assert.strictEqual(result.range.isEmpty, true);
        assert.strictEqual(result.edit, 'bar');
        assert.deepStrictEqual(result.cursorAfterEdit, new vscode.Position(0, result.range.start.character + 3));
        const source = document.getText();
        assert.strictEqual(source.slice(0, document.offsetAt(result.range.start)) + result.edit
            + source.slice(document.offsetAt(result.range.end)), 'const value = foo(bar);');
    });

    test('turns an interior spacing correction into an applicable edit', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value  =  1;',
        });
        const result = new EditResultAssembler(new EditWindowResolver()).assemble(
            ['const value = 1;'], document, new vscode.Position(0, 10),
            undefined, 1, 'high', undefined, { start: 0, endExclusive: 1 },
        );
        assert.strictEqual(result.edits.length, 1);
        const source = document.getText();
        assert.strictEqual(source.slice(0, document.offsetAt(result.range.start)) + result.edit
            + source.slice(document.offsetAt(result.range.end)), 'const value = 1;');
    });

    test('places the cursor beyond the old EOF after a long append', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'call();' });
        const result = new EditResultAssembler(new EditWindowResolver()).assemble(
            ['call(extraLongArgument);'], document, new vscode.Position(0, 5),
            undefined, 0.99, 'high', undefined, { start: 0, endExclusive: 1 },
        );
        assert.strictEqual(result.edit, 'extraLongArgument');
        assert.ok(result.cursorAfterEdit!.character > document.lineAt(0).text.length);
        assert.deepStrictEqual(result.cursorAfterEdit, new vscode.Position(0, 22));
    });

    test('places the cursor on a new line after a CRLF document insertion', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'head\r\nend',
        });
        assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
        const result = new EditResultAssembler(new EditWindowResolver()).assemble(
            ['head', 'end', 'extra'], document, new vscode.Position(1, 3),
            undefined, 0.99, 'high', undefined, { start: 0, endExclusive: 2 },
        );
        assert.deepStrictEqual(result.cursorAfterEdit, new vscode.Position(2, 5));
    });
});
