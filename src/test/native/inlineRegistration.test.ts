import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createStableAcceptanceBridge, getPendingNextEditAction, registerInlineCompletionProvider, registerNextEditAcceptanceCommand } from '../../completions/shared/inlineRegistration';

suite('Stable inline acceptance bridge', () => {
    test('dismisses a pending next edit when the replacement request fails', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'source' });
        const editor = await vscode.window.showTextDocument(document);
        editor.selection = new vscode.Selection(0, 6, 0, 6);
        let fail = false;
        let ignored = 0;
        const source = {
            provideInlineCompletionItems: async () => {
                if (fail) throw new Error('model unavailable');
                return { items: [Object.assign(
                    new vscode.InlineCompletionItem('SOURCE', new vscode.Range(0, 0, 0, 6)),
                    { isInlineEdit: true },
                )] };
            },
            handleEndOfLifetime: (_item: vscode.InlineCompletionItem, reason: { kind: number }) => {
                if (reason.kind === 2) ignored++;
            },
        };
        const bridge = createStableAcceptanceBridge(source, true);
        const token = new vscode.CancellationTokenSource();
        try {
            const context = { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined };
            await bridge.provider.provideInlineCompletionItems(document, editor.selection.active, context, token.token);
            assert.ok(getPendingNextEditAction(document));
            fail = true;
            await assert.rejects(() => Promise.resolve(bridge.provider.provideInlineCompletionItems(
                document, editor.selection.active, context, token.token,
            )), /model unavailable/);
            assert.strictEqual(getPendingNextEditAction(document), undefined);
            assert.strictEqual(ignored, 1);
        } finally {
            token.dispose();
            bridge.dispose();
        }
    });

    test('clears a previous next edit when the replacement target cannot be opened', async () => {
        const sourceDoc = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'source' });
        const editor = await vscode.window.showTextDocument(sourceDoc);
        editor.selection = new vscode.Selection(0, 6, 0, 6);
        let item: vscode.InlineCompletionItem = Object.assign(
            new vscode.InlineCompletionItem('SOURCE', new vscode.Range(0, 0, 0, 6)),
            { isInlineEdit: true },
        );
        let ignored = 0;
        const source = {
            provideInlineCompletionItems: () => ({ items: [item] }),
            handleEndOfLifetime: (_item: vscode.InlineCompletionItem, reason: { kind: number }) => {
                if (reason.kind === 2) ignored++;
            },
        };
        const bridge = createStableAcceptanceBridge(source, true);
        const token = new vscode.CancellationTokenSource();
        try {
            const context = { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined };
            await bridge.provider.provideInlineCompletionItems(sourceDoc, editor.selection.active, context, token.token);
            assert.ok(getPendingNextEditAction(sourceDoc));
            item = Object.assign(new vscode.InlineCompletionItem('missing', new vscode.Range(0, 0, 0, 6)), {
                uri: vscode.Uri.file(path.join(os.tmpdir(), `localalot-missing-${Date.now()}.ts`)),
                isInlineEdit: true,
            });
            await bridge.provider.provideInlineCompletionItems(sourceDoc, editor.selection.active, context, token.token);
            assert.strictEqual(getPendingNextEditAction(sourceDoc), undefined);
            assert.strictEqual(ignored, 1);
        } finally {
            token.dispose();
            bridge.dispose();
        }
    });

    test('refuses a pending cross-file edit after its target becomes excluded', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'localalot-excluded-edit-'));
        const targetUri = vscode.Uri.file(path.join(directory, 'target.ts'));
        const sourceDoc = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'source' });
        const editor = await vscode.window.showTextDocument(sourceDoc);
        editor.selection = new vscode.Selection(0, 6, 0, 6);
        await fs.writeFile(targetUri.fsPath, 'before');
        const target = await vscode.workspace.openTextDocument(targetUri);
        const config = vscode.workspace.getConfiguration('localalot');
        const oldExclude = config.inspect<string[]>('exclude')?.globalValue;
        let ignored = 0;
        const item = Object.assign(new vscode.InlineCompletionItem('after', new vscode.Range(0, 0, 0, 6)), {
            uri: targetUri, isInlineEdit: true,
        });
        const source = {
            provideInlineCompletionItems: () => ({ items: [item] }),
            handleEndOfLifetime: (_item: vscode.InlineCompletionItem, reason: { kind: number }) => {
                if (reason.kind === 2) ignored++;
            },
        };
        const bridge = createStableAcceptanceBridge(source, true);
        const token = new vscode.CancellationTokenSource();
        try {
            await bridge.provider.provideInlineCompletionItems(sourceDoc, editor.selection.active,
                { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined }, token.token);
            const action = getPendingNextEditAction(sourceDoc);
            assert.ok(action);
            await config.update('exclude', [`**/${path.basename(targetUri.fsPath)}`], vscode.ConfigurationTarget.Global);
            assert.strictEqual(getPendingNextEditAction(sourceDoc), undefined);
            await vscode.commands.executeCommand(action.command, ...(action.arguments ?? []));
            assert.strictEqual(target.getText(), 'before');
            assert.strictEqual(ignored, 1);
        } finally {
            await config.update('exclude', oldExclude, vscode.ConfigurationTarget.Global);
            token.dispose();
            bridge.dispose();
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    test('loads an unopened target before offering a cross-file next edit', async function () {
        this.timeout(6000);
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'localalot-cross-file-'));
        const targetUri = vscode.Uri.file(path.join(directory, 'target.ts'));
        const sourceDoc = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'source' });
        const editor = await vscode.window.showTextDocument(sourceDoc);
        editor.selection = new vscode.Selection(0, 6, 0, 6);
        await fs.writeFile(targetUri.fsPath, 'before');
        assert.ok(!vscode.workspace.textDocuments.some(doc => doc.uri.toString() === targetUri.toString()));
        let accepted = 0;
        const item = Object.assign(new vscode.InlineCompletionItem('after', new vscode.Range(0, 0, 0, 6)), {
            uri: targetUri, isInlineEdit: true,
        });
        const source = {
            provideInlineCompletionItems: () => ({ items: [item] }),
            handleEndOfLifetime: (_item: vscode.InlineCompletionItem, reason: { kind: number }) => {
                if (reason.kind === 0) accepted++;
            },
        };
        const bridge = createStableAcceptanceBridge(source, true);
        const token = new vscode.CancellationTokenSource();
        try {
            await bridge.provider.provideInlineCompletionItems(sourceDoc, editor.selection.active,
                { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined }, token.token);
            const action = getPendingNextEditAction(sourceDoc);
            assert.ok(action, 'the unopened target should still produce an accept action');
            await vscode.commands.executeCommand(action.command, ...(action.arguments ?? []));
            const target = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === targetUri.toString());
            assert.ok(target);
            assert.strictEqual(target.getText(), 'after');
            assert.strictEqual(accepted, 1);
            assert.ok(await target.save());

            const jumpUri = vscode.Uri.file(path.join(directory, 'cursor-target.ts'));
            await fs.writeFile(jumpUri.fsPath, 'first\nsecond');
            assert.ok(!vscode.workspace.textDocuments.some(doc => doc.uri.toString() === jumpUri.toString()));
            const jumpItem = {
                uri: jumpUri, jumpToPosition: new vscode.Position(1, 2), insertText: undefined,
            } as unknown as vscode.InlineCompletionItem;
            const jumpBridge = createStableAcceptanceBridge({
                provideInlineCompletionItems: () => ({ items: [jumpItem] }),
            }, true);
            try {
                await jumpBridge.provider.provideInlineCompletionItems(sourceDoc, editor.selection.active,
                    { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined }, token.token);
                const jumpAction = getPendingNextEditAction(sourceDoc);
                assert.ok(jumpAction, 'the unopened cursor target should produce a jump action');
                await vscode.commands.executeCommand(jumpAction.command, ...(jumpAction.arguments ?? []));
                assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), jumpUri.toString());
                assert.ok(vscode.window.activeTextEditor?.selection.active.isEqual(new vscode.Position(1, 2)));
            } finally {
                jumpBridge.dispose();
                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            }
        } finally {
            token.dispose();
            bridge.dispose();
            assert.strictEqual(path.dirname(path.resolve(directory)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
            assert.ok(path.basename(directory).startsWith('localalot-cross-file-'));
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    test('refreshes the active editor when the original NES provider emits a change hint', async function () {
        this.timeout(5000);
        const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'const value = 1;' });
        await vscode.window.showTextDocument(document);
        const changes = new vscode.EventEmitter<{ data: { uuid: string; reason: string } }>();
        let receivedHint: unknown;
        const seenContexts: unknown[] = [];
        let resolveRequest: (() => void) | undefined;
        const request = new Promise<void>(resolve => { resolveRequest = resolve; });
        const provider = {
            onDidChange: changes.event,
            provideInlineCompletionItems: (_document: vscode.TextDocument, _position: vscode.Position,
                context: vscode.InlineCompletionContext) => {
                seenContexts.push(context);
                const hint = (context as vscode.InlineCompletionContext & { changeHint?: unknown }).changeHint;
                if (hint) {
                    receivedHint = hint;
                    resolveRequest?.();
                }
                return { items: [] };
            },
        };
        const registration = registerInlineCompletionProvider(
            { language: 'plaintext', scheme: 'untitled' }, provider,
            { displayName: 'Localalot NES Refresh Test', groupId: 'nes' },
        );
        try {
            await new Promise(resolve => setTimeout(resolve, 100));
            changes.fire({ data: { uuid: 'cursor-move-1', reason: 'selectionChange' } });
            await Promise.race([
                request,
                new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`NES refresh was not requested; active=${vscode.window.activeTextEditor?.document.uri.toString()}; contexts=${JSON.stringify(seenContexts)}`)), 3000)),
            ]);
            assert.deepStrictEqual(receivedHint, { data: { uuid: 'cursor-move-1', reason: 'selectionChange' } });
        } finally {
            registration.dispose();
            changes.dispose();
        }
    });

    async function nextEditCodeLensCommand(uri: vscode.Uri): Promise<vscode.Command> {
        let seen: vscode.CodeLens[] | undefined;
        for (let attempt = 0; attempt < 20; attempt++) {
            const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri);
            seen = lenses;
            const command = lenses?.find(lens => lens.command?.command.startsWith('localalot.applyNextEdit.'))?.command;
            if (command) return command;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.fail(`No next-edit CodeLens appeared: ${JSON.stringify(seen?.map(lens => lens.command))}`);
    }

    async function applyNextEditFromCodeLens(uri: vscode.Uri): Promise<void> {
        const command = await nextEditCodeLensCommand(uri);
        await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    }

    test('VS Code applies a distant original next edit from the stable action', async function () {
        this.timeout(6000);
        const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'alpha\nbeta' });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(0, 5, 0, 5);
        const item = Object.assign(new vscode.InlineCompletionItem('BETA', new vscode.Range(1, 0, 1, 4)), {
            isInlineEdit: true,
        });
        let provided = 0;
        let shown = 0;
        const source = {
            provideInlineCompletionItems: (document: vscode.TextDocument) => document.uri.toString() === doc.uri.toString()
                ? (provided++, { items: [item] }) : undefined,
            handleDidShowCompletionItem: () => { shown++; },
            handleEndOfLifetime: () => undefined,
        };
        const registration = registerInlineCompletionProvider(
            { language: 'plaintext', scheme: 'untitled' }, source,
            { displayName: 'Localalot Distant Edit Test', groupId: 'nes' },
        );
        const acceptanceRegistration = registerNextEditAcceptanceCommand(
            'localalot.test.applyNextEdit', 'localalot.test.nextEditAvailable');
        try {
            await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
            await new Promise(resolve => setTimeout(resolve, 250));
            assert.ok(provided > 0, 'inline provider was never requested');
            const pendingAction = getPendingNextEditAction(doc);
            assert.ok(pendingAction, 'status menu should offer the pending next edit');
            assert.ok(pendingAction.tooltip?.includes('Before:\nbeta\nAfter:\nBETA'));
            await nextEditCodeLensCommand(doc.uri);
            await vscode.commands.executeCommand('localalot.test.applyNextEdit');
            assert.strictEqual(doc.getText(), 'alpha\nBETA');
            assert.strictEqual(shown, 1, 'visible and accepted actions should report one display');
        } finally {
            acceptanceRegistration.dispose();
            registration.dispose();
        }
    });

    test('VS Code applies an original multi-line next edit from the stable action', async function () {
        this.timeout(6000);
        const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'alpha\nbeta' });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(0, 0, 0, 0);
        let accepted = 0;
        let ignored = 0;
        const source = {
            provideInlineCompletionItems: (document: vscode.TextDocument) => document.uri.toString() === doc.uri.toString()
                ? { items: [new vscode.InlineCompletionItem('ALPHA\nBETA', new vscode.Range(0, 0, 1, 4))] }
                : undefined,
            handleEndOfLifetime: (_item: vscode.InlineCompletionItem, reason: { kind: number }) => {
                if (reason.kind === 0) accepted++;
                if (reason.kind === 2) ignored++;
            },
        };
        const registration = registerInlineCompletionProvider(
            { language: 'plaintext', scheme: 'untitled' }, source,
            { displayName: 'Localalot Multi-line Test', groupId: 'nes' },
        );
        try {
            await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
            await applyNextEditFromCodeLens(doc.uri);
            assert.strictEqual(doc.getText(), 'ALPHA\nBETA');
            assert.strictEqual(accepted, 1);
            assert.strictEqual(ignored, 0, 'applying an edit must not dismiss it');
        } finally {
            registration.dispose();
        }
    });

    test('the stable action applies a cross-file next edit to its target', async function () {
        this.timeout(6000);
        const sourceDoc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'source' });
        const targetDoc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'target' });
        const editor = await vscode.window.showTextDocument(sourceDoc);
        editor.selection = new vscode.Selection(0, 6, 0, 6);
        let accepted = 0;
        let ignored = 0;
        const item = Object.assign(new vscode.InlineCompletionItem('TARGET', new vscode.Range(0, 0, 0, 6)), {
            uri: targetDoc.uri, isInlineEdit: true,
        });
        const source = {
            provideInlineCompletionItems: (document: vscode.TextDocument) => document.uri.toString() === sourceDoc.uri.toString()
                ? { items: [item] } : undefined,
            handleEndOfLifetime: (_item: vscode.InlineCompletionItem, reason: { kind: number }) => {
                if (reason.kind === 0) accepted++;
                if (reason.kind === 2) ignored++;
            },
        };
        const registration = registerInlineCompletionProvider(
            { language: 'plaintext', scheme: 'untitled' }, source,
            { displayName: 'Localalot Cross-file Test', groupId: 'nes' },
        );
        try {
            await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
            await applyNextEditFromCodeLens(sourceDoc.uri);
            assert.strictEqual(sourceDoc.getText(), 'source');
            assert.strictEqual(targetDoc.getText(), 'TARGET');
            assert.strictEqual(accepted, 1);
            assert.strictEqual(ignored, 0);
            const bridge = createStableAcceptanceBridge(source, true);
            const token = new vscode.CancellationTokenSource();
            try {
                await bridge.provider.provideInlineCompletionItems(sourceDoc, editor.selection.active,
                    { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined }, token.token);
                const staleAction = getPendingNextEditAction(sourceDoc);
                assert.ok(staleAction);
                const targetEdit = new vscode.WorkspaceEdit();
                targetEdit.insert(targetDoc.uri, new vscode.Position(0, 6), '!');
                assert.ok(await vscode.workspace.applyEdit(targetEdit));
                assert.strictEqual(getPendingNextEditAction(sourceDoc), undefined);
                await vscode.commands.executeCommand(staleAction.command, ...(staleAction.arguments ?? []));
                assert.strictEqual(targetDoc.getText(), 'TARGET!');
                assert.strictEqual(accepted, 1);
                assert.strictEqual(ignored, 1);
            } finally {
                token.dispose();
                bridge.dispose();
            }
        } finally {
            registration.dispose();
        }
    });

    test('the stable action refuses an edit after the document changes', async function () {
        this.timeout(6000);
        const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'alpha\nbeta' });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(0, 5, 0, 5);
        let accepted = 0;
        let ignored = 0;
        const source = {
            provideInlineCompletionItems: (document: vscode.TextDocument) => document.uri.toString() === doc.uri.toString()
                ? { items: [Object.assign(new vscode.InlineCompletionItem('BETA', new vscode.Range(1, 0, 1, 4)), { isInlineEdit: true })] }
                : undefined,
            handleEndOfLifetime: (_item: vscode.InlineCompletionItem, reason: { kind: number }) => {
                if (reason.kind === 0) accepted++;
                if (reason.kind === 2) ignored++;
            },
        };
        const registration = registerInlineCompletionProvider(
            { language: 'plaintext', scheme: 'untitled' }, source,
            { displayName: 'Localalot Stale Edit Test', groupId: 'nes' },
        );
        try {
            await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
            const command = await nextEditCodeLensCommand(doc.uri);
            await editor.edit(edit => edit.insert(new vscode.Position(1, 4), '!'));
            await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
            assert.strictEqual(doc.getText(), 'alpha\nbeta!');
            assert.strictEqual(accepted, 0);
            assert.strictEqual(ignored, 1);
        } finally {
            registration.dispose();
        }
    });

    test('moving the cursor removes a pending next edit', async function () {
        this.timeout(6000);
        const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'alpha\nbeta' });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(0, 5, 0, 5);
        let accepted = 0;
        let ignored = 0;
        const source = {
            provideInlineCompletionItems: (document: vscode.TextDocument) => document.uri.toString() === doc.uri.toString()
                ? { items: [Object.assign(new vscode.InlineCompletionItem('BETA', new vscode.Range(1, 0, 1, 4)), { isInlineEdit: true })] }
                : undefined,
            handleEndOfLifetime: (_item: vscode.InlineCompletionItem, reason: { kind: number }) => {
                if (reason.kind === 0) accepted++;
                if (reason.kind === 2) ignored++;
            },
        };
        const registration = registerInlineCompletionProvider(
            { language: 'plaintext', scheme: 'untitled' }, source,
            { displayName: 'Localalot Cursor Move Test', groupId: 'nes' },
        );
        const acceptanceRegistration = registerNextEditAcceptanceCommand(
            'localalot.test.applyNextEdit', 'localalot.test.nextEditAvailable');
        try {
            await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
            const command = await nextEditCodeLensCommand(doc.uri);
            editor.selection = new vscode.Selection(0, 0, 0, 0);
            assert.strictEqual(getPendingNextEditAction(doc), undefined);
            await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
            await vscode.commands.executeCommand('localalot.test.applyNextEdit');
            assert.strictEqual(doc.getText(), 'alpha\nbeta');
            assert.strictEqual(accepted, 0);
            assert.strictEqual(ignored, 1);
        } finally {
            acceptanceRegistration.dispose();
            registration.dispose();
        }
    });

    test('the stable action follows the original predicted cursor jump', async function () {
        this.timeout(6000);
        const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'first\nsecond\nthird' });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(0, 5, 0, 5);
        const jump = { jumpToPosition: new vscode.Position(2, 2), insertText: undefined } as unknown as vscode.InlineCompletionItem;
        const source = {
            provideInlineCompletionItems: (document: vscode.TextDocument) => document.uri.toString() === doc.uri.toString()
                ? { items: [jump] } : undefined,
        };
        const registration = registerInlineCompletionProvider(
            { language: 'plaintext', scheme: 'untitled' }, source,
            { displayName: 'Localalot Predicted Cursor Test', groupId: 'nes' },
        );
        try {
            await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
            await applyNextEditFromCodeLens(doc.uri);
            assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, 2);
            assert.strictEqual(vscode.window.activeTextEditor?.selection.active.character, 2);
            assert.strictEqual(doc.getText(), 'first\nsecond\nthird');
        } finally {
            registration.dispose();
        }
    });

    test('VS Code invokes the original acceptance callback after committing a suggestion', async function () {
        this.timeout(6000);
        const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'alpha' });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(0, 5, 0, 5);
        let accepted = 0;
        const source = {
            provideInlineCompletionItems: (document: vscode.TextDocument) => document.uri.toString() === doc.uri.toString()
                ? { items: [new vscode.InlineCompletionItem(' beta', new vscode.Range(0, 5, 0, 5))] }
                : undefined,
            handleEndOfLifetime: (_item: vscode.InlineCompletionItem, reason: { kind: number }) => {
                if (reason.kind === 0) accepted++;
            },
        };
        const registration = registerInlineCompletionProvider(
            { language: 'plaintext', scheme: 'untitled' }, source,
            { displayName: 'Localalot Acceptance Test' },
        );
        try {
            await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
            await new Promise(resolve => setTimeout(resolve, 250));
            await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
            assert.strictEqual(doc.getText(), 'alpha beta');
            assert.strictEqual(accepted, 1);
        } finally {
            registration.dispose();
        }
    });

    test('reports full acceptance to the original provider and keeps its item command', async () => {
        const calls: string[] = [];
        const originalActionId = `localalot.test.originalAccept.${Date.now()}`;
        const originalAction = vscode.commands.registerCommand(originalActionId, (argument: string) => {
            calls.push(`command:${argument}`);
        });
        const originalItem = new vscode.InlineCompletionItem('new value', new vscode.Range(0, 0, 0, 3), {
            title: 'Original action', command: originalActionId, arguments: ['kept'],
        });
        const source = {
            provideInlineCompletionItems: async () => ({ items: [originalItem] }),
            handleDidShowCompletionItem: (item: vscode.InlineCompletionItem, text: string) => {
                assert.strictEqual(item, originalItem);
                calls.push(`shown:${text}`);
            },
            handleEndOfLifetime: (item: vscode.InlineCompletionItem, reason: { kind: number }) => {
                assert.strictEqual(item, originalItem);
                calls.push(`end:${reason.kind}`);
            },
        };
        const bridge = createStableAcceptanceBridge(source);
        const token = new vscode.CancellationTokenSource();
        try {
            const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'old' });
            const result = await bridge.provider.provideInlineCompletionItems(
                doc, new vscode.Position(0, 3),
                { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined }, token.token,
            );
            assert.ok(result && !Array.isArray(result));
            const command = result.items[0].command;
            assert.ok(command);
            assert.strictEqual(originalItem.command?.command, originalActionId);
            assert.deepStrictEqual(calls, []);
            await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
            assert.deepStrictEqual(calls, ['shown:new value', 'end:0', 'command:kept']);
            await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
            assert.strictEqual(calls.length, 3, 'accepted item must be reported only once');
        } finally {
            token.dispose();
            bridge.dispose();
            originalAction.dispose();
        }
    });
});
