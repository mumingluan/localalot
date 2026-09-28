import * as assert from 'assert';
import * as vscode from 'vscode';
import { isOnProjectedNesTrajectory, projectAcceptedNesItem } from '../../completions/nes/projectedDocument';
import { NesCompletionInfo, NesCompletionItem, NextEditResult } from '../../completions/nes/types';
import { NextEditProvider } from '../../completions/nes/nextEditProvider';
import { NesWorkflow } from '../../completions/nes/core/nesWorkflow';
import { NextEditCache } from '../../completions/nes/nextEditCache';

suite('NES accepted edit projection', () => {
    test('projects a combined multi-change edit into the post-accept document', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const a = 1;\nconst b = 2;\n',
        });
        const item: NesCompletionItem = {
            range: new vscode.Range(0, 10, 1, 11), insertText: '4;\nconst b = 3',
        };
        const projected = projectAcceptedNesItem(document, item);
        assert.ok(projected);
        assert.strictEqual(projected.expectedText, 'const a = 4;\nconst b = 3;\n');
        assert.strictEqual(projected.document.getText(), projected.expectedText);
        assert.deepStrictEqual(projected.position, new vscode.Position(1, 11));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, item.range!, item.insertText as string);
        assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
        assert.strictEqual(document.getText(), projected.expectedText);
    });

    test('keeps the target cursor and line endings after a multiline CRLF edit', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const a = 1;\r\nconst b = 2;',
        });
        const item: NesCompletionItem = {
            range: new vscode.Range(1, 10, 1, 11), insertText: '3;\nnext()',
        };
        const projected = projectAcceptedNesItem(document, item);
        assert.ok(projected);
        assert.strictEqual(projected.expectedText, 'const a = 1;\r\nconst b = 3;\r\nnext();');
        assert.deepStrictEqual(projected.position, new vscode.Position(2, 6));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, item.range!, item.insertText as string);
        assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
        assert.strictEqual(document.getText(), projected.expectedText);
    });

    test('keeps insertion prefetch while typing through and drops divergent edits', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'return ;\n',
        });
        const projected = projectAcceptedNesItem(document, {
            range: new vscode.Range(0, 7, 0, 7), insertText: 'result',
        });
        assert.ok(projected);
        assert.strictEqual(isOnProjectedNesTrajectory(projected, 'return res;\n'), true);
        assert.strictEqual(isOnProjectedNesTrajectory(projected, 'return result;\n'), true);
        assert.strictEqual(isOnProjectedNesTrajectory(projected, 'return reset;\n'), false);
        assert.strictEqual(isOnProjectedNesTrajectory(projected, 'const result;\n'), false);
    });

    test('keeps replacement prefetch along the new text prefix', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'return oldValue;\n',
        });
        const projected = projectAcceptedNesItem(document, {
            range: new vscode.Range(0, 7, 0, 15), insertText: 'newValue',
        });
        assert.ok(projected);
        assert.strictEqual(isOnProjectedNesTrajectory(projected, 'return new;\n'), true);
        assert.strictEqual(isOnProjectedNesTrajectory(projected, 'return newValue;\n'), true);
        assert.strictEqual(isOnProjectedNesTrajectory(projected, 'return news;\n'), false);
    });

    test('projects the text VS Code actually rendered after indentation conversion', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'if (ready) {\n' });
        const projected = projectAcceptedNesItem(document, {
            range: new vscode.Range(1, 0, 1, 0), insertText: '\twork();',
        }, '    work();');
        assert.ok(projected);
        assert.strictEqual(projected.expectedText, 'if (ready) {\n    work();');
        assert.deepStrictEqual(projected.position, new vscode.Position(1, 11));
    });

    test('starts the projected request when shown and retains it after acceptance', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = 1;',
        });
        const editRange = new vscode.Range(0, 14, 0, 15);
        const suggestion: NextEditResult = {
            range: editRange, edit: '2', documentBeforeEdits: 'const value = 1;',
            fullEditText: 'const value = 2;',
            edits: [{ replaceRange: editRange, newText: '2' }],
        };
        const item: NesCompletionItem = {
            range: editRange, insertText: '2',
            info: new NesCompletionInfo(suggestion, document.uri.toString(), document, 'test'),
        };
        let finishPrefetch!: () => void;
        const pending = new Promise<{ editResult: undefined }>(resolve => {
            finishPrefetch = () => resolve({ editResult: undefined });
        });
        let calledWith: { text: string; position: vscode.Position; speculative: boolean } | undefined;
        const workflow = {
            setAggressiveness() {}, dispose() {},
            execute: async (target: vscode.TextDocument, position: vscode.Position,
                _lint: boolean, _token: vscode.CancellationToken, speculative: boolean) => {
                if (!speculative) return { editResult: undefined };
                calledWith = { text: target.getText(), position, speculative };
                return pending;
            },
        };
        const configChanged = new vscode.EventEmitter<boolean>();
        const provider = new NextEditProvider(
            { createInstance: () => workflow } as never,
            { enabled: true, revision: 0, onDidChangeEnabled: configChanged.event } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const registration = provider.register();
        try {
            provider.handleDidShowCompletionItem(item, '2');
            await new Promise(resolve => setTimeout(resolve, 140));
            assert.strictEqual(calledWith?.text, 'const value = 2;');
            assert.deepStrictEqual(calledWith?.position, new vscode.Position(0, 15));
            assert.strictEqual(calledWith?.speculative, true);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, editRange, '2');
            assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
            const cts = (provider as unknown as { _speculativeCts?: vscode.CancellationTokenSource })._speculativeCts;
            assert.strictEqual(cts?.token.isCancellationRequested, false);
            provider.handleDidShowCompletionItem({ ...item }, '2');
            assert.strictEqual(cts?.token.isCancellationRequested, true);
        } finally {
            finishPrefetch();
            registration.dispose();
            configChanged.dispose();
        }
    });

    test('serves a projected network result from cache after the real edit is accepted', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const x = 1;\nnext = 0;',
        });
        const shownRange = new vscode.Range(0, 10, 0, 11);
        const projected = projectAcceptedNesItem(document, { range: shownRange, insertText: '2' });
        assert.ok(projected);
        let networkCalls = 0;
        const response = '###remain edit start boundary line###\nconst x = 2;\nnext = 1;\n###remain edit end boundary line###';
        const adapter = { async *sendStream() {
            networkCalls++;
            yield response;
            return { text: response };
        } };
        const config = {
            revision: 0, enabled: true, endpoint: 'chat/completions',
            baseUrl: '', apiKey: '', model: 'test', family: 'standard',
            maxOutputTokens: 256, stream: true, presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { supports: { thinking: false, reasoning_effort: '' } },
            suffixOverlapThreshold: 1, suffixOverlapType: 'high',
        };
        const workflow = new NesWorkflow(
            config as never, { getAdapter: () => adapter } as never,
            { info() {}, debug() {}, error() {} } as never, new NextEditCache(),
        );
        const internals = workflow as unknown as {
            _semanticContext: { collect: () => Promise<[]> };
            _promptAssembler: { assemble: (document: vscode.TextDocument) => unknown };
        };
        internals._semanticContext.collect = async () => [];
        internals._promptAssembler.assemble = target => ({
            promptPieces: {}, systemPrompt: 'edit code', userPrompt: 'edit code',
            editWindowLines: [target.lineAt(0).text, target.lineAt(1).text],
            editWindowRange: { start: 0, endExclusive: 2 },
        });
        try {
            const prefetched = await workflow.execute(projected.document, projected.position, true, undefined, true);
            assert.ok(prefetched.editResult?.edits.length);
            assert.strictEqual(networkCalls, 1);
            const accepted = new vscode.WorkspaceEdit();
            accepted.replace(document.uri, shownRange, '2');
            assert.strictEqual(await vscode.workspace.applyEdit(accepted), true);
            assert.strictEqual(document.getText(), projected.expectedText);
            const visible = await workflow.execute(document, projected.position, true);
            assert.strictEqual(visible.editResult?.edit, prefetched.editResult?.edit);
            assert.strictEqual(networkCalls, 1);
        } finally {
            workflow.dispose();
        }
    });

    test('keeps post-accept speculation alive across a visible type-through request', async function () {
        this.timeout(8_000);
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const x = ;\nnext = 0;',
        });
        const projected = projectAcceptedNesItem(document, {
            range: new vscode.Range(0, 10, 0, 10), insertText: 'result',
        });
        assert.ok(projected);
        let firstStarted!: () => void;
        let secondStarted!: () => void;
        const startedFirst = new Promise<void>(resolve => { firstStarted = resolve; });
        const startedSecond = new Promise<void>(resolve => { secondStarted = resolve; });
        let releaseFirst!: () => void;
        let releaseSecond!: () => void;
        const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
        const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
        const signals: AbortSignal[] = [];
        const response = '###remain edit start boundary line###\nconst x = result;\nnext = 1;\n###remain edit end boundary line###';
        const adapter = { async *sendStream(_request: unknown, signal: AbortSignal) {
            const index = signals.push(signal);
            if (index === 1) {
                firstStarted();
                await firstGate;
                yield response;
                return { text: response };
            }
            secondStarted();
            await secondGate;
            return { text: '' };
        } };
        const config = {
            revision: 0, enabled: true, endpoint: 'chat/completions',
            baseUrl: '', apiKey: '', model: 'test', family: 'standard',
            maxOutputTokens: 256, stream: true, presencePenalty: 0, frequencyPenalty: 0,
            capabilities: { supports: { thinking: false, reasoning_effort: '' } },
            suffixOverlapThreshold: 1, suffixOverlapType: 'high',
        };
        const workflow = new NesWorkflow(
            config as never, { getAdapter: () => adapter } as never,
            { info() {}, debug() {}, error() {} } as never, new NextEditCache(),
        );
        const internals = workflow as unknown as {
            _semanticContext: { collect: () => Promise<[]> };
            _promptAssembler: { assemble: (document: vscode.TextDocument) => unknown };
        };
        internals._semanticContext.collect = async () => [];
        internals._promptAssembler.assemble = target => ({
            promptPieces: {}, systemPrompt: 'edit code', userPrompt: target.getText(),
            editWindowLines: [target.lineAt(0).text, target.lineAt(1).text],
            editWindowRange: { start: 0, endExclusive: 2 },
        });
        try {
            const prefetch = workflow.execute(projected.document, projected.position, true, undefined, true);
            await startedFirst;
            const partialEdit = new vscode.WorkspaceEdit();
            partialEdit.insert(document.uri, new vscode.Position(0, 10), 'res');
            assert.strictEqual(await vscode.workspace.applyEdit(partialEdit), true);
            const partial = workflow.execute(document, new vscode.Position(0, 13), true);
            await startedSecond;
            assert.strictEqual(signals[0].aborted, false);
            releaseFirst();
            releaseSecond();
            const [prefetched, partialResult] = await Promise.all([prefetch, partial]);
            assert.ok(prefetched.editResult?.edits.length);
            assert.strictEqual(partialResult.editResult, undefined);
            const finishEdit = new vscode.WorkspaceEdit();
            finishEdit.insert(document.uri, new vscode.Position(0, 13), 'ult');
            assert.strictEqual(await vscode.workspace.applyEdit(finishEdit), true);
            assert.strictEqual(document.getText(), projected.expectedText);
            const visible = await workflow.execute(document, projected.position, true);
            assert.strictEqual(visible.editResult?.edit, prefetched.editResult?.edit);
            assert.strictEqual(signals.length, 2);
        } finally {
            releaseFirst();
            releaseSecond();
            workflow.dispose();
        }
    });
});
