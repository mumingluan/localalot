import * as assert from 'assert';
import * as vscode from 'vscode';
import { NextEditProvider } from '../../../completions/nes/nextEditProvider';
import { NesExecutionResult } from '../../../completions/nes/core/nesWorkflow';
import { resolveDiagnosticEdit } from '../../../completions/nes/diagnosticsEditResolver';
import { Result } from '../../../common/result';

suite('NES diagnostic race', () => {
    test('a slow quick fix does not hold up cursor prediction after an empty edit result', async function () {
        this.timeout(10000);
        const document = await vscode.workspace.openTextDocument({ language: 'javascript', content: 'const answer = badName;\nuse(answer);' });
        const diagnosticRange = new vscode.Range(0, 15, 0, 22);
        const diagnostics = vscode.languages.createDiagnosticCollection('nes-race-slow-fix');
        let actionRequested!: () => void;
        const requested = new Promise<void>(resolve => { actionRequested = resolve; });
        let releaseAction: (() => void) | undefined;
        const codeActions = vscode.languages.registerCodeActionsProvider('javascript', {
            provideCodeActions: () => {
                actionRequested();
                return new Promise<vscode.CodeAction[]>(resolve => { releaseAction = () => resolve([]); });
            },
        }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] });
        diagnostics.set(document.uri, [new vscode.Diagnostic(diagnosticRange, 'Unknown name', vscode.DiagnosticSeverity.Error)]);
        let predictionCalls = 0;
        const provider = new NextEditProvider(
            { createInstance: (type: { name: string }) => type.name === 'NesWorkflow'
                ? { execute: async () => ({ editResult: undefined, promptPieces: {} }) }
                : { isEnabled: () => true, predict: async () => {
                    predictionCalls++;
                    return Result.error('noTarget');
                } } } as never,
            { enabled: true, revision: 0, eagernessSelection: 'medium' } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const pending = provider.provideInlineCompletionItems(document, document.lineAt(0).range.end,
                { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext,
                cancellation.token);
            await Promise.race([requested, new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('quick fix was not requested')), 3000))]);
            const result = await Promise.race([pending, new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('slow quick fix blocked prediction')), 1500))]);
            assert.strictEqual(result, undefined);
            assert.strictEqual(predictionCalls, 1);
        } finally {
            releaseAction?.();
            cancellation.cancel();
            cancellation.dispose();
            diagnostics.dispose();
            codeActions.dispose();
        }
    });

    test('a rejected quick fix does not cancel a usable model edit', async function () {
        this.timeout(10000);
        const document = await vscode.workspace.openTextDocument({
            language: 'javascript', content: 'const answer = badName;',
        });
        const cursor = document.lineAt(0).range.end;
        const badNameStart = document.lineAt(0).text.indexOf('badName');
        const diagnosticRange = new vscode.Range(0, badNameStart, 0, badNameStart + 'badName'.length);
        const diagnostics = vscode.languages.createDiagnosticCollection('nes-race-rejected-fix');
        const codeActions = vscode.languages.registerCodeActionsProvider('javascript', {
            provideCodeActions: () => {
                const action = new vscode.CodeAction('Fix badName', vscode.CodeActionKind.QuickFix);
                action.edit = new vscode.WorkspaceEdit();
                action.edit.replace(document.uri, diagnosticRange, 'goodName');
                action.isPreferred = true;
                return [action];
            },
        }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] });
        diagnostics.set(document.uri, [new vscode.Diagnostic(
            diagnosticRange, 'Unknown name', vscode.DiagnosticSeverity.Error)]);

        let resolveWorkflow!: (result: NesExecutionResult) => void;
        let workflowToken: vscode.CancellationToken | undefined;
        const workflow = {
            execute: (_document: vscode.TextDocument, _position: vscode.Position,
                _active: boolean, token: vscode.CancellationToken) => {
                workflowToken = token;
                return new Promise<NesExecutionResult>(resolve => { resolveWorkflow = resolve; });
            },
        };
        const predictor = { isEnabled: () => false };
        const provider = new NextEditProvider(
            { createInstance: (type: { name: string }) => type.name === 'NesWorkflow' ? workflow : predictor } as never,
            { enabled: true, revision: 0, eagernessSelection: 'medium', mimicGhostTextBehavior: false } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const rejectedHistory = (provider as unknown as {
            _rejectedEditHistory: { reject(doc: vscode.TextDocument, range: vscode.Range, text: string): void };
        })._rejectedEditHistory;
        rejectedHistory.reject(document, diagnosticRange, 'goodName');
        const cancellation = new vscode.CancellationTokenSource();
        try {
            let available = false;
            for (let attempt = 0; attempt < 20; attempt++) {
                available = !!(await resolveDiagnosticEdit(document, cursor, cancellation.token));
                if (available) break;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            assert.ok(available, 'diagnostic quick fix should be available');

            let diagnosticChecked!: () => void;
            const checked = new Promise<void>(resolve => { diagnosticChecked = resolve; });
            const originalToInlineItems = (provider as unknown as {
                _toInlineItems: (...args: unknown[]) => unknown;
            })._toInlineItems.bind(provider);
            (provider as unknown as { _toInlineItems: (...args: unknown[]) => unknown })._toInlineItems = (...args) => {
                const items = originalToInlineItems(...args);
                if (args[6] === 'diagnostic') diagnosticChecked();
                return items;
            };
            const pending = provider.provideInlineCompletionItems(document, cursor,
                { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext,
                cancellation.token);
            await Promise.race([
                checked,
                new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('diagnostic race timed out')), 3000)),
            ]);
            assert.strictEqual(workflowToken?.isCancellationRequested, false);

            const modelRange = new vscode.Range(cursor, cursor);
            resolveWorkflow({ editResult: {
                range: modelRange,
                edit: ' // model',
                fullEditText: ' // model',
                documentBeforeEdits: '',
                edits: [{ replaceRange: modelRange, newText: ' // model' }],
            } });
            const result = await pending;
            assert.strictEqual(result?.items[0].insertText, ' // model');
        } finally {
            resolveWorkflow?.({ editResult: undefined });
            cancellation.cancel();
            cancellation.dispose();
            diagnostics.dispose();
            codeActions.dispose();
        }
    });

    test('a rejected model edit does not hide a pending diagnostic quick fix', async function () {
        this.timeout(10000);
        const document = await vscode.workspace.openTextDocument({
            language: 'javascript', content: 'const answer = badName;',
        });
        const cursor = document.lineAt(0).range.end;
        const badNameStart = document.lineAt(0).text.indexOf('badName');
        const diagnosticRange = new vscode.Range(0, badNameStart, 0, badNameStart + 'badName'.length);
        const diagnostics = vscode.languages.createDiagnosticCollection('nes-race-rejected-model');
        const action = new vscode.CodeAction('Fix badName', vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, diagnosticRange, 'goodName');
        action.isPreferred = true;
        let holdAction = false;
        let releaseAction: (() => void) | undefined;
        let actionRequested!: () => void;
        const requested = new Promise<void>(resolve => { actionRequested = resolve; });
        const codeActions = vscode.languages.registerCodeActionsProvider('javascript', {
            provideCodeActions: () => {
                if (!holdAction) return [action];
                actionRequested();
                return new Promise<vscode.CodeAction[]>(resolve => {
                    releaseAction = () => resolve([action]);
                });
            },
        }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] });
        diagnostics.set(document.uri, [new vscode.Diagnostic(
            diagnosticRange, 'Unknown name', vscode.DiagnosticSeverity.Error)]);
        const modelRange = new vscode.Range(cursor, cursor);
        const modelEdit = {
            range: modelRange,
            edit: ' // model',
            fullEditText: ' // model',
            documentBeforeEdits: '',
            edits: [{ replaceRange: modelRange, newText: ' // model' }],
        };
        const workflow = { execute: async (): Promise<NesExecutionResult> => ({ editResult: modelEdit }) };
        const provider = new NextEditProvider(
            { createInstance: (type: { name: string }) => type.name === 'NesWorkflow'
                ? workflow : { isEnabled: () => false } } as never,
            { enabled: true, revision: 0, eagernessSelection: 'medium', mimicGhostTextBehavior: false } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const rejectedHistory = (provider as unknown as {
            _rejectedEditHistory: { reject(doc: vscode.TextDocument, range: vscode.Range, text: string): void };
        })._rejectedEditHistory;
        rejectedHistory.reject(document, modelRange, modelEdit.edit);
        const cancellation = new vscode.CancellationTokenSource();
        try {
            let available = false;
            for (let attempt = 0; attempt < 20; attempt++) {
                available = !!(await resolveDiagnosticEdit(document, cursor, cancellation.token));
                if (available) break;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            assert.ok(available, 'diagnostic quick fix should be available');
            holdAction = true;
            const pending = provider.provideInlineCompletionItems(document, cursor,
                { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext,
                cancellation.token);
            await Promise.race([
                requested,
                new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('code action race timed out')), 3000)),
            ]);
            assert.ok(releaseAction);
            releaseAction();
            const result = await pending;
            assert.strictEqual(result?.items[0].insertText, 'goodName');
        } finally {
            releaseAction?.();
            cancellation.cancel();
            cancellation.dispose();
            diagnostics.dispose();
            codeActions.dispose();
        }
    });
});
