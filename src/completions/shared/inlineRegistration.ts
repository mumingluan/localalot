import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { isUnavailableForInlineCompletion } from './documentEligibility';

type LifecycleProvider = vscode.InlineCompletionItemProvider & {
    onDidChange?: vscode.Event<{ data: { uuid: string; reason: string } }>;
    handleDidShowCompletionItem?: (item: vscode.InlineCompletionItem, updatedInsertText: string) => void;
    handleEndOfLifetime?: (item: vscode.InlineCompletionItem, reason: {
        kind: number; supersededBy?: vscode.InlineCompletionItem; userTypingDisagreed?: boolean;
    }) => void | Promise<void>;
};

type NativeEditItem = vscode.InlineCompletionItem & {
    uri?: vscode.Uri;
    jumpToPosition?: vscode.Position;
    isInlineEdit?: boolean;
    isEditInAnotherDocument?: boolean;
};

interface PendingEdit {
    item: NativeEditItem;
    sourceUri: vscode.Uri;
    sourceVersion: number;
    targetUri: vscode.Uri;
    targetVersion: number;
    requestPosition: vscode.Position;
    id: number;
    shown: boolean;
}

const nextEditActionResolvers = new Set<(document: vscode.TextDocument) => vscode.Command | undefined>();
const pendingNextEditChanged = new vscode.EventEmitter<void>();
export const onDidChangePendingNextEdit = pendingNextEditChanged.event;

export function getPendingNextEditAction(document: vscode.TextDocument): vscode.Command | undefined {
    for (const resolve of nextEditActionResolvers) {
        const action = resolve(document);
        if (action) return action;
    }
    return undefined;
}

/** Keep the Tab binding active only while the current editor has a valid NES action. */
export function registerNextEditAcceptanceCommand(
    commandId = 'localalot.applyNextEdit',
    contextKey = 'localalot.nextEditAvailable',
): vscode.Disposable {
    const updateContext = (): void => {
        const editor = vscode.window.activeTextEditor;
        void vscode.commands.executeCommand('setContext', contextKey,
            !!editor && !!getPendingNextEditAction(editor.document));
    };
    const command = vscode.commands.registerCommand(commandId, async () => {
        const editor = vscode.window.activeTextEditor;
        const action = editor && getPendingNextEditAction(editor.document);
        if (action) return vscode.commands.executeCommand(action.command, ...(action.arguments ?? []));
    });
    const registration = vscode.Disposable.from(
        command,
        pendingNextEditChanged.event(updateContext),
        vscode.window.onDidChangeActiveTextEditor(updateContext),
        vscode.window.onDidChangeTextEditorSelection(updateContext),
    );
    updateContext();
    return new vscode.Disposable(() => {
        registration.dispose();
        void vscode.commands.executeCommand('setContext', contextKey, false);
    });
}

function needsStableEditAction(item: NativeEditItem, position: vscode.Position): boolean {
    return !!item.jumpToPosition || !!item.isEditInAnotherDocument || !!item.uri
        || !!item.isInlineEdit || !item.range
        || item.range.start.line !== item.range.end.line
        || item.range.start.line !== position.line;
}

function editActionTitle(entry: PendingEdit): string {
    const { item, targetUri } = entry;
    const file = targetUri.toString() === entry.sourceUri.toString() ? '' : `${vscode.workspace.asRelativePath(targetUri)}:`;
    if (item.jumpToPosition) return `Localalot: Jump to ${file}${item.jumpToPosition.line + 1}`;
    if (item.isEditInAnotherDocument && !item.uri) return 'Localalot: Go to next edit';
    const line = (item.range?.start.line ?? entry.requestPosition.line) + 1;
    const value = typeof item.insertText === 'string' ? item.insertText : item.insertText?.value ?? '';
    const preview = value.replace(/\r?\n/g, ' ↵ ').trim();
    const suffix = preview ? ` · ${preview.slice(0, 60)}${preview.length > 60 ? '…' : ''}` : '';
    return `Localalot: Apply next edit at ${file}${line}${suffix}`;
}

function editActionTooltip(entry: PendingEdit, target: vscode.TextDocument): string {
    const { item } = entry;
    if (item.jumpToPosition) return `Jump to ${target.uri.fsPath || target.uri.toString()}:${item.jumpToPosition.line + 1}`;
    if (item.isEditInAnotherDocument && !item.uri) return 'Open the next edit in its target document';
    if (!item.range || item.insertText === undefined) return 'Apply the suggested next edit';
    const text = typeof item.insertText === 'string' ? item.insertText : item.insertText.value;
    const excerpt = (value: string): string => {
        const lines = value.split(/\r?\n/);
        const first = lines.slice(0, 8).join('\n');
        return `${first.slice(0, 600)}${lines.length > 8 || first.length > 600 ? '\n…' : ''}`;
    };
    const before = target.getText(item.range);
    return `Replace in ${vscode.workspace.asRelativePath(target.uri)}:${item.range.start.line + 1}\nBefore:\n${excerpt(before) || '(empty)'}\nAfter:\n${excerpt(text) || '(empty)'}`;
}

function editCursorHint(entry: PendingEdit): string {
    const { item } = entry;
    const file = entry.targetUri.toString() === entry.sourceUri.toString()
        ? '' : `${vscode.workspace.asRelativePath(entry.targetUri)}:`;
    if (item.jumpToPosition) return `  ↪ ${file}${item.jumpToPosition.line + 1}`;
    if (item.isEditInAnotherDocument && !item.uri) return '  ↪ Next edit';
    const line = (item.range?.start.line ?? entry.requestPosition.line) + 1;
    const text = typeof item.insertText === 'string' ? item.insertText : item.insertText?.value ?? '';
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 45);
    return `  ↪ Edit ${file}${line}${preview ? ` · ${preview}` : ''}`;
}

/** Stable VS Code executes an item's command after full acceptance. */
export function createStableAcceptanceBridge(provider: vscode.InlineCompletionItemProvider, nextEditFallback = false): {
    provider: vscode.InlineCompletionItemProvider;
    codeLensProvider?: vscode.CodeLensProvider;
    dispose(): void;
} {
    const lifecycle = provider as LifecycleProvider;
    const commandId = `localalot.inlineAccepted.${randomUUID()}`;
    const pending = new Map<number, { item: vscode.InlineCompletionItem; command?: vscode.Command }>();
    const pendingEdits = new Map<string, PendingEdit>();
    const changeCodeLenses = new vscode.EventEmitter<void>();
    const cursorHint = nextEditFallback ? vscode.window.createTextEditorDecorationType({
        after: {
            color: new vscode.ThemeColor('editorGhostText.foreground'),
            fontStyle: 'italic',
        },
    }) : undefined;
    const markEditShown = (entry: PendingEdit): void => {
        if (entry.shown) return;
        entry.shown = true;
        try {
            const text = typeof entry.item.insertText === 'string'
                ? entry.item.insertText : entry.item.insertText?.value ?? '';
            lifecycle.handleDidShowCompletionItem?.(entry.item, text);
        } catch (error) {
            console.error('Localalot next edit display callback failed', error);
        }
    };
    const refreshCursorHints = (): void => {
        if (!cursorHint) return;
        for (const editor of vscode.window.visibleTextEditors) {
            const entry = pendingEdits.get(editor.document.uri.toString());
            const target = entry && vscode.workspace.textDocuments.find(
                document => document.uri.toString() === entry.targetUri.toString());
            const valid = entry && target && editor === vscode.window.activeTextEditor
                && editor.document.version === entry.sourceVersion
                && target.version === entry.targetVersion
                && editor.selections.length === 1
                && editor.selections[0].active.isEqual(entry.requestPosition)
                && editor.visibleRanges.some(range => range.contains(entry.requestPosition));
            editor.setDecorations(cursorHint, valid ? [{
                range: new vscode.Range(entry.requestPosition, entry.requestPosition),
                renderOptions: { after: { contentText: editCursorHint(entry) } },
            }] : []);
            if (valid) markEditShown(entry);
        }
    };
    const reportIgnoredEdit = (entry: PendingEdit, supersededBy?: vscode.InlineCompletionItem): void => {
        try {
            void Promise.resolve(lifecycle.handleEndOfLifetime?.(entry.item, {
                kind: 2, userTypingDisagreed: false, ...(supersededBy ? { supersededBy } : {}),
            })).catch(error => console.error('Localalot next edit dismissal callback failed', error));
        } catch (error) {
            console.error('Localalot next edit dismissal callback failed', error);
        }
    };
    const clearPendingEdit = (key: string, accepted = false): void => {
        const entry = pendingEdits.get(key);
        if (entry && pendingEdits.delete(key)) {
            if (!accepted) reportIgnoredEdit(entry);
            refreshCursorHints();
            changeCodeLenses.fire();
            pendingNextEditChanged.fire();
        }
    };
    const resolveNextEditAction = (document: vscode.TextDocument): vscode.Command | undefined => {
        const entry = pendingEdits.get(document.uri.toString());
        if (!entry || entry.sourceVersion !== document.version) return undefined;
        const sourceEditor = vscode.window.activeTextEditor;
        if (sourceEditor?.document.uri.toString() === document.uri.toString()
            && !sourceEditor.selections.some(selection => selection.active.isEqual(entry.requestPosition))) return undefined;
        const target = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === entry.targetUri.toString());
        if (!target || target.version !== entry.targetVersion || isUnavailableForInlineCompletion(target)) return undefined;
        return {
            title: editActionTitle(entry), tooltip: editActionTooltip(entry, target),
            command: editCommandId, arguments: [document.uri.toString(), entry.id],
        };
    };
    if (nextEditFallback) nextEditActionResolvers.add(resolveNextEditAction);
    const selectionListener = nextEditFallback ? vscode.window.onDidChangeTextEditorSelection(event => {
        const key = event.textEditor.document.uri.toString();
        const entry = pendingEdits.get(key);
        if (entry && !event.selections.some(selection => selection.active.isEqual(entry.requestPosition))) {
            clearPendingEdit(key);
        }
        refreshCursorHints();
    }) : undefined;
    const documentListener = nextEditFallback ? vscode.workspace.onDidChangeTextDocument(event => {
        const changed = event.document.uri.toString();
        for (const [key, entry] of pendingEdits) {
            if ((key === changed && event.document.version !== entry.sourceVersion)
                || (entry.targetUri.toString() === changed && event.document.version !== entry.targetVersion)) {
                clearPendingEdit(key);
            }
        }
    }) : undefined;
    const closeListener = nextEditFallback ? vscode.workspace.onDidCloseTextDocument(document => {
        const closed = document.uri.toString();
        for (const [key, entry] of pendingEdits) {
            if (key === closed || entry.targetUri.toString() === closed) clearPendingEdit(key);
        }
    }) : undefined;
    const visibleEditorsListener = nextEditFallback
        ? vscode.window.onDidChangeVisibleTextEditors(refreshCursorHints) : undefined;
    const activeEditorListener = nextEditFallback
        ? vscode.window.onDidChangeActiveTextEditor(refreshCursorHints) : undefined;
    const visibleRangeListener = nextEditFallback
        ? vscode.window.onDidChangeTextEditorVisibleRanges(refreshCursorHints) : undefined;
    let nextItemId = 0;
    const commandRegistration = vscode.commands.registerCommand(commandId, async (itemId: number) => {
        const entry = pending.get(itemId);
        if (!entry) return;
        pending.delete(itemId);
        try {
            const text = typeof entry.item.insertText === 'string'
                ? entry.item.insertText : entry.item.insertText.value;
            lifecycle.handleDidShowCompletionItem?.(entry.item, text);
            await lifecycle.handleEndOfLifetime?.(entry.item, { kind: 0 });
        } catch (error) {
            console.error('Localalot inline acceptance callback failed', error);
        }
        if (entry.command) {
            return vscode.commands.executeCommand(entry.command.command, ...(entry.command.arguments ?? []));
        }
    });
    const editCommandId = `localalot.applyNextEdit.${randomUUID()}`;
    const editCommandRegistration = nextEditFallback ? vscode.commands.registerCommand(editCommandId, async (key: string, id: number) => {
        const entry = pendingEdits.get(key);
        if (!entry || entry.id !== id) return;
        const source = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === key);
        if (!source || source.version !== entry.sourceVersion) {
            clearPendingEdit(key);
            return;
        }
        const sourceEditor = vscode.window.activeTextEditor;
        if (sourceEditor?.document.uri.toString() === key
            && !sourceEditor.selections.some(selection => selection.active.isEqual(entry.requestPosition))) {
            clearPendingEdit(key);
            return;
        }
        const target = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === entry.targetUri.toString());
        if (!target || target.version !== entry.targetVersion || isUnavailableForInlineCompletion(target)) {
            clearPendingEdit(key);
            return;
        }
        const { item } = entry;
        markEditShown(entry);
        // Applying the edit itself changes the document/selection. Remove the
        // pending action first so those events cannot report an accepted edit as ignored.
        clearPendingEdit(key, true);
        try {
            if (item.jumpToPosition) {
                const editor = await vscode.window.showTextDocument(target, { selection: new vscode.Range(item.jumpToPosition, item.jumpToPosition) });
                editor.revealRange(new vscode.Range(item.jumpToPosition, item.jumpToPosition));
            } else if (item.isEditInAnotherDocument && !item.uri) {
                if (item.command) await vscode.commands.executeCommand(item.command.command, ...(item.command.arguments ?? []));
            } else {
                if (!item.range || item.insertText === undefined) {
                    reportIgnoredEdit(entry);
                    return;
                }
                const edit = new vscode.WorkspaceEdit();
                const text = typeof item.insertText === 'string' ? item.insertText : item.insertText.value;
                edit.replace(target.uri, item.range, text);
                if (!await vscode.workspace.applyEdit(edit)) {
                    reportIgnoredEdit(entry);
                    return;
                }
            }
        } catch (error) {
            reportIgnoredEdit(entry);
            throw error;
        }
        try {
            await lifecycle.handleEndOfLifetime?.(item, { kind: 0 });
        } catch (error) {
            console.error('Localalot next edit acceptance callback failed', error);
        }
        if (item.command && !(item.isEditInAnotherDocument && !item.uri)) {
            await vscode.commands.executeCommand(item.command.command, ...(item.command.arguments ?? []));
        }
    }) : undefined;
    return {
        provider: {
            provideInlineCompletionItems: async (document, position, context, token) => {
                const requestVersion = document.version;
                let result: Awaited<ReturnType<typeof provider.provideInlineCompletionItems>>;
                try {
                    result = await provider.provideInlineCompletionItems(document, position, context, token);
                } catch (error) {
                    if (nextEditFallback) clearPendingEdit(document.uri.toString());
                    throw error;
                }
                if (token.isCancellationRequested || document.version !== requestVersion) return undefined;
                if (!result) {
                    if (nextEditFallback) clearPendingEdit(document.uri.toString());
                    return result;
                }
                const items = Array.isArray(result) ? result : result.items;
                let hasPendingEdit = false;
                const bridgedItems: vscode.InlineCompletionItem[] = [];
                for (const item of items) {
                    if (nextEditFallback && needsStableEditAction(item as NativeEditItem, position)) {
                        const nativeItem = item as NativeEditItem;
                        const targetUri = nativeItem.uri ?? document.uri;
                        let target = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === targetUri.toString());
                        if (!target) {
                            try { target = await vscode.workspace.openTextDocument(targetUri); }
                            catch { /* The original target no longer exists. */ }
                        }
                        if (token.isCancellationRequested || document.version !== requestVersion) return undefined;
                        const activeEditor = vscode.window.activeTextEditor;
                        const cursorStillHere = activeEditor?.document.uri.toString() !== document.uri.toString()
                            || activeEditor.selections.some(selection => selection.active.isEqual(position));
                        if (target && !isUnavailableForInlineCompletion(target) && cursorStillHere) {
                            const previous = pendingEdits.get(document.uri.toString());
                            if (previous && previous.item !== nativeItem) reportIgnoredEdit(previous, nativeItem);
                            pendingEdits.set(document.uri.toString(), {
                                item: nativeItem, sourceUri: document.uri, sourceVersion: document.version,
                                targetUri, targetVersion: target.version, requestPosition: position, id: ++nextItemId,
                                shown: false,
                            });
                            hasPendingEdit = true;
                            if (pendingEdits.size > 128) clearPendingEdit(pendingEdits.keys().next().value!);
                            refreshCursorHints();
                            changeCodeLenses.fire();
                            pendingNextEditChanged.fire();
                        }
                        continue;
                    }
                    if (!lifecycle.handleDidShowCompletionItem && !lifecycle.handleEndOfLifetime) {
                        bridgedItems.push(item);
                        continue;
                    }
                    const itemId = ++nextItemId;
                    pending.set(itemId, { item, command: item.command });
                    if (pending.size > 512) pending.delete(pending.keys().next().value!);
                    bridgedItems.push({
                        ...item,
                        command: { title: 'Localalot Inline Suggestion Accepted', command: commandId, arguments: [itemId] },
                    });
                }
                if (nextEditFallback && !hasPendingEdit) clearPendingEdit(document.uri.toString());
                return Array.isArray(result) ? bridgedItems : { ...result, items: bridgedItems };
            },
        },
        codeLensProvider: nextEditFallback ? {
            onDidChangeCodeLenses: changeCodeLenses.event,
            provideCodeLenses: document => {
                const entry = pendingEdits.get(document.uri.toString());
                const action = resolveNextEditAction(document);
                const activeEditor = vscode.window.activeTextEditor;
                if (entry && action && activeEditor?.document.uri.toString() === document.uri.toString()
                    && activeEditor.visibleRanges.some(range => range.contains(entry.requestPosition))) {
                    markEditShown(entry);
                }
                return entry && action ? [new vscode.CodeLens(new vscode.Range(entry.requestPosition, entry.requestPosition), action)] : [];
            },
        } : undefined,
        dispose: () => {
            nextEditActionResolvers.delete(resolveNextEditAction);
            pending.clear();
            for (const entry of pendingEdits.values()) reportIgnoredEdit(entry);
            pendingEdits.clear(); commandRegistration.dispose();
            editCommandRegistration?.dispose(); selectionListener?.dispose(); documentListener?.dispose();
            closeListener?.dispose(); visibleEditorsListener?.dispose(); activeEditorListener?.dispose();
            visibleRangeListener?.dispose();
            cursorHint?.dispose();
            changeCodeLenses.dispose();
            pendingNextEditChanged.fire();
        },
    };
}

/** A standalone extension must use VS Code's stable registration surface. */
export function registerInlineCompletionProvider(
    selector: vscode.DocumentSelector,
    provider: vscode.InlineCompletionItemProvider,
    metadata: unknown,
): vscode.Disposable {
    const register = vscode.languages.registerInlineCompletionItemProvider as unknown as (
        selector: vscode.DocumentSelector,
        provider: vscode.InlineCompletionItemProvider,
        metadata?: unknown,
    ) => vscode.Disposable;
    const source = provider as LifecycleProvider;
    let pendingHint: {
        uri: string; version: number; position: vscode.Position;
        data: { uuid: string; reason: string };
    } | undefined;
    const hintedProvider = new Proxy(provider, {
        get: (target, key) => {
            if (key === 'provideInlineCompletionItems') {
                return (document: vscode.TextDocument, position: vscode.Position,
                    context: vscode.InlineCompletionContext, token: vscode.CancellationToken) => {
                    const hint = pendingHint;
                    if (hint && hint.uri === document.uri.toString()
                        && hint.version === document.version && hint.position.isEqual(position)) {
                        pendingHint = undefined;
                        context = { ...context, changeHint: { data: hint.data } } as vscode.InlineCompletionContext;
                    }
                    return target.provideInlineCompletionItems(document, position, context, token);
                };
            }
            const value = Reflect.get(target, key, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    const bridge = createStableAcceptanceBridge(hintedProvider, (metadata as { groupId?: string } | undefined)?.groupId === 'nes');
    let registration: vscode.Disposable | undefined;
    try {
        registration = register(selector, bridge.provider);
        const codeLensRegistration = bridge.codeLensProvider
            ? vscode.languages.registerCodeLensProvider(selector, bridge.codeLensProvider) : undefined;
        // Stable extensions do not receive the proposed onDidChange callback. The
        // editor command accepts the same change hint and refreshes the active editor.
        const changeRegistration = source.onDidChange?.(hint => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.isClosed) return;
            pendingHint = hint?.data ? {
                uri: editor.document.uri.toString(), version: editor.document.version,
                position: editor.selection.active, data: hint.data,
            } : undefined;
            const queuedHint = pendingHint;
            const clearUnusedHint = () => {
                if (pendingHint === queuedHint) pendingHint = undefined;
            };
            void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger', {
                explicit: false,
                ...(hint?.data ? { changeHintData: hint.data } : {}),
            }).then(clearUnusedHint, error => {
                clearUnusedHint();
                console.error('Localalot inline refresh failed', error);
            });
        });
        return vscode.Disposable.from(registration, codeLensRegistration ?? new vscode.Disposable(() => undefined),
            changeRegistration ?? new vscode.Disposable(() => undefined), bridge);
    } catch (error) {
        registration?.dispose();
        bridge.dispose();
        throw error;
    }
}

/** Register the original provider when lifecycle additions are available. */
export function registerOriginalInlineCompletionProvider(
    selector: vscode.DocumentSelector,
    provider: vscode.InlineCompletionItemProvider,
    metadata: unknown,
): vscode.Disposable {
    const additions = vscode.languages as typeof vscode.languages & {
        inlineCompletionsUnificationState?: unknown;
    };
    let supportsAdditions = false;
    try {
        supportsAdditions = additions.inlineCompletionsUnificationState !== undefined;
    } catch {
        supportsAdditions = false;
    }
    if (supportsAdditions) {
        const register = vscode.languages.registerInlineCompletionItemProvider as unknown as (
            selector: vscode.DocumentSelector,
            provider: vscode.InlineCompletionItemProvider,
            metadata?: unknown,
        ) => vscode.Disposable;
        try {
            return register(selector, provider, metadata);
        } catch (error) {
            console.warn(`Localalot inline-completion additions unavailable; using stable bridge: ${String(error)}`);
        }
    }
    return registerInlineCompletionProvider(selector, provider, metadata);
}
