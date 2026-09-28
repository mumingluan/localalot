import * as vscode from 'vscode';
import { getLocalConfiguration } from '../../config/compatConfiguration';
import { IInstantiationService } from '../../di/instantiation';
import { IGhostConfigProvider } from '../../config/ghostConfig';
import { ILogService } from '../shared/log/logService';
import { GhostText } from './inlineCompletion';
import { GhostCompletion, GhostCompletionList, ResultType } from './types';
import { createServiceIdentifier } from '../../di/services';
import { ICurrentGhostText } from '../../di/services';
import { CurrentGhostText } from './ghostTextState';
import { IAsyncCompletionsManager } from './asyncCompletions';
import { isEligibleForInlineCompletion, shouldSkipAutomaticCompletionOnMeteredConnection } from '../shared/documentEligibility';
import { normalizeGhostIndent } from './normalizeIndent';
import { GhostVirtualCompletion } from './inlineCompletion';
import { selectedCompletionPreview } from './selectedCompletionPreview';
import { noteGhostDiagnosticsChanged } from './diagnosticRevision';
import { registerInlineCompletionProvider } from '../shared/inlineRegistration';

export const IGhostTextProvider = createServiceIdentifier<IGhostTextProvider>('IGhostTextProvider');

export interface IGhostTextProvider {
    readonly _serviceBrand: undefined;
    register(): vscode.Disposable;
}

/** Match the native stable provider's selected IntelliSense default. */
export function shouldRespectSelectedCompletionInfo(resource: vscode.Uri): boolean {
    const quickSuggestions = vscode.workspace.getConfiguration('editor.quickSuggestions');
    const quickSuggestionsDisabled = quickSuggestions.get('other') !== 'on'
        && quickSuggestions.get('comments') !== 'on'
        && quickSuggestions.get('strings') !== 'on';
    const completionConfig = getLocalConfiguration('localalot', resource);
    const inspected = completionConfig.inspect<boolean>('respectSelectedCompletionInfo');
    // VS Code supplies an implicit `false` default for a boolean setting even
    // when package.json has no default. Use the dynamic native default unless
    // the user (or a language override) actually configured this setting.
    const configured = inspected && [
        inspected.defaultLanguageValue,
        inspected.globalValue, inspected.workspaceValue, inspected.workspaceFolderValue,
        inspected.globalLanguageValue, inspected.workspaceLanguageValue, inspected.workspaceFolderLanguageValue,
    ].some(value => value !== undefined);
    return configured
        ? completionConfig.get('respectSelectedCompletionInfo', quickSuggestionsDisabled)
        : quickSuggestionsDisabled;
}

export class GhostTextProvider implements IGhostTextProvider, vscode.InlineCompletionItemProvider {
    readonly _serviceBrand: undefined;
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;
    private readonly _itemContext = new WeakMap<vscode.InlineCompletionItem, {
        uri: string; version: number; line: number; text: string; virtualText: string;
        range: vscode.Range; resultType: ResultType; completion: GhostCompletion;
        requestGeneration: number; providerGeneration: number; configRevision: number;
    }>();
    private readonly _shownItems = new WeakSet<vscode.InlineCompletionItem>();
    private _disposable: vscode.Disposable | undefined;
    private _prefetchTimer: ReturnType<typeof setTimeout> | undefined;
    private _prefetchCts: vscode.CancellationTokenSource | undefined;
    private _prefetchGeneration = 0;
    private _selectionTimer: ReturnType<typeof setTimeout> | undefined;
    private _documentTriggerTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly _lastEdit = new Map<string, number>();
    private _activeItem: vscode.InlineCompletionItem | undefined;
    private readonly _documentRequestGenerations = new Map<string, number>();
    private _nextDocumentRequestGeneration = 0;
    private _requestGeneration = 0;

    constructor(
        @IInstantiationService private readonly _instantiationService: IInstantiationService,
        @IGhostConfigProvider private readonly _config: IGhostConfigProvider,
        @ILogService private readonly _log: ILogService,
    ) {}

    invalidateCachedCompletions(): void {
        this._requestGeneration++;
        this._prefetchGeneration++;
        this._documentRequestGenerations.clear();
        if (this._prefetchTimer) clearTimeout(this._prefetchTimer);
        this._prefetchTimer = undefined;
        this._prefetchCts?.cancel();
        this._activeItem = undefined;
        this._instantiationService.invokeFunction(accessor => {
            (accessor.get(ICurrentGhostText) as CurrentGhostText).clear();
            accessor.get(IAsyncCompletionsManager).clear();
        });
    }

    register(): vscode.Disposable {
        this._disposable = registerInlineCompletionProvider(
            { pattern: '**' },
            this,
            { displayName: 'Ghost Text', debounceDelayMs: 0, groupId: 'ghost' },
        );

        const configDisposable = this._config.onDidChangeEnabled(() => {
            this._log.info(`GHOST enabled changed to: ${this._config.enabled}`);
            this.invalidateCachedCompletions();
            if (this._disposable) {
                this._disposable.dispose();
                this._disposable = undefined;
            }
            if (this._config.enabled) {
                this._disposable = registerInlineCompletionProvider(
                    { pattern: '**' },
                    this,
                    { displayName: 'Ghost Text', debounceDelayMs: 0, groupId: 'ghost' },
                );
            }
            this._onDidChange.fire();
        });
        const settingsDisposable = vscode.workspace.onDidChangeConfiguration(event => {
            if (!event.affectsConfiguration('localalot.ghost')
                && !event.affectsConfiguration('localalot.enable')
                && !event.affectsConfiguration('localalot.exclude')
                && !event.affectsConfiguration('localalot.ignoreWhenSuggestVisible')
                && !event.affectsConfiguration('localalot.respectSelectedCompletionInfo')
                && !event.affectsConfiguration('editor.quickSuggestions')
                && !event.affectsConfiguration('editor.inlineSuggest.enabled')) return;
            if (event.affectsConfiguration('editor.inlineSuggest.enabled')
                || event.affectsConfiguration('localalot.enable')
                || event.affectsConfiguration('localalot.exclude')) {
                this.invalidateCachedCompletions();
            } else {
                this._requestGeneration++;
                this._prefetchGeneration++;
                if (this._prefetchTimer) clearTimeout(this._prefetchTimer);
                this._prefetchTimer = undefined;
                this._prefetchCts?.cancel();
                this._activeItem = undefined;
            }
            if (this._config.enabled) this._onDidChange.fire();
        });
        const documentChangeDisposable = vscode.workspace.onDidChangeTextDocument(event => {
            if (!this._config.enabled || event.contentChanges.length === 0) return;
            this._lastEdit.set(event.document.uri.toString(), Date.now());
            const editor = vscode.window.activeTextEditor;
            // Changes in another document must not cancel the active editor's
            // pending refresh or speculative request.
            if (!editor || editor.document.uri.toString() !== event.document.uri.toString()) return;
            // VS Code's native triggerer re-requests inline completions after
            // a short quiet period following typing. The prefetch below warms
            // the cache, but it does not make the provider visible by itself.
            if (this._documentTriggerTimer) clearTimeout(this._documentTriggerTimer);
            this._documentTriggerTimer = setTimeout(() => {
                this._documentTriggerTimer = undefined;
                if (this._config.enabled && vscode.window.activeTextEditor?.document.uri.toString() === event.document.uri.toString()) {
                    this._onDidChange.fire();
                }
            }, 120);
            if (!getLocalConfiguration('localalot.ghost', event.document.uri).get('speculativePrefetch', true)) return;
            if (!isEligibleForInlineCompletion(event.document)) return;
            if (this._prefetchTimer) clearTimeout(this._prefetchTimer);
            this._prefetchGeneration++;
            this._prefetchCts?.cancel();
            this._prefetchTimer = setTimeout(() => this._prefetch(editor), 140);
        });
        const documentCloseDisposable = vscode.workspace.onDidCloseTextDocument(document => {
            const key = document.uri.toString();
            this._documentRequestGenerations.delete(key);
            this._lastEdit.delete(key);
        });
        const activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
            if (this._prefetchTimer) clearTimeout(this._prefetchTimer);
            this._prefetchTimer = undefined;
            if (this._selectionTimer) clearTimeout(this._selectionTimer);
            this._selectionTimer = undefined;
            this._prefetchGeneration++;
            this._prefetchCts?.cancel();
            this._activeItem = undefined;
        });
        const selectionDisposable = vscode.window.onDidChangeTextEditorSelection(event => {
            if (!this._config.enabled || event.selections.length !== 1 || !event.selections[0].isEmpty) return;
            if (event.textEditor !== vscode.window.activeTextEditor) return;
            const lastEdit = this._lastEdit.get(event.textEditor.document.uri.toString()) ?? 0;
            if (Date.now() - lastEdit > 30_000) return;
            if (this._selectionTimer) clearTimeout(this._selectionTimer);
            this._selectionTimer = setTimeout(() => this._onDidChange.fire(), 180);
        });
        const diagnosticsDisposable = vscode.languages.onDidChangeDiagnostics(event => {
            const active = vscode.window.activeTextEditor;
            let activeChanged = false;
            for (const uri of event.uris) {
                const changed = noteGhostDiagnosticsChanged(uri.toString(), vscode.languages.getDiagnostics(uri));
                if (changed && uri.toString() === active?.document.uri.toString()) activeChanged = true;
            }
            if (this._config.enabled && activeChanged) {
                this._onDidChange.fire();
            }
        });

        return {
            dispose: () => {
                this._disposable?.dispose();
                configDisposable.dispose();
                settingsDisposable.dispose();
                documentChangeDisposable.dispose();
                documentCloseDisposable.dispose();
                activeEditorDisposable.dispose();
                diagnosticsDisposable.dispose();
                selectionDisposable.dispose();
                if (this._selectionTimer) clearTimeout(this._selectionTimer);
                if (this._documentTriggerTimer) clearTimeout(this._documentTriggerTimer);
                if (this._prefetchTimer) clearTimeout(this._prefetchTimer);
                this._prefetchGeneration++;
                this._requestGeneration++;
                this._documentRequestGenerations.clear();
                this._prefetchCts?.cancel();
                this._prefetchCts?.dispose();
                this._onDidChange.dispose();
            },
        };
    }

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken,
    ): Promise<vscode.InlineCompletionList | undefined> {
        // Native Ghost Text applies the language switch to automatic requests;
        // an explicit editor trigger can still request a one-off completion.
        const isCycling = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
        if (!this._config.enabled || shouldSkipAutomaticCompletionOnMeteredConnection(context.triggerKind)
            || !isEligibleForInlineCompletion(document, isCycling)
            || (context.selectedCompletionInfo && getLocalConfiguration('localalot', document.uri).get('ignoreWhenSuggestVisible', false))) {
            this._log.debug(`[GHOST] DISABLED`);
            return undefined;
        }

        const documentKey = document.uri.toString();
        const requestGeneration = ++this._nextDocumentRequestGeneration;
        this._documentRequestGenerations.set(documentKey, requestGeneration);
        const providerGeneration = this._requestGeneration;
        const requestedVersion = document.version;
        const requestedConfigRevision = this._config.revision;
        const ghostText = this._instantiationService.createInstance(GhostText);
        // Native Copilot previews the selected IntelliSense insertion, except
        // for function snippets rendered as `name()`.
        const respectSelected = shouldRespectSelectedCompletionInfo(document.uri);
        // Snippet-based function items often collapse to `name()`; injecting
        // that into the FIM prefix produced poor results in native Copilot.
        const selectedCompletionInfo = respectSelected && !context.selectedCompletionInfo?.text.includes(')')
            ? context.selectedCompletionInfo : undefined;
        const result = await ghostText.getInlineCompletions(
            document,
            position,
            token,
            false,
            isCycling,
            selectedCompletionInfo,
        );

        // A provider request may finish after the user typed again. Native
        // inline suggestions are version-bound; discard stale results so an
        // older network response cannot flash back over newer source text.
        if (token.isCancellationRequested || document.version !== requestedVersion
            || requestedConfigRevision !== this._config.revision || providerGeneration !== this._requestGeneration
            || requestGeneration !== this._documentRequestGenerations.get(documentKey)) {
            this._log.debug(`[GHOST] STALE_RESULT requested=${requestedVersion} current=${document.version} generation=${requestGeneration}/${this._documentRequestGenerations.get(documentKey)}`);
            return undefined;
        }

        if (!result || result.completions.length === 0) {
            this._log.debug(`[GHOST] NO_RESULT`);
            return undefined;
        }

        const currentLine = document.lineAt(position.line);
        const currentLinePrefix = currentLine.text.substring(0, position.character);
        // The model saw the selected IntelliSense insertion in a virtual
        // document. Match that line's blankness when normalizing indentation.
        const selectedOnCurrentLine = selectedCompletionInfo
            && selectedCompletionInfo.range.start.line === position.line
            && selectedCompletionInfo.range.end.line === position.line
            && selectedCompletionInfo.range.contains(position)
            && !/[\r\n]/.test(selectedCompletionInfo.text);
        const lineForIndent = selectedOnCurrentLine
            ? currentLine.text.slice(0, selectedCompletionInfo.range.start.character)
                + selectedCompletionInfo.text
                + currentLine.text.slice(selectedCompletionInfo.range.end.character)
            : currentLine.text;
        const currentLineIsWhitespace = lineForIndent.trim().length === 0;
        const editorOptions = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === document.uri.toString())?.options;
        // Read editor options once so cycling cannot change indentation between candidates.
        const indentOptions = editorOptions ? { tabSize: editorOptions.tabSize, insertSpaces: editorOptions.insertSpaces } : undefined;

        const items = result.completions.map(c => {
            const normalized = normalizeGhostIndent(
                c.completionText,
                c.displayText,
                indentOptions,
                currentLineIsWhitespace,
            );
            const selectedCoverage = selectedCompletionInfo
                ? Math.min(Math.max(0, c.suffixCoverage ?? 0),
                    document.lineAt(selectedCompletionInfo.range.end.line).text.length
                        - selectedCompletionInfo.range.end.character)
                : 0;
            const selectedPreview = selectedCompletionInfo
                ? selectedCompletionPreview(selectedCompletionInfo, position,
                    currentLine.text.slice(0, selectedCompletionInfo.range.start.character),
                    normalized.displayText, selectedCoverage)
                : undefined;
            const useWholeCompletion = currentLineIsWhitespace
                && (c.displayNeedsWsOffset || normalized.completionText.startsWith(currentLine.text));
            const text = selectedPreview?.text ?? (useWholeCompletion
                ? normalized.completionText
                : currentLinePrefix + normalized.displayText);
            const suffixEnd = Math.min(
                document.lineAt(position.line).text.length,
                position.character + Math.max(0, c.suffixCoverage ?? 0),
            );
            const range = selectedPreview?.range ?? new vscode.Range(
                new vscode.Position(position.line, 0),
                new vscode.Position(position.line, suffixEnd),
            );
            const item = new vscode.InlineCompletionItem(text, range);
            // Rejection identity stays tied to the model text. Editor
            // indentation conversion is presentation-only and must not make
            // the same rejected completion look like a new candidate.
            this._itemContext.set(item, {
                uri: document.uri.toString(),
                version: document.version,
                line: position.line,
                text: c.completionText,
                virtualText: text,
                range,
                resultType: result.resultType,
                completion: c,
                requestGeneration,
                providerGeneration,
                configRevision: requestedConfigRevision,
            });
            return item;
        });

        if (items.length === 0) {
            this._activeItem = undefined;
            return undefined;
        }
        this._activeItem = items[0];
        return new GhostCompletionList(items);
    }

    private async _prefetch(editor: vscode.TextEditor, virtualCompletion?: GhostVirtualCompletion): Promise<void> {
        if (vscode.window.activeTextEditor !== editor
            || !this._config.enabled
            || shouldSkipAutomaticCompletionOnMeteredConnection(vscode.InlineCompletionTriggerKind.Automatic)
            || !isEligibleForInlineCompletion(editor.document)
            || !getLocalConfiguration('localalot.ghost', editor.document.uri).get('speculativePrefetch', true)) return;
        this._prefetchGeneration++;
        const generation = this._prefetchGeneration;
        this._prefetchCts?.cancel();
        this._prefetchCts?.dispose();
        const cts = new vscode.CancellationTokenSource();
        this._prefetchCts = cts;
        try {
            const ghostText = this._instantiationService.createInstance(GhostText);
            if (generation !== this._prefetchGeneration) return;
            await ghostText.getInlineCompletions(editor.document, editor.selection.active, cts.token, true, false, undefined, virtualCompletion);
        } catch (error) {
            this._log.debug(`[GHOST] speculative prefetch skipped: ${error}`);
        } finally {
            if (this._prefetchCts === cts) this._prefetchCts = undefined;
            cts.dispose();
        }
    }

    handleEndOfLifetime(item: vscode.InlineCompletionItem, reason: { kind: number; supersededBy?: vscode.InlineCompletionItem }): void {
        const current = this._instantiationService.invokeFunction(accessor => accessor.get(ICurrentGhostText)) as CurrentGhostText;
        if (reason.kind === 0) {
            current.markExplicitlyAccepted();
            const context = this._itemContext.get(item);
            setTimeout(() => {
                const editor = vscode.window.activeTextEditor;
                if (!context || !editor || editor.document.uri.toString() !== context.uri) return;
                if (editor.document.version <= context.version) return;
                this._onDidChange.fire();
            }, 50);
        } else if (reason.kind === 1) {
            const context = this._itemContext.get(item);
            if (item === this._activeItem && context && this._shownItems.has(item)) {
                current.rejectShownCompletion(context.text);
                if (this._prefetchTimer) clearTimeout(this._prefetchTimer);
                this._prefetchTimer = undefined;
                this._prefetchGeneration++;
                this._prefetchCts?.cancel();
            }
        } else if (this._activeItem === item && !reason.supersededBy) {
            // VS Code can end an item as ignored during partial acceptance or
            // a provider refresh. Keep the typing-as-suggested state: the next
            // request verifies the exact prefix, suffix and source scope.
            if (this._prefetchTimer) clearTimeout(this._prefetchTimer);
            this._prefetchTimer = undefined;
            this._prefetchGeneration++;
            this._prefetchCts?.cancel();
        }
        if (this._activeItem === item) this._activeItem = undefined;
    }

    handleDidShowCompletionItem(item: vscode.InlineCompletionItem, updatedInsertText: string): void {
        this._shownItems.add(item);
        // The user may have cycled to any candidate. Track the item that was
        // actually rendered so a rejection cools down that candidate only.
        const context = this._itemContext.get(item);
        if (context) {
            const editor = vscode.window.visibleTextEditors.find(candidate => candidate.document.uri.toString() === context.uri);
            if (editor?.document.version === context.version
                && context.requestGeneration === this._documentRequestGenerations.get(context.uri)
                && context.providerGeneration === this._requestGeneration
                && context.configRevision === this._config.revision) {
                this._activeItem = item;
                const current = this._instantiationService.invokeFunction(accessor => accessor.get(ICurrentGhostText)) as CurrentGhostText;
                current.setActiveCompletion(context.text);
                const document = editor.document;
                const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), context.range.start));
                const suffix = document.getText(new vscode.Range(
                    context.range.end, document.lineAt(document.lineCount - 1).range.end,
                )).replace(/\r\n/g, '\n');
                current.setRenderedCompletion(context.text, prefix, suffix, updatedInsertText || context.virtualText,
                    context.resultType === ResultType.TypingAsSuggested ? context.completion : undefined);
            }
        }
        if (context) this._log.debug(`[GHOST] shown ${context.uri}@${context.version}`);
        if (context && context.resultType !== ResultType.TypingAsSuggested) {
            const activeEditor = vscode.window.activeTextEditor;
            const editor = activeEditor?.document.uri.toString() === context.uri ? activeEditor : undefined;
            if (editor && editor.document.version === context.version) {
                const virtualCompletion: GhostVirtualCompletion = {
                    text: updatedInsertText || context.virtualText,
                    range: context.range,
                };
                if (this._prefetchTimer) clearTimeout(this._prefetchTimer);
                this._prefetchTimer = setTimeout(() => {
                    this._prefetchTimer = undefined;
                    if (this._activeItem !== item || vscode.window.activeTextEditor !== editor
                        || editor.document.version !== context.version) return;
                    void this._prefetch(editor, virtualCompletion);
                }, 80);
            }
        }
    }

    handleDidPartiallyAcceptCompletionItem(item: vscode.InlineCompletionItem, info: { acceptedLength: number } | number): void {
        const acceptedLength = typeof info === 'number' ? info : info.acceptedLength;
        if (acceptedLength <= 0) return;
        const context = this._itemContext.get(item);
        setTimeout(() => {
            const editor = vscode.window.activeTextEditor;
            if (context && editor?.document.uri.toString() === context.uri
                && editor.document.version > context.version) {
                this._onDidChange.fire();
            }
        }, 0);
    }

    /** Compatibility callback used by older VS Code builds. */
    handleDidRejectCompletionItem(item: vscode.InlineCompletionItem): void {
        this.handleEndOfLifetime(item, { kind: 1 });
    }

}
