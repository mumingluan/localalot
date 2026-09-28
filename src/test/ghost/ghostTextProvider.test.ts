import * as assert from 'assert';
import * as vscode from 'vscode';
import { GhostTextProvider } from '../../completions/ghost/ghostTextProvider';
import { CurrentGhostText } from '../../completions/ghost/ghostTextState';
import { GhostCompletion, ResultType } from '../../completions/ghost/types';

suite('GhostTextProvider request lifecycle', () => {
    test('normalizes indentation against the selected IntelliSense preview', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: '' });
        const editor = await vscode.window.showTextDocument(document);
        const previousEditorOptions = editor.options;
        editor.options = { ...previousEditorOptions, insertSpaces: true, tabSize: 4 };
        const completionConfig = vscode.workspace.getConfiguration('localalot');
        const previousSetting = completionConfig.inspect<boolean>('respectSelectedCompletionInfo')?.globalValue;
        await completionConfig.update('respectSelectedCompletionInfo', true, vscode.ConfigurationTarget.Global);
        const choice: GhostCompletion = {
            completionIndex: 0, completionText: '  (condition)', displayText: '  (condition)',
            displayNeedsWsOffset: false, isMiddleOfTheLine: false, finishReason: 'stop',
        };
        const provider = new GhostTextProvider(
            { createInstance: () => ({ getInlineCompletions: async () => ({
                completions: [choice], resultType: ResultType.Network,
            }) }) } as never,
            { enabled: true, revision: 0 } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const list = await provider.provideInlineCompletionItems(
                document, new vscode.Position(0, 0),
                {
                    triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
                    selectedCompletionInfo: {
                        range: new vscode.Range(0, 0, 0, 0), text: 'if',
                    },
                } as vscode.InlineCompletionContext,
                cancellation.token,
            );
            assert.strictEqual(list?.items[0].insertText, 'if  (condition)');
        } finally {
            cancellation.dispose();
            editor.options = previousEditorOptions;
            await completionConfig.update('respectSelectedCompletionInfo', previousSetting, vscode.ConfigurationTarget.Global);
        }
    });

    test('disabling Ghost clears active, cached and pending completions immediately', () => {
        const changes = new vscode.EventEmitter<void>();
        const config = { enabled: true, revision: 0, onDidChangeEnabled: changes.event };
        let clears = 0;
        const provider = new GhostTextProvider(
            { invokeFunction: (callback: (accessor: unknown) => unknown) => callback({
                get: () => ({ clear: () => { clears++; } }),
            }) } as never,
            config as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const registration = provider.register();
        try {
            (provider as unknown as { _activeItem?: vscode.InlineCompletionItem })._activeItem =
                new vscode.InlineCompletionItem('old');
            config.enabled = false;
            config.revision++;
            changes.fire();
            assert.strictEqual(clears, 2);
            assert.strictEqual((provider as unknown as { _activeItem?: vscode.InlineCompletionItem })._activeItem, undefined);
        } finally {
            registration.dispose();
            changes.dispose();
        }
    });

    test('keeps typing-as-suggested state when an active item ends as ignored', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = ' });
        const state = new CurrentGhostText();
        const choice: GhostCompletion = {
            completionIndex: 0, completionText: 'calculate()', displayText: 'calculate()',
            displayNeedsWsOffset: false, isMiddleOfTheLine: false, finishReason: 'stop',
        };
        const provider = new GhostTextProvider(
            { createInstance: () => ({ getInlineCompletions: async () => {
                state.setGhostText('const value = ', '', [choice], ResultType.Network);
                return { completions: [choice] };
            } }), invokeFunction: () => state } as never,
            { enabled: true, revision: 0 } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const result = await provider.provideInlineCompletionItems(
                document, new vscode.Position(0, 14),
                { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext,
                cancellation.token,
            );
            assert.ok(result);
            provider.handleEndOfLifetime(result.items[0], { kind: 2 });
            assert.strictEqual(state.getCompletionsForUserTyping('const value = calc', '')?.[0].completionText, 'ulate()');
            assert.strictEqual(state.getCompletionsForUserTyping('const value = wrong', ''), undefined);
        } finally {
            cancellation.dispose();
        }
    });

    test('does not copy the whole document for each unshown candidate', async () => {
        const source = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const result = ',
        });
        let fullTextReads = 0;
        const document = {
            uri: source.uri,
            languageId: source.languageId,
            version: source.version,
            lineCount: source.lineCount,
            lineAt: (line: number) => source.lineAt(line),
            getText: () => { fullTextReads++; return source.getText(); },
        } as unknown as vscode.TextDocument;
        const choices: GhostCompletion[] = ['calculate()', 'estimate()'].map((text, index) => ({
            completionIndex: index, completionText: text, displayText: text,
            displayNeedsWsOffset: false, isMiddleOfTheLine: false, finishReason: 'stop',
        }));
        const provider = new GhostTextProvider(
            { createInstance: () => ({ getInlineCompletions: async () => ({
                completions: choices, resultType: ResultType.Network,
            }) }) } as never,
            { enabled: true, revision: 0 } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const list = await provider.provideInlineCompletionItems(
                document, new vscode.Position(0, source.lineAt(0).text.length),
                { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext,
                cancellation.token,
            );
            assert.strictEqual(list?.items.length, 2);
            assert.strictEqual(fullTextReads, 0);
        } finally {
            cancellation.dispose();
        }
    });

    test('allows an explicit request immediately after rejecting the shown suggestion', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const answer = ' });
        const position = new vscode.Position(0, document.lineAt(0).text.length);
        const state = new CurrentGhostText();
        const choice: GhostCompletion = {
            completionIndex: 0, completionText: '42', displayText: '42',
            displayNeedsWsOffset: false, isMiddleOfTheLine: false, finishReason: 'stop',
        };
        const provider = new GhostTextProvider(
            { createInstance: () => ({ getInlineCompletions: async () => {
                state.setGhostText(document.getText(), '', [choice], ResultType.Network);
                return { completions: [choice], resultType: ResultType.Network };
            } }), invokeFunction: () => state } as never,
            { enabled: true, revision: 0 } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const first = await provider.provideInlineCompletionItems(document, position,
                { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext,
                cancellation.token);
            assert.ok(first);
            provider.handleDidShowCompletionItem(first.items[0], String(first.items[0].insertText));
            provider.handleEndOfLifetime(first.items[0], { kind: 1 });
            const retriggered = await provider.provideInlineCompletionItems(document, position,
                { triggerKind: vscode.InlineCompletionTriggerKind.Invoke } as vscode.InlineCompletionContext,
                cancellation.token);
            assert.strictEqual(retriggered?.items[0].insertText, 'const answer = 42');
        } finally {
            cancellation.dispose();
        }
    });

    test('a rejected old item does not invalidate a pending fresh completion', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = ' });
        await vscode.window.showTextDocument(document);
        const state = new CurrentGhostText();
        let calls = 0;
        let resolveFresh!: () => void;
        const freshReady = new Promise<void>(resolve => { resolveFresh = resolve; });
        const choice = (completionText: string): GhostCompletion => ({
            completionIndex: 0, completionText, displayText: completionText,
            displayNeedsWsOffset: false, isMiddleOfTheLine: false, finishReason: 'stop',
        });
        const provider = new GhostTextProvider(
            { createInstance: () => ({ getInlineCompletions: async () => {
                const requestId = state.beginRequest();
                const completionText = ++calls === 1 ? 'old' : 'fresh';
                if (completionText === 'fresh') await freshReady;
                const result = choice(completionText);
                state.setGhostText(document.getText(), '', [result], ResultType.Network,
                    undefined, requestId);
                return { completions: [result], resultType: ResultType.Network };
            } }), invokeFunction: () => state } as never,
            { enabled: true, revision: 0 } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const position = new vscode.Position(0, document.lineAt(0).text.length);
            const context = { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext;
            const old = await provider.provideInlineCompletionItems(document, position, context, cancellation.token);
            assert.ok(old);
            provider.handleDidShowCompletionItem(old.items[0], old.items[0].insertText as string);
            const pendingFresh = provider.provideInlineCompletionItems(document, position, context, cancellation.token);
            provider.handleEndOfLifetime(old.items[0], { kind: 1 });
            resolveFresh();
            const fresh = await pendingFresh;
            assert.strictEqual(fresh?.items[0].insertText, 'const value = fresh');
            assert.strictEqual(state.getCompletionsForUserTyping('const value = fr', '')?.[0].completionText, 'esh');
        } finally {
            resolveFresh();
            clearTimeout((provider as unknown as { _prefetchTimer?: ReturnType<typeof setTimeout> })._prefetchTimer);
            cancellation.dispose();
        }
    });

    test('keeps pending completions independent across open documents', async () => {
        const first = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const first = ' });
        const second = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const second = ' });
        const resolvers = new Map<string, (result: unknown) => void>();
        const provider = new GhostTextProvider(
            { createInstance: () => ({ getInlineCompletions: (document: vscode.TextDocument) =>
                new Promise(resolve => { resolvers.set(document.uri.toString(), resolve); }) }) } as never,
            { enabled: true, revision: 0 } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const cancellation = new vscode.CancellationTokenSource();
        const context = { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext;
        const choice = (text: string): GhostCompletion => ({
            completionIndex: 0, completionText: text, displayText: text,
            displayNeedsWsOffset: false, isMiddleOfTheLine: false, finishReason: 'stop',
        });
        try {
            const firstPending = provider.provideInlineCompletionItems(first, new vscode.Position(0, first.lineAt(0).text.length), context, cancellation.token);
            const secondPending = provider.provideInlineCompletionItems(second, new vscode.Position(0, second.lineAt(0).text.length), context, cancellation.token);
            resolvers.get(second.uri.toString())?.({ completions: [choice('two')] });
            resolvers.get(first.uri.toString())?.({ completions: [choice('one')] });
            assert.strictEqual((await firstPending)?.items[0].insertText, 'const first = one');
            assert.strictEqual((await secondPending)?.items[0].insertText, 'const second = two');
        } finally {
            cancellation.dispose();
        }
    });

    test('discards an older request for the same document', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = ' });
        const resolvers: Array<(result: unknown) => void> = [];
        const provider = new GhostTextProvider(
            { createInstance: () => ({ getInlineCompletions: () =>
                new Promise(resolve => { resolvers.push(resolve); }) }) } as never,
            { enabled: true, revision: 0 } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const cancellation = new vscode.CancellationTokenSource();
        const position = new vscode.Position(0, document.lineAt(0).text.length);
        const context = { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext;
        try {
            const older = provider.provideInlineCompletionItems(document, position, context, cancellation.token);
            const newer = provider.provideInlineCompletionItems(document, position, context, cancellation.token);
            const choice: GhostCompletion = { completionIndex: 0, completionText: 'new', displayText: 'new',
                displayNeedsWsOffset: false, isMiddleOfTheLine: false, finishReason: 'stop' };
            resolvers[1]({ completions: [choice] });
            resolvers[0]({ completions: [choice] });
            assert.strictEqual(await older, undefined);
            assert.strictEqual((await newer)?.items[0].insertText, 'const value = new');
        } finally {
            cancellation.dispose();
        }
    });

    test('does not show an old response after ghost settings change', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = ',
        });
        let resolveResponse!: (result: unknown) => void;
        const response = new Promise(resolve => { resolveResponse = resolve; });
        const ghostText = { getInlineCompletions: () => response };
        const config = { enabled: true, revision: 0 };
        const log = { info() {}, debug() {}, error() {} };
        const provider = new GhostTextProvider(
            { createInstance: () => ghostText } as never,
            config as never,
            log as never,
        );
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const pending = provider.provideInlineCompletionItems(
                document, new vscode.Position(0, document.lineAt(0).text.length),
                { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext,
                cancellation.token,
            );
            config.revision++;
            resolveResponse({ completions: [{ completionText: 'newValue' }] });
            assert.strictEqual(await pending, undefined);
        } finally {
            cancellation.dispose();
        }
    });

    test('tracks the rendered indentation when a suggestion is shown', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'function run() {\n',
        });
        const editor = await vscode.window.showTextDocument(document);
        editor.options = { ...editor.options, insertSpaces: true, tabSize: 4 };
        const choice: GhostCompletion = {
            completionIndex: 0, completionText: '\twork();\n\treturn;',
            displayText: '\twork();\n\treturn;', displayNeedsWsOffset: false,
            isMiddleOfTheLine: false, finishReason: 'stop',
        };
        const state = new CurrentGhostText();
        const ghostText = { getInlineCompletions: () => {
            state.setGhostText(document.getText(), '', [choice], ResultType.Network);
            return { completions: [choice] };
        } };
        const provider = new GhostTextProvider(
            { createInstance: () => ghostText, invokeFunction: () => state } as never,
            { enabled: true, revision: 0 } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const result = await provider.provideInlineCompletionItems(
                document, new vscode.Position(1, 0),
                { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext,
                cancellation.token,
            );
            assert.ok(result);
            const item = result.items[0];
            assert.strictEqual(item.insertText, '    work();\n    return;');
            provider.handleDidShowCompletionItem(item, item.insertText as string);
            assert.strictEqual(state.getCompletionsForUserTyping('function run() {\n    work();\n    re', '')?.[0].completionText, 'turn;');
        } finally {
            clearTimeout((provider as unknown as { _prefetchTimer?: ReturnType<typeof setTimeout> })._prefetchTimer);
            cancellation.dispose();
        }
    });

    test('does not prefetch the same suggestion again while the user types through it', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = ' });
        await vscode.window.showTextDocument(document);
        const choice: GhostCompletion = {
            completionIndex: 0, completionText: 'result', displayText: 'result',
            displayNeedsWsOffset: false, isMiddleOfTheLine: false, finishReason: 'stop',
        };
        const provider = new GhostTextProvider(
            { createInstance: () => ({ getInlineCompletions: async () => ({
                completions: [choice], resultType: ResultType.TypingAsSuggested,
            }) }), invokeFunction: () => new CurrentGhostText() } as never,
            { enabled: true, revision: 0 } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const list = await provider.provideInlineCompletionItems(
                document, new vscode.Position(0, 14),
                { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext,
                cancellation.token,
            );
            assert.ok(list);
            provider.handleDidShowCompletionItem(list.items[0], list.items[0].insertText as string);
            assert.strictEqual((provider as unknown as { _prefetchTimer?: ReturnType<typeof setTimeout> })._prefetchTimer, undefined);
        } finally {
            cancellation.dispose();
        }
    });

    test('does not prefetch a document after its editor loses focus', async () => {
        const first = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const first = ' });
        const firstEditor = await vscode.window.showTextDocument(first);
        let requests = 0;
        const provider = new GhostTextProvider(
            { createInstance: () => ({ getInlineCompletions: async () => { requests++; return undefined; } }) } as never,
            { enabled: true, revision: 0 } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        await (provider as unknown as { _prefetch(editor: vscode.TextEditor): Promise<void> })._prefetch(firstEditor);
        assert.strictEqual(requests, 1);
        const second = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const second = ' });
        await vscode.window.showTextDocument(second);
        await (provider as unknown as { _prefetch(editor: vscode.TextEditor): Promise<void> })._prefetch(firstEditor);
        assert.strictEqual(requests, 1);
    });

    test('switching editors cancels queued and active speculative work', async () => {
        const first = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const first = ' });
        await vscode.window.showTextDocument(first);
        const changes = new vscode.EventEmitter<void>();
        const provider = new GhostTextProvider(
            {} as never,
            { enabled: true, revision: 0, onDidChangeEnabled: changes.event } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const registration = provider.register();
        const internals = provider as unknown as {
            _prefetchTimer?: ReturnType<typeof setTimeout>;
            _prefetchCts?: vscode.CancellationTokenSource;
            _activeItem?: vscode.InlineCompletionItem;
        };
        const pending = new vscode.CancellationTokenSource();
        try {
            internals._prefetchTimer = setTimeout(() => {}, 30_000);
            internals._prefetchCts = pending;
            internals._activeItem = new vscode.InlineCompletionItem('old');
            const second = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const second = ' });
            await vscode.window.showTextDocument(second);
            assert.strictEqual(internals._prefetchTimer, undefined);
            assert.strictEqual(pending.token.isCancellationRequested, true);
            assert.strictEqual(internals._activeItem, undefined);
        } finally {
            if (internals._prefetchTimer) clearTimeout(internals._prefetchTimer);
            registration.dispose();
            changes.dispose();
            pending.dispose();
        }
    });

    test('keeps a cached alternative selected after partial typing active', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = ca' });
        await vscode.window.showTextDocument(document);
        const state = new CurrentGhostText();
        state.setGhostText('const value = ', '', [{
            completionIndex: 0, completionText: 'calculate()', displayText: 'calculate()',
            displayNeedsWsOffset: false, isMiddleOfTheLine: false, finishReason: 'stop',
        }], ResultType.Network);
        const choices: GhostCompletion[] = ['lculate()', 'lendar()'].map((text, index) => ({
            completionIndex: index, completionText: text, displayText: text,
            displayNeedsWsOffset: false, isMiddleOfTheLine: false, finishReason: 'stop',
        }));
        const provider = new GhostTextProvider(
            { createInstance: () => ({ getInlineCompletions: async () => ({
                completions: choices, resultType: ResultType.TypingAsSuggested,
            }) }), invokeFunction: () => state } as never,
            { enabled: true, revision: 0 } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const list = await provider.provideInlineCompletionItems(
                document, new vscode.Position(0, document.lineAt(0).text.length),
                { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext,
                cancellation.token,
            );
            assert.strictEqual(list?.items.length, 2);
            provider.handleDidShowCompletionItem(list!.items[1], list!.items[1].insertText as string);
            assert.strictEqual(state.getCompletionsForUserTyping('const value = cal', '')?.[0].completionText, 'endar()');
        } finally {
            cancellation.dispose();
        }
    });

    test('ignores a shown callback from a superseded request', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = ' });
        await vscode.window.showTextDocument(document);
        const state = new CurrentGhostText();
        let calls = 0;
        const provider = new GhostTextProvider(
            { createInstance: () => ({ getInlineCompletions: async () => {
                const completionText = ++calls === 1 ? 'stale' : 'fresh';
                const choice: GhostCompletion = {
                    completionIndex: 0, completionText, displayText: completionText,
                    displayNeedsWsOffset: false, isMiddleOfTheLine: false, finishReason: 'stop',
                };
                state.setGhostText(document.getText(), '', [choice], ResultType.Network);
                return { completions: [choice], resultType: ResultType.Network };
            } }), invokeFunction: () => state } as never,
            { enabled: true, revision: 0 } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const position = new vscode.Position(0, document.lineAt(0).text.length);
            const context = { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext;
            const stale = await provider.provideInlineCompletionItems(document, position, context, cancellation.token);
            const fresh = await provider.provideInlineCompletionItems(document, position, context, cancellation.token);
            assert.ok(stale && fresh);
            provider.handleDidShowCompletionItem(stale.items[0], stale.items[0].insertText as string);
            assert.strictEqual((provider as unknown as { _activeItem?: vscode.InlineCompletionItem })._activeItem, fresh.items[0]);
            assert.strictEqual(state.getCompletionsForUserTyping('const value = fr', '')?.[0].completionText, 'esh');
        } finally {
            clearTimeout((provider as unknown as { _prefetchTimer?: ReturnType<typeof setTimeout> })._prefetchTimer);
            cancellation.dispose();
        }
    });

    test('refreshes after accepting a suggestion longer than three lines', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'function run() {',
        });
        const editor = await vscode.window.showTextDocument(document);
        const continuation = '\n  one();\n  two();\n  three();\n  four();\n}';
        const choice: GhostCompletion = {
            completionIndex: 0, completionText: continuation, displayText: continuation,
            displayNeedsWsOffset: false, isMiddleOfTheLine: false, finishReason: 'stop',
        };
        const state = new CurrentGhostText();
        const provider = new GhostTextProvider(
            { createInstance: () => ({ getInlineCompletions: async () => ({
                completions: [choice], resultType: ResultType.Network,
            }) }), invokeFunction: () => state } as never,
            { enabled: true, revision: 0 } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const cancellation = new vscode.CancellationTokenSource();
        let refreshes = 0;
        const listener = provider.onDidChange(() => { refreshes++; });
        try {
            const position = new vscode.Position(0, document.lineAt(0).text.length);
            const list = await provider.provideInlineCompletionItems(document, position,
                { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext,
                cancellation.token);
            assert.ok(list);
            const item = list.items[0];
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, item.range!, item.insertText as string);
            assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
            editor.selection = new vscode.Selection(5, 1, 5, 1);
            provider.handleEndOfLifetime(item, { kind: 0 });
            await new Promise(resolve => setTimeout(resolve, 80));
            assert.strictEqual(refreshes, 1);
        } finally {
            listener.dispose();
            cancellation.dispose();
        }
    });

    test('keeps the first-token newline in a YAML inline completion item', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'yaml', content: 'services:\n  web:',
        });
        const choice: GhostCompletion = {
            completionIndex: 0, completionText: '\n    image: nginx',
            displayText: '\n    image: nginx', displayNeedsWsOffset: false,
            isMiddleOfTheLine: false, finishReason: 'stop',
        };
        const provider = new GhostTextProvider(
            { createInstance: () => ({ getInlineCompletions: async () => ({ completions: [choice] }) }) } as never,
            { enabled: true, revision: 0 } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const result = await provider.provideInlineCompletionItems(
                document, new vscode.Position(1, 6),
                { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext,
                cancellation.token,
            );
            assert.ok(result);
            const item = result.items[0];
            assert.deepStrictEqual(item.range, new vscode.Range(1, 0, 1, 6));
            assert.strictEqual(item.insertText, '  web:\n    image: nginx');
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, item.range!, item.insertText as string);
            assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
            assert.strictEqual(document.getText(), 'services:\n  web:\n    image: nginx');
        } finally {
            cancellation.dispose();
        }
    });

    test('VS Code displays a single-line candidate whose first generated token is a newline', async function () {
        this.timeout(12_000);
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = ' });
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        const position = new vscode.Position(0, document.lineAt(0).text.length);
        editor.selection = new vscode.Selection(position, position);
        const choice: GhostCompletion = {
            completionIndex: 0, completionText: '\n    calculateTotal(order);',
            displayText: '\n    calculateTotal(order);', displayNeedsWsOffset: false,
            isMiddleOfTheLine: false, finishReason: 'stop',
        };
        const provider = new GhostTextProvider(
            { createInstance: () => ({ getInlineCompletions: async () => ({ completions: [choice] }) }),
                invokeFunction: () => new CurrentGhostText() } as never,
            { enabled: true, revision: 0 } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        let shownItem: vscode.InlineCompletionItem | undefined;
        const originalShown = provider.handleDidShowCompletionItem.bind(provider);
        provider.handleDidShowCompletionItem = (item, updated) => {
            shownItem = item;
            originalShown(item, updated);
        };
        const registration = vscode.languages.registerInlineCompletionItemProvider(
            { scheme: 'untitled', language: 'typescript' }, provider,
        );
        try {
            await vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
            await new Promise(resolve => setTimeout(resolve, 250));
            await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
            for (let attempt = 0; attempt < 16 && !shownItem; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            assert.ok(shownItem, 'VS Code did not show the leading-newline ghost item');
            assert.strictEqual(shownItem.insertText, 'const value = \n    calculateTotal(order);');
        } finally {
            registration.dispose();
            clearTimeout((provider as unknown as { _prefetchTimer?: ReturnType<typeof setTimeout> })._prefetchTimer);
            await vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
        }
    });

    test('replaces from line start without duplicating existing spaces or same-line closers', async () => {
        const cases = [
            {
                source: 'const result =  ', position: 16,
                choice: { completionText: '  compute()', displayText: 'compute()', displayNeedsWsOffset: false,
                    isMiddleOfTheLine: false, suffixCoverage: 0 },
                expected: 'const result =  compute()',
            },
            {
                source: 'call();', position: 5,
                choice: { completionText: 'value);', displayText: 'value);', displayNeedsWsOffset: false,
                    isMiddleOfTheLine: true, suffixCoverage: 2 },
                expected: 'call(value);',
            },
            {
                source: '    ', position: 4,
                choice: { completionText: '    value', displayText: 'value', displayNeedsWsOffset: false,
                    isMiddleOfTheLine: false, suffixCoverage: 0 },
                expected: '    value',
            },
        ];
        for (const { source, position, choice, expected } of cases) {
            const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: source });
            const completion: GhostCompletion = { completionIndex: 0, finishReason: 'stop', ...choice };
            const provider = new GhostTextProvider(
                { createInstance: () => ({ getInlineCompletions: async () => ({ completions: [completion] }) }) } as never,
                { enabled: true, revision: 0 } as never,
                { info() {}, debug() {}, error() {} } as never,
            );
            const cancellation = new vscode.CancellationTokenSource();
            try {
                const result = await provider.provideInlineCompletionItems(
                    document, new vscode.Position(0, position),
                    { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext,
                    cancellation.token,
                );
                assert.ok(result);
                const item = result.items[0];
                assert.strictEqual(item.range?.start.character, 0);
                assert.strictEqual(item.insertText, expected);
                const edit = new vscode.WorkspaceEdit();
                edit.replace(document.uri, item.range!, item.insertText as string);
                assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
                assert.strictEqual(document.getText(), expected);
            } finally {
                cancellation.dispose();
            }
        }
    });

    test('selected IntelliSense preview consumes the suffix copied by the model', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'run(hel);' });
        const selectedCompletionInfo: vscode.SelectedCompletionInfo = {
            range: new vscode.Range(0, 4, 0, 7), text: 'helper',
        };
        const completion: GhostCompletion = {
            completionIndex: 0, completionText: ', option);', displayText: ', option);',
            displayNeedsWsOffset: false, isMiddleOfTheLine: true, suffixCoverage: 2,
            finishReason: 'stop',
        };
        const provider = new GhostTextProvider(
            { createInstance: () => ({ getInlineCompletions: async () => ({ completions: [completion] }) }) } as never,
            { enabled: true, revision: 0 } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const config = vscode.workspace.getConfiguration('localalot', document.uri);
        const previous = config.inspect<boolean>('respectSelectedCompletionInfo')?.globalValue;
        const cancellation = new vscode.CancellationTokenSource();
        try {
            await config.update('respectSelectedCompletionInfo', true, vscode.ConfigurationTarget.Global);
            const result = await provider.provideInlineCompletionItems(
                document, new vscode.Position(0, 7),
                { triggerKind: vscode.InlineCompletionTriggerKind.Automatic, selectedCompletionInfo } as vscode.InlineCompletionContext,
                cancellation.token,
            );
            assert.ok(result);
            const item = result.items[0];
            assert.deepStrictEqual(item.range, new vscode.Range(0, 0, 0, 9));
            assert.strictEqual(item.insertText, 'run(helper, option);');
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, item.range!, item.insertText as string);
            assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
            assert.strictEqual(document.getText(), 'run(helper, option);');
        } finally {
            cancellation.dispose();
            await config.update('respectSelectedCompletionInfo', previous, vscode.ConfigurationTarget.Global);
        }
    });

    test('manual trigger works when automatic suggestions are off for this language', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'yaml', content: 'services:\n  web:',
        });
        const settings = vscode.workspace.getConfiguration('localalot', document.uri);
        const previous = settings.inspect<Record<string, boolean>>('enable')?.globalValue;
        const cancellation = new vscode.CancellationTokenSource();
        let requests = 0;
        const choice: GhostCompletion = {
            completionIndex: 0, completionText: '\n    image: nginx',
            displayText: '\n    image: nginx', displayNeedsWsOffset: false,
            isMiddleOfTheLine: false, finishReason: 'stop',
        };
        const provider = new GhostTextProvider(
            { createInstance: () => ({ getInlineCompletions: async () => {
                requests++;
                return { completions: [choice] };
            } }) } as never,
            { enabled: true, revision: 0 } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const position = new vscode.Position(1, 6);
        try {
            await settings.update('enable', { '*': true, yaml: false }, vscode.ConfigurationTarget.Global);
            assert.strictEqual(await provider.provideInlineCompletionItems(document, position,
                { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext,
                cancellation.token), undefined);
            assert.strictEqual(requests, 0);
            const manual = await provider.provideInlineCompletionItems(document, position,
                { triggerKind: vscode.InlineCompletionTriggerKind.Invoke } as vscode.InlineCompletionContext,
                cancellation.token);
            assert.strictEqual(manual?.items[0].insertText, '  web:\n    image: nginx');
            assert.strictEqual(requests, 1);
        } finally {
            cancellation.dispose();
            await settings.update('enable', previous, vscode.ConfigurationTarget.Global);
        }
    });

    test('does not round indentation before a same-line closing brace', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'function run() {\n  }',
        });
        const editor = await vscode.window.showTextDocument(document);
        editor.options = { ...editor.options, insertSpaces: true, tabSize: 4 };
        const choice: GhostCompletion = {
            completionIndex: 0, completionText: '    value();}',
            displayText: '  value();}', displayNeedsWsOffset: false,
            isMiddleOfTheLine: true, suffixCoverage: 1, finishReason: 'stop',
        };
        const provider = new GhostTextProvider(
            { createInstance: () => ({ getInlineCompletions: async () => ({ completions: [choice] }) }) } as never,
            { enabled: true, revision: 0 } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const result = await provider.provideInlineCompletionItems(document, new vscode.Position(1, 2),
                { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext,
                cancellation.token);
            assert.strictEqual(result?.items[0].insertText, '    value();}');
            assert.deepStrictEqual(result?.items[0].range, new vscode.Range(1, 0, 1, 3));
        } finally {
            cancellation.dispose();
        }
    });
});
