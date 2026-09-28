import * as assert from 'assert';
import * as vscode from 'vscode';
import { NextEditProvider, resolvePredictedFileUri, resolvePredictedFileUris } from '../../../completions/nes/nextEditProvider';
import { NextEditResult, NesCompletionItem } from '../../../completions/nes/types';
import { Result } from '../../../common/result';
import * as path from 'path';

suite('NES predicted cursor retries', () => {
    test('keeps absolute and relative predicted paths on a remote host', () => {
        const active = vscode.Uri.parse('vscode-remote://ssh-remote+dev/home/user/project/src/main.ts');
        const folder = vscode.Uri.parse('vscode-remote://ssh-remote+dev/home/user/project');
        const absolute = resolvePredictedFileUri(active, folder, '/home/user/project/lib/helper.ts');
        const relative = resolvePredictedFileUri(active, folder, 'lib/helper.ts');
        assert.strictEqual(absolute?.toString(), vscode.Uri.parse('vscode-remote://ssh-remote+dev/home/user/project/lib/helper.ts').toString());
        assert.strictEqual(relative?.toString(), absolute?.toString());
        assert.strictEqual(resolvePredictedFileUri(active, undefined, 'lib/helper.ts'), undefined);
        assert.strictEqual(resolvePredictedFileUri(vscode.Uri.parse('untitled:Untitled-1'), folder,
            '/home/user/project/lib/helper.ts')?.toString(), absolute?.toString());
    });

    test('resolves multi-root predicted paths on the matching remote root', () => {
        const first = {
            uri: vscode.Uri.parse('vscode-remote://ssh-remote+dev/work/first'),
            name: 'first', index: 0,
        };
        const second = {
            uri: vscode.Uri.parse('vscode-remote://ssh-remote+dev/work/second'),
            name: 'second', index: 1,
        };
        const source = vscode.Uri.joinPath(first.uri, 'src/main.ts');
        const prefixed = resolvePredictedFileUris(source, first, [first, second], 'second/src/helper.ts');
        assert.deepStrictEqual(prefixed.map(uri => uri.toString()), [
            vscode.Uri.joinPath(second.uri, 'src/helper.ts').toString(),
            vscode.Uri.joinPath(first.uri, 'second/src/helper.ts').toString(),
        ]);
        const nestedSameName = resolvePredictedFileUris(source, first, [first, second], 'first/src/helper.ts');
        assert.deepStrictEqual(nestedSameName.map(uri => uri.toString()), [
            vscode.Uri.joinPath(first.uri, 'first/src/helper.ts').toString(),
            vscode.Uri.joinPath(first.uri, 'src/helper.ts').toString(),
        ]);
        const unprefixed = resolvePredictedFileUris(source, first, [first, second], 'src/helper.ts');
        assert.deepStrictEqual(unprefixed.map(uri => uri.toString()), [
            vscode.Uri.joinPath(first.uri, 'src/helper.ts').toString(),
            vscode.Uri.joinPath(second.uri, 'src/helper.ts').toString(),
        ]);
        const noActiveRoot = resolvePredictedFileUris(vscode.Uri.parse('untitled:Untitled-1'),
            undefined, [first, second], 'src/helper.ts');
        assert.strictEqual(noActiveRoot[0].toString(), unprefixed[0].toString());
    });

    test('does not resolve a cursor prediction onto a different file host', () => {
        const active = {
            uri: vscode.Uri.parse('vscode-remote://ssh-remote+dev/work/first'),
            name: 'first', index: 0,
        };
        const otherHost = {
            uri: vscode.Uri.parse('vscode-remote://ssh-remote+other/work/second'),
            name: 'second', index: 1,
        };
        const source = vscode.Uri.joinPath(active.uri, 'src/main.ts');
        assert.deepStrictEqual(resolvePredictedFileUris(source, active, [active, otherHost], 'src/helper.ts')
            .map(uri => uri.toString()), [vscode.Uri.joinPath(active.uri, 'src/helper.ts').toString()]);
        assert.deepStrictEqual(resolvePredictedFileUris(source, active, [active, otherHost], 'second/src/helper.ts'), []);
    });

    const makeProvider = (jumpWithoutEdit = false) => new NextEditProvider(
        { createInstance: () => ({}) } as never,
        { enabled: true, nextCursorJumpWithoutEdit: jumpWithoutEdit } as never,
        { info() {}, debug() {}, error() {} } as never,
    );

    test('discards an edit returned after NES configuration changes', async () => {
        const document = await vscode.workspace.openTextDocument({ content: 'const value = 1;' });
        const config = { enabled: true, revision: 0 };
        const provider = new NextEditProvider(
            { createInstance: () => ({}) } as never,
            config as never,
            { info() {}, debug() {}, error() {} } as never,
        ) as unknown as {
            _workflow: { execute(): Promise<unknown> };
            provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position,
                context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<unknown>;
        };
        let releaseWorkflow!: (result: unknown) => void;
        provider._workflow = {
            execute: () => new Promise(resolve => { releaseWorkflow = resolve; }),
        };
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const pending = provider.provideInlineCompletionItems(document, new vscode.Position(0, 0),
                {} as vscode.InlineCompletionContext, cancellation.token);
            config.revision++;
            releaseWorkflow({ editResult: {
                range: new vscode.Range(0, 0, 0, 16), edit: 'const value = 2;',
                edits: [{ replaceRange: new vscode.Range(0, 0, 0, 16), newText: 'const value = 2;' }],
            } });
            assert.strictEqual(await pending, undefined);
        } finally {
            cancellation.dispose();
        }
    });

    test('contains a primary workflow failure within the editor request', async () => {
        const document = await vscode.workspace.openTextDocument({ content: 'const value = 1;' });
        const provider = makeProvider() as unknown as {
            _workflow: { execute(): Promise<unknown> };
            provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position,
                context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<unknown>;
        };
        provider._workflow = { execute: async () => { throw new Error('adapter unavailable'); } };
        const cancellation = new vscode.CancellationTokenSource();
        try {
            assert.strictEqual(await provider.provideInlineCompletionItems(document, new vscode.Position(0, 0),
                {} as vscode.InlineCompletionContext, cancellation.token), undefined);
        } finally {
            cancellation.dispose();
        }
    });

    test('contains a failed cursor retry after a valid location prediction', async () => {
        const document = await vscode.workspace.openTextDocument({ content: 'first\nsecond' });
        const provider = makeProvider() as unknown as {
            _workflow: { execute(): Promise<unknown> };
            _cursorPredictor: { isEnabled(): boolean; predict(): Promise<unknown> };
            provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position,
                context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<unknown>;
        };
        let calls = 0;
        provider._workflow = { execute: async () => {
            if (++calls === 1) {
                return { editResult: undefined, promptPieces: { editWindowLinesRange: { contains: () => false } } };
            }
            throw new Error('retry adapter unavailable');
        } };
        provider._cursorPredictor = {
            isEnabled: () => true,
            predict: async () => Result.ok({ kind: 'sameFile' as const, lineNumber: 1 }),
        };
        const cancellation = new vscode.CancellationTokenSource();
        try {
            assert.strictEqual(await provider.provideInlineCompletionItems(document, new vscode.Position(0, 0),
                {} as vscode.InlineCompletionContext, cancellation.token), undefined);
            assert.strictEqual(calls, 2);
        } finally {
            cancellation.dispose();
        }
    });

    test('a cross-file edit uses the target URI and inline edit menu', async () => {
        const requestDoc = await vscode.workspace.openTextDocument({ content: 'request' });
        const targetDoc = await vscode.workspace.openTextDocument({ content: 'target' });
        const result: NextEditResult = {
            range: new vscode.Range(0, 0, 0, 6),
            edit: 'updated', fullEditText: 'updated', documentBeforeEdits: 'target',
            edits: [{ replaceRange: new vscode.Range(0, 0, 0, 6), newText: 'updated' }],
            cursorPrediction: { kind: 'differentFile', filePath: 'target.ts', lineNumber: 0 },
        };
        const provider = makeProvider() as unknown as {
            _toInlineItems(result: NextEditResult, document: vscode.TextDocument, cursor: vscode.Position,
                id: string, requestingPosition: vscode.Position, requestingDocument: vscode.TextDocument): { items: NesCompletionItem[] };
        };
        const item = provider._toInlineItems(result, targetDoc, new vscode.Position(0, 0),
            'cross-file-test', new vscode.Position(0, 0), requestDoc).items[0];
        assert.strictEqual(item.uri?.toString(), targetDoc.uri.toString());
        assert.strictEqual(item.isEditInAnotherDocument, true);
        assert.strictEqual(item.showInlineEditMenu, true);
        assert.strictEqual(item.displayLocation?.label, 'Go to next edit');
    });

    test('prediction retry does not offer a standalone jump by default', async () => {
        const doc = await vscode.workspace.openTextDocument({ content: 'first\nsecond' });
        const provider = makeProvider() as unknown as {
            _workflow: { execute(...args: unknown[]): Promise<unknown> };
            _cursorPredictor: { isEnabled(): boolean; predict(): Promise<unknown> };
            provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position,
                context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<{ items: NesCompletionItem[] } | undefined>;
        };
        let calls = 0;
        provider._workflow = { async execute() {
            calls++;
            return calls === 1
                ? { editResult: undefined, promptPieces: { editWindowLinesRange: {
                    start: 0, endExclusive: 1, contains: () => false,
                } } }
                : { editResult: undefined };
        } };
        provider._cursorPredictor = {
            isEnabled: () => true,
            predict: async () => Result.ok({ kind: 'sameFile' as const, lineNumber: 1 }),
        };
        const tokenSource = new vscode.CancellationTokenSource();
        const list = await provider.provideInlineCompletionItems(doc, new vscode.Position(0, 0),
            {} as vscode.InlineCompletionContext, tokenSource.token);
        tokenSource.dispose();
        assert.strictEqual(calls, 2);
        assert.strictEqual(list, undefined);
    });

    test('optional standalone mode offers a same-file jump when the target has no edit', async () => {
        const doc = await vscode.workspace.openTextDocument({ content: 'first\nsecond' });
        const provider = makeProvider(true) as unknown as {
            _workflow: { execute(...args: unknown[]): Promise<unknown> };
            _cursorPredictor: { isEnabled(): boolean; predict(): Promise<unknown> };
            provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position,
                context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<{ items: NesCompletionItem[] } | undefined>;
        };
        let calls = 0;
        provider._workflow = { async execute() {
            calls++;
            return calls === 1
                ? { editResult: undefined, promptPieces: { editWindowLinesRange: {
                    start: 0, endExclusive: 1, contains: () => false,
                } } }
                : { editResult: undefined };
        } };
        provider._cursorPredictor = {
            isEnabled: () => true,
            predict: async () => Result.ok({ kind: 'sameFile' as const, lineNumber: 1 }),
        };
        const tokenSource = new vscode.CancellationTokenSource();
        const list = await provider.provideInlineCompletionItems(doc, new vscode.Position(0, 0),
            {} as vscode.InlineCompletionContext, tokenSource.token);
        tokenSource.dispose();
        assert.strictEqual(calls, 2);
        assert.strictEqual(list?.items.length, 1);
        assert.strictEqual(list?.items[0].jumpToPosition?.line, 1);
        assert.strictEqual(list?.items[0].uri, undefined);
        assert.strictEqual(list?.items[0].insertText, undefined);
    });

    test('a path naming the current file still obeys the original edit window', async () => {
        const filePath = path.resolve(__dirname, '../../../../package.json');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        const provider = makeProvider() as unknown as {
            _workflow: { execute(...args: unknown[]): Promise<unknown> };
            _cursorPredictor: { isEnabled(): boolean; predict(): Promise<unknown> };
            provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position,
                context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<unknown>;
        };
        let calls = 0;
        provider._workflow = { async execute() {
            calls++;
            return { editResult: undefined, promptPieces: { editWindowLinesRange: {
                start: 0, endExclusive: 3, contains: (line: number) => line < 3,
            } } };
        } };
        provider._cursorPredictor = {
            isEnabled: () => true,
            predict: async () => Result.ok({ kind: 'differentFile' as const, filePath, lineNumber: 1 }),
        };
        const tokenSource = new vscode.CancellationTokenSource();
        try {
            const result = await provider.provideInlineCompletionItems(doc, new vscode.Position(0, 0),
                {} as vscode.InlineCompletionContext, tokenSource.token);
            assert.strictEqual(result, undefined);
            assert.strictEqual(calls, 1);
        } finally {
            tokenSource.dispose();
        }
    });

    test('a path naming the current file uses its indentation for a cursor jump', async () => {
        const filePath = path.resolve(__dirname, '../../../../package.json');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        const provider = makeProvider(true) as unknown as {
            _workflow: { execute(...args: unknown[]): Promise<unknown> };
            _cursorPredictor: { isEnabled(): boolean; predict(): Promise<unknown> };
            provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position,
                context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<{ items: NesCompletionItem[] } | undefined>;
        };
        const retryPositions: vscode.Position[] = [];
        provider._workflow = { async execute(_doc, position) {
            retryPositions.push(position as vscode.Position);
            return retryPositions.length === 1
                ? { editResult: undefined, promptPieces: { editWindowLinesRange: {
                    start: 0, endExclusive: 1, contains: (line: number) => line === 0,
                } } }
                : { editResult: undefined };
        } };
        provider._cursorPredictor = {
            isEnabled: () => true,
            predict: async () => Result.ok({ kind: 'differentFile' as const, filePath, lineNumber: 1 }),
        };
        const tokenSource = new vscode.CancellationTokenSource();
        try {
            const list = await provider.provideInlineCompletionItems(doc, new vscode.Position(0, 0),
                {} as vscode.InlineCompletionContext, tokenSource.token);
            const expectedColumn = doc.lineAt(1).text.search(/\S/);
            assert.ok(expectedColumn > 0);
            assert.strictEqual(retryPositions[1]?.character, expectedColumn);
            assert.strictEqual(list?.items[0].jumpToPosition?.character, expectedColumn);
            assert.strictEqual(list?.items[0].uri, undefined);
        } finally {
            tokenSource.dispose();
        }
    });

    test('prediction retry offers an edit at the predicted line', async () => {
        const doc = await vscode.workspace.openTextDocument({ content: 'first\nsecond' });
        const provider = makeProvider() as unknown as {
            _workflow: {
                execute(...args: unknown[]): Promise<unknown>;
                cacheSameFileCursorJumpEdit(...args: unknown[]): void;
            };
            _cursorPredictor: { isEnabled(): boolean; predict(): Promise<unknown> };
            provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position,
                context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<{ items: NesCompletionItem[] } | undefined>;
        };
        let calls = 0;
        let cachedOriginalWindow: { startLine: number; endLineExclusive: number } | undefined;
        provider._workflow = { async execute() {
            calls++;
            return calls === 1
                ? { editResult: undefined, promptPieces: { editWindowLinesRange: {
                    start: 0, endExclusive: 1, contains: () => false,
                } } }
                : { editResult: {
                    range: new vscode.Range(1, 0, 1, 6), edit: 'updated',
                    fullEditText: 'updated', documentBeforeEdits: 'second',
                    edits: [{ replaceRange: new vscode.Range(1, 0, 1, 6), newText: 'updated' }],
                } };
        }, cacheSameFileCursorJumpEdit(_document, window) {
            cachedOriginalWindow = window as { startLine: number; endLineExclusive: number };
        } };
        provider._cursorPredictor = {
            isEnabled: () => true,
            predict: async () => Result.ok({ kind: 'sameFile' as const, lineNumber: 1 }),
        };
        const tokenSource = new vscode.CancellationTokenSource();
        try {
            const list = await provider.provideInlineCompletionItems(doc, new vscode.Position(0, 0),
                {} as vscode.InlineCompletionContext, tokenSource.token);
            assert.strictEqual(calls, 2);
            assert.strictEqual(list?.items[0].insertText, 'updated');
            assert.strictEqual(list?.items[0].displayLocation?.label, 'Go to next edit');
            assert.deepStrictEqual(cachedOriginalWindow, { startLine: 0, endLineExclusive: 1 });
        } finally {
            tokenSource.dispose();
        }
    });

    test('optional standalone mode offers a cross-file jump without an edit', async () => {
        const requestDoc = await vscode.workspace.openTextDocument({ content: 'request' });
        const targetPath = path.resolve(__dirname, '../../../../package.json');
        const provider = makeProvider(true) as unknown as {
            _workflow: { execute(...args: unknown[]): Promise<unknown> };
            _cursorPredictor: { isEnabled(): boolean; predict(): Promise<unknown> };
            provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position,
                context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<{ items: NesCompletionItem[] } | undefined>;
        };
        let calls = 0;
        provider._workflow = { async execute() {
            calls++;
            return calls === 1
                ? { editResult: undefined, promptPieces: { editWindowLinesRange: { contains: () => false } } }
                : { editResult: undefined };
        } };
        provider._cursorPredictor = {
            isEnabled: () => true,
            predict: async () => Result.ok({ kind: 'differentFile' as const, filePath: targetPath, lineNumber: 1 }),
        };
        const tokenSource = new vscode.CancellationTokenSource();
        const list = await provider.provideInlineCompletionItems(requestDoc, new vscode.Position(0, 0),
            {} as vscode.InlineCompletionContext, tokenSource.token);
        tokenSource.dispose();
        assert.strictEqual(calls, 2);
        assert.strictEqual(list?.items.length, 1);
        assert.strictEqual(list?.items[0].uri?.fsPath, targetPath);
        assert.strictEqual(list?.items[0].jumpToPosition?.line, 1);
        assert.strictEqual(list?.items[0].jumpToPosition?.character, 0);
        assert.strictEqual(list?.items[0].insertText, undefined);
    });

    test('a slow cursor retry remains available while the editor request is active', async function () {
        this.timeout(10000);
        const doc = await vscode.workspace.openTextDocument({ content: 'first\nsecond' });
        const provider = makeProvider(true) as unknown as {
            _workflow: { execute(...args: unknown[]): Promise<unknown> };
            _cursorPredictor: { isEnabled(): boolean; predict(): Promise<unknown> };
            provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position,
                context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<{ items: NesCompletionItem[] } | undefined>;
        };
        let calls = 0;
        provider._workflow = { async execute() {
            calls++;
            if (calls === 1) return { editResult: undefined, promptPieces: { editWindowLinesRange: { contains: () => false } } };
            await new Promise(resolve => setTimeout(resolve, 5200));
            return { editResult: undefined };
        } };
        provider._cursorPredictor = {
            isEnabled: () => true,
            predict: async () => Result.ok({ kind: 'sameFile' as const, lineNumber: 1 }),
        };
        const tokenSource = new vscode.CancellationTokenSource();
        try {
            const list = await provider.provideInlineCompletionItems(doc, new vscode.Position(0, 0),
                {} as vscode.InlineCompletionContext, tokenSource.token);
            assert.strictEqual(calls, 2);
            assert.strictEqual(list?.items[0].jumpToPosition?.line, 1);
        } finally {
            tokenSource.dispose();
        }
    });
});
