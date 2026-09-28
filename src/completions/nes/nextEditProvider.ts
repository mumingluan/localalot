import * as vscode from 'vscode';
import { getLocalConfiguration } from '../../config/compatConfiguration';
import { registerInlineCompletionProvider } from '../shared/inlineRegistration';
import { IInstantiationService } from '../../di/instantiation';
import { INesConfigProvider } from '../../config/nesConfig';
import { ILogService } from '../shared/log/logService';
import { NesCompletionItem, NesCompletionList, NesCompletionInfo, NextEditResult } from './types';
import { createServiceIdentifier } from '../../di/services';
import { NesExecutionResult, NesWorkflow } from './core/nesWorkflow';
import { NextCursorPredictor } from './nextCursorPredictor';
import { InlineSuggestionResolver } from './core/inlineSuggestionResolver';
import { CursorJumpPrediction } from './types';
import * as path from 'path';
import { resolveDiagnosticEdit } from './diagnosticsEditResolver';
import { isEligibleForInlineCompletion, shouldSkipAutomaticCompletionOnMeteredConnection } from '../shared/documentEligibility';
import { AggressivenessLevel } from './stubs/types';
import { RejectedEditHistory } from './rejectedEditHistory';
import { modelSettingScope } from '../../config/modelSettingScope';
import { isOnProjectedNesTrajectory, ProjectedNesDocument, projectAcceptedNesItem } from './projectedDocument';
import { AdaptiveEagerness } from './adaptiveEagerness';

export const INesProvider = createServiceIdentifier<INesProvider>('INesProvider');

export interface INesProvider {
    readonly _serviceBrand: undefined;
    register(): vscode.Disposable;
}

let _requestSeq = 0;
const diagnosticGracePeriodMs = 200;

async function awaitDiagnosticBriefly(
    diagnostic: Promise<NextEditResult | undefined>,
    token: vscode.CancellationToken,
): Promise<NextEditResult | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelListener: vscode.Disposable | undefined;
    const timeout = new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), diagnosticGracePeriodMs);
        cancelListener = token.onCancellationRequested(() => resolve(undefined));
    });
    try {
        return await Promise.race([diagnostic, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
        cancelListener?.dispose();
    }
}

export class NextEditProvider implements INesProvider, vscode.InlineCompletionItemProvider {
    readonly _serviceBrand: undefined;
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;
    private _disposable: vscode.Disposable | undefined;
    private _selectionTimer: ReturnType<typeof setTimeout> | undefined;
    private _documentTriggerTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly _lastDocumentEdit = new Map<string, number>();
    private readonly _rejectedSuggestions = new Map<string, number>();
    private readonly _rejectedEditHistory = new RejectedEditHistory();
    private _recentlyAcceptedDiagnostic: { key: string; expires: number } | undefined;
    private _lastRejectedAt = 0;
    private _speculativeTimer: ReturnType<typeof setTimeout> | undefined;
    private _speculativeCts: vscode.CancellationTokenSource | undefined;
    private _speculativeGeneration = 0;
    private _settingsGeneration = 0;
    private _speculativeDocumentUri: string | undefined;
    private _speculativeProjection: ProjectedNesDocument | undefined;
    private _workflow: NesWorkflow;
    private _cursorPredictor: NextCursorPredictor;
    private readonly _inlineSuggestionResolver = new InlineSuggestionResolver();
    private _activeItem: NesCompletionItem | undefined;
    private _aggressiveness = AggressivenessLevel.Medium;
    private _aggressivenessSelection = 'auto';
    private readonly _adaptiveEagerness = new AdaptiveEagerness();
    private readonly _onDidChangeProviderOptions = new vscode.EventEmitter<void>();
    readonly onDidChangeProviderOptions = this._onDidChangeProviderOptions.event;
    private readonly _onDidChangeModelInfo = new vscode.EventEmitter<void>();
    readonly onDidChangeModelInfo = this._onDidChangeModelInfo.event;
    /** Proposal API surface consumed by VS Code's model picker. */
    get modelInfo(): { models: readonly { id: string; name: string }[]; currentModelId: string } {
        const model = this._config.model;
        return { models: [{ id: model, name: model }], currentModelId: model };
    }
    setCurrentModelId = async (modelId: string): Promise<void> => {
        const normalized = modelId.trim();
        if (!normalized || normalized === this._config.model) return;
        const config = getLocalConfiguration('localalot.nes');
        const target = modelSettingScope(config.inspect<string>('model'));
        await config.update('model', normalized, target);
        this._onDidChangeModelInfo.fire();
    };
    get providerOptions(): readonly [{
        id: string;
        label: string;
        values: readonly { id: string; label: string }[];
        currentValueId: string;
    }] {
        return [{
            id: 'eagerness',
            label: 'Eagerness',
            values: [
                { id: 'auto', label: 'Auto' },
                { id: 'low', label: 'Low' },
                { id: 'medium', label: 'Medium' },
                { id: 'high', label: 'High' },
            ],
            currentValueId: this._aggressivenessSelection,
        }];
    }

    constructor(
        @IInstantiationService private readonly _instantiationService: IInstantiationService,
        @INesConfigProvider private readonly _config: INesConfigProvider,
        @ILogService private readonly _log: ILogService,
    ) {
        this._workflow = this._instantiationService.createInstance(NesWorkflow);
        this._cursorPredictor = this._instantiationService.createInstance(NextCursorPredictor);
        this._aggressivenessSelection = this._config.eagernessSelection ?? 'auto';
        this._aggressiveness = this._resolveAggressiveness();
        this._workflow.setAggressiveness?.(this._aggressiveness);
    }

    invalidateCachedEdits(): void {
        this._settingsGeneration++;
        this._cancelSpeculativePrefetch();
        this._workflow.clearPendingAndCachedEdits();
        this._recentlyAcceptedDiagnostic = undefined;
        this._activeItem = undefined;
    }

    register(): vscode.Disposable {
        this._disposable = registerInlineCompletionProvider(
            { pattern: '**' },
            this,
            { displayName: 'Inline Suggestion', debounceDelayMs: 0, groupId: 'nes' },
        );

        const configDisposable = this._config.onDidChangeEnabled(() => {
            this._log.info(`NES enabled changed to: ${this._config.enabled}`);
            this.invalidateCachedEdits();
            if (this._disposable) {
                this._disposable.dispose();
                this._disposable = undefined;
            }
            if (this._config.enabled) {
                this._disposable = registerInlineCompletionProvider(
                    { pattern: '**' },
                    this,
                    { displayName: 'Inline Suggestion', debounceDelayMs: 0, groupId: 'nes' },
                );
            }
            this._onDidChange.fire();
        });
        const editDisposable = vscode.workspace.onDidChangeTextDocument(event => {
            if (event.contentChanges.length > 0) {
                this._rejectedEditHistory.applyChanges(event.document.uri.toString(), event.contentChanges);
                this._lastDocumentEdit.set(event.document.uri.toString(), Date.now());
                // Keep the provider visible after real typing. The native
                // triggerer waits briefly for the edit to settle, then fires
                // the inline completion change event; relying on speculative
                // cache population alone leaves the UI stale on cache misses.
                if (vscode.window.activeTextEditor?.document.uri.toString() === event.document.uri.toString()) {
                    if (this._documentTriggerTimer) clearTimeout(this._documentTriggerTimer);
                    this._documentTriggerTimer = setTimeout(() => {
                        this._documentTriggerTimer = undefined;
                        if (this._config.enabled && vscode.window.activeTextEditor?.document.uri.toString() === event.document.uri.toString()) {
                            this._onDidChange.fire();
                        }
                    }, 120);
                }
                if (event.document.uri.toString() === this._speculativeDocumentUri) {
                    // Acceptance reaches the projected snapshot. Keep its
                    // request alive so the new visible provider call can join
                    // it or read its cached result.
                    if (!this._speculativeProjection
                        || !isOnProjectedNesTrajectory(this._speculativeProjection, event.document.getText())) {
                        this._speculativeGeneration++;
                        if (this._speculativeTimer) clearTimeout(this._speculativeTimer);
                        this._speculativeTimer = undefined;
                        this._speculativeCts?.cancel();
                        this._speculativeDocumentUri = undefined;
                        this._speculativeProjection = undefined;
                    }
                }
            }
        });
        const selectionDisposable = vscode.window.onDidChangeTextEditorSelection(event => {
            if (!this._config.enabled || event.selections.length !== 1 || !event.selections[0].isEmpty) return;
            if (event.textEditor !== vscode.window.activeTextEditor) return;
            const lastEdit = this._lastDocumentEdit.get(event.textEditor.document.uri.toString()) ?? 0;
            if (Date.now() - lastEdit > 30_000 || Date.now() - this._lastRejectedAt < 5_000) return;
            if (this._selectionTimer) clearTimeout(this._selectionTimer);
            this._selectionTimer = setTimeout(() => this._onDidChange.fire(), 180);
        });
        const diagnosticsDisposable = vscode.languages.onDidChangeDiagnostics(event => {
            const active = vscode.window.activeTextEditor;
            let activeChanged = false;
            for (const uri of event.uris) {
                const changed = this._workflow.noteDiagnosticsChanged(uri.toString(), vscode.languages.getDiagnostics(uri));
                if (changed && uri.toString() === active?.document.uri.toString()) activeChanged = true;
            }
            if (this._config.enabled && activeChanged) {
                this._settingsGeneration++;
                this._onDidChange.fire();
            }
        });
        const modelConfigDisposable = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('localalot.nes.model')) {
                this._onDidChangeModelInfo.fire();
            }
            if (!event.affectsConfiguration('localalot.nes')
                && !event.affectsConfiguration('localalot.enable')
                && !event.affectsConfiguration('localalot.exclude')
                && !event.affectsConfiguration('localalot.ignoreWhenSuggestVisible')
                && !event.affectsConfiguration('editor.inlineSuggest.enabled')
                && !event.affectsConfiguration('editor.inlineSuggest.edits.enabled')) return;
            if (event.affectsConfiguration('editor.inlineSuggest.enabled')
                || event.affectsConfiguration('localalot.enable')
                || event.affectsConfiguration('localalot.exclude')
                || event.affectsConfiguration('localalot.nes')) {
                this.invalidateCachedEdits();
            } else {
                this._settingsGeneration++;
                this._cancelSpeculativePrefetch();
                this._activeItem = undefined;
            }
            if (this._config.enabled) this._onDidChange.fire();
        });

        return {
            dispose: () => {
                this._disposable?.dispose();
                configDisposable.dispose();
                editDisposable.dispose();
                selectionDisposable.dispose();
                diagnosticsDisposable.dispose();
                modelConfigDisposable.dispose();
                if (this._selectionTimer) clearTimeout(this._selectionTimer);
                if (this._documentTriggerTimer) clearTimeout(this._documentTriggerTimer);
                this._cancelSpeculativePrefetch();
                this._speculativeCts?.dispose();
                this._onDidChange.dispose();
                this._onDidChangeProviderOptions.dispose();
                this._onDidChangeModelInfo.dispose();
                this._workflow.dispose();
            },
        };
    }

    async setProviderOptionValue(optionId: string, valueId: string): Promise<void> {
        if (optionId !== 'eagerness') return;
        this._aggressivenessSelection = ['auto', 'low', 'medium', 'high'].includes(valueId) ? valueId : 'medium';
        this._config.setEagernessSelection?.(this._aggressivenessSelection);
        this._aggressiveness = this._resolveAggressiveness();
        this._workflow.setAggressiveness?.(this._aggressiveness);
        // The same source snapshot can produce a different edit at a new
        // eagerness level. Do not replay the previous level's cached result.
        this.invalidateCachedEdits();
        this._onDidChangeProviderOptions.fire();
        this._onDidChange.fire();
    }

    private _resolveAggressiveness(): AggressivenessLevel {
        if (this._aggressivenessSelection === 'low') return AggressivenessLevel.Low;
        if (this._aggressivenessSelection === 'high') return AggressivenessLevel.High;
        if (this._aggressivenessSelection === 'medium') return AggressivenessLevel.Medium;
        return this._adaptiveEagerness.level;
    }

    handleEndOfLifetime(_item: NesCompletionItem, reason: { kind: number; supersededBy?: vscode.InlineCompletionItem }): void {
        if (_item.jumpToPosition) {
            // A location-only suggestion has no edit acceptance to feed into
            // the edit eagerness heuristic or rejected-edit history.
            if (reason.kind === 0) setTimeout(() => this._onDidChange.fire(), 50);
            else if (!reason.supersededBy) this._cancelSpeculativePrefetch();
            if (this._activeItem === _item) this._activeItem = undefined;
            return;
        }
        if (reason.kind === 0) {
            // A newer provider request can replace the active pointer while
            // VS Code still displays this item. Acceptance is authoritative:
            // the next edit should expand after the edit the user applied.
            if (_item.info?.source === 'provider') {
                this._workflow.noteAcceptedEdit();
            }
            if (_item.info?.source === 'diagnostic') {
                this._recentlyAcceptedDiagnostic = {
                    key: this._diagnosticAcceptanceKey(_item.info),
                    expires: Date.now() + 1_000,
                };
            }
            if (_item.wasShown && _item.info?.source === 'provider') {
                this._adaptiveEagerness.record(true);
                this._aggressiveness = this._resolveAggressiveness();
                this._workflow.setAggressiveness?.(this._aggressiveness);
            }
            // Let the editor apply the accepted edit before asking for the cached next one.
            setTimeout(() => this._onDidChange.fire(), 50);
        } else if (reason.kind === 1) {
            const info = _item.info;
            if (_item.wasShown && info?.source === 'provider') {
                this._adaptiveEagerness.record(false);
                this._aggressiveness = this._resolveAggressiveness();
                this._workflow.setAggressiveness?.(this._aggressiveness);
                this._lastRejectedAt = Date.now();
            }
            // Native NES only remembers a rejected edit after the user has
            // had more than a second to review the displayed suggestion.
            // A quick dismissal can be accidental and should remain eligible.
            if (_item.wasShown && _item.shownAt !== undefined
                && Date.now() - _item.shownAt > 1_000 && info && info.suggestion.edits.length > 0) {
                this._rejectedSuggestions.set(this._rejectionKey(info), Date.now() + 8_000);
                this._rejectedEditHistory.reject(info.document, info.suggestion.range, info.suggestion.edit);
                // Keep the cache entry rejected as well. The same document
                // snapshot can become active again when the cursor returns;
                // native NES does not resurrect the exact edit after that.
                if (info.suggestion.cacheEntry) {
                    info.suggestion.cacheEntry.rejected = true;
                    info.suggestion.cacheEntry.rejectedEdit = info.suggestion.cacheEntry.edit;
                }
                this._workflow.recordRejectedEdit(info.documentId, info.suggestion.range, info.suggestion.edit);
            }
            this._cancelSpeculativePrefetch();
        } else if (!reason.supersededBy) {
            // A plain dismissal invalidates post-accept speculation. When VS
            // Code replaces this item with a newer suggestion, the native
            // provider keeps the speculative request if the user is still on
            // the type-through trajectory.
            this._cancelSpeculativePrefetch();
        }
        if (this._activeItem === _item) this._activeItem = undefined;
    }

    handleDidShowCompletionItem(item: NesCompletionItem, updatedInsertText: string): void {
        const alreadyPrefetchingThisItem = this._activeItem === item && this._speculativeProjection !== undefined;
        if (!item.wasShown) item.shownAt = Date.now();
        item.wasShown = true;
        this._activeItem = item;
        if (alreadyPrefetchingThisItem) return;
        this._scheduleSpeculativePrefetch(item, updatedInsertText);
    }

    handleDidPartiallyAcceptCompletionItem(
        item: NesCompletionItem,
        info: { acceptedLength: number } | number,
    ): void {
        const acceptedLength = typeof info === 'number' ? info : info.acceptedLength;
        if (acceptedLength <= 0 || !item.info) return;
        const document = item.info.document;
        const uri = document.uri.toString();
        const version = document.version;
        setTimeout(() => {
            const editor = vscode.window.visibleTextEditors.find(candidate => candidate.document.uri.toString() === uri);
            if (!editor || editor.document.version <= version) return;
            this._onDidChange.fire();
        }, 0);
    }

    handleListEndOfLifetime(_list: vscode.InlineCompletionList, _reason: { kind: number }): void {
        this._pruneRejectedSuggestions();
    }

    /** Compatibility callback used by older VS Code builds. */
    handleDidRejectCompletionItem(item: NesCompletionItem): void {
        this.handleEndOfLifetime(item, { kind: 1 });
    }

    private _scheduleSpeculativePrefetch(item: NesCompletionItem, updatedInsertText: string): void {
        // A newly shown item supersedes the previous post-accept snapshot even
        // if this item cannot itself be projected.
        this._cancelSpeculativePrefetch();
        if (shouldSkipAutomaticCompletionOnMeteredConnection(vscode.InlineCompletionTriggerKind.Automatic)) return;
        if (!getLocalConfiguration('localalot.nes', item.info?.document.uri).get('speculativePrefetch', true)) return;
        const targetDocument = item.info?.document;
        if (!targetDocument || !isEligibleForInlineCompletion(targetDocument)) return;
        const projected = projectAcceptedNesItem(targetDocument, item, updatedInsertText);
        if (!projected) return;
        const generation = this._speculativeGeneration;
        this._speculativeCts?.dispose();
        this._speculativeDocumentUri = targetDocument.uri.toString();
        this._speculativeProjection = projected;
        this._speculativeTimer = setTimeout(() => {
            this._speculativeTimer = undefined;
            if (generation !== this._speculativeGeneration) return;
            const actualText = targetDocument.getText();
            if (!isOnProjectedNesTrajectory(projected, actualText)) {
                this._cancelSpeculativePrefetch();
                return;
            }
            const cts = new vscode.CancellationTokenSource();
            this._speculativeCts = cts;
            void this._workflow.execute(projected.document, projected.position, true, cts.token, true)
                .catch(error => this._log.debug(`[NES] speculative prefetch skipped: ${error}`))
                .finally(() => {
                    if (this._speculativeCts === cts) {
                        this._speculativeCts = undefined;
                        if (generation === this._speculativeGeneration) {
                            this._speculativeDocumentUri = undefined;
                            this._speculativeProjection = undefined;
                        }
                    }
                    cts.dispose();
                });
        }, 100);
    }

    private _cancelSpeculativePrefetch(): void {
        this._speculativeGeneration++;
        if (this._speculativeTimer) clearTimeout(this._speculativeTimer);
        this._speculativeTimer = undefined;
        this._speculativeCts?.cancel();
        this._speculativeDocumentUri = undefined;
        this._speculativeProjection = undefined;
    }

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken,
    ): Promise<NesCompletionList | undefined> {
        if (!this._config.enabled || shouldSkipAutomaticCompletionOnMeteredConnection(context.triggerKind)
            || !isEligibleForInlineCompletion(document)
            || (context.selectedCompletionInfo && getLocalConfiguration('localalot', document.uri).get('ignoreWhenSuggestVisible', false))) {
            this._log.debug(`[NES]  DISABLED`);
            return undefined;
        }

        const requestUuid = `nes-${Date.now()}-${++_requestSeq}`;
        const requestedVersion = document.version;
        const requestedConfigRevision = this._config.revision ?? 0;
        const requestedSettingsGeneration = this._settingsGeneration;
        const isStale = () => token.isCancellationRequested || document.version !== requestedVersion
            || (this._config.revision ?? 0) !== requestedConfigRevision
            || this._settingsGeneration !== requestedSettingsGeneration || !this._config.enabled;
        if (isStale()) return undefined;

        // Start diagnostics in parallel with the LLM request. VS Code's
        // provider races these sources so a nearby quick fix is not delayed by
        // a slow network request.
        const diagnosticPromise = resolveDiagnosticEdit(document, position, token)
            .catch(error => {
                this._log.debug(`[NES] diagnostic race skipped: ${error}`);
                return undefined;
            });
        const workflowCts = new vscode.CancellationTokenSource();
        const cancelWorkflow = token.onCancellationRequested(() => workflowCts.cancel());
        const disposeWorkflowRace = () => {
            cancelWorkflow.dispose();
            workflowCts.dispose();
        };
        // Primary NES request. Keep a local token so a fast diagnostic quick
        // fix can stop the model request instead of paying for its full
        // network/streaming lifetime.
        const startWorkflowTime = Date.now();
        const workflowPromise = this._workflow.execute(document, position, true, workflowCts.token)
            .catch((error): NesExecutionResult => {
                this._log.error(`[NES] primary workflow failed: ${error}`);
                return { editResult: undefined };
            });
        type FirstResult =
            | { source: 'workflow'; result: Awaited<typeof workflowPromise> }
            | { source: 'diagnostic'; edit: Awaited<typeof diagnosticPromise> };
        const firstResult = await Promise.race<FirstResult>([
            workflowPromise.then(result => ({ source: 'workflow' as const, result })),
            diagnosticPromise.then(edit => ({ source: 'diagnostic' as const, edit })),
        ]);

        // A diagnostic result is already a complete, precise edit. Return it
        // immediately only if it survives the same display and rejection
        // checks as an LLM edit. An unusable quick fix must not cancel or hide
        // a model suggestion that is already in flight.
        if (firstResult.source === 'diagnostic' && firstResult.edit) {
            if (isStale()) {
                disposeWorkflowRace();
                return undefined;
            }
            const diagnosticItems = this._toInlineItems(
                firstResult.edit, document, position, requestUuid, position, document, 'diagnostic');
            if (diagnosticItems.items.length > 0) {
                workflowCts.cancel();
                disposeWorkflowRace();
                return diagnosticItems;
            }
        }

        const workflowResult = firstResult.source === 'workflow'
            ? firstResult.result
            : await workflowPromise;
        const { editResult, promptPieces, targetDocument: cachedTargetDocument, targetPosition: cachedTargetPosition } = workflowResult;
        this._log.info(`[NES]  primary workflow took ${Date.now() - startWorkflowTime}ms`);
        if (isStale()) {
            disposeWorkflowRace();
            return undefined;
        }

        if (editResult && editResult.edits.length > 0 && (!editResult.range.isEmpty || editResult.edit !== '')) {
            if (cachedTargetDocument && cachedTargetDocument.uri.toString() !== document.uri.toString()
                && !isEligibleForInlineCompletion(cachedTargetDocument)) {
                this._log.debug(`[NES] cached cross-file target is disabled`);
            } else {
                const modelItems = this._toInlineItems(
                    editResult,
                    cachedTargetDocument ?? document,
                    cachedTargetPosition ?? position,
                    requestUuid,
                    position,
                    document,
                );
                if (modelItems.items.length > 0) {
                    disposeWorkflowRace();
                    return modelItems;
                }
            }
        }

        const diagnosticEdit = firstResult.source === 'diagnostic'
            ? firstResult.edit
            : await awaitDiagnosticBriefly(diagnosticPromise, token);
        if (isStale()) {
            disposeWorkflowRace();
            return undefined;
        }
        if (diagnosticEdit) {
            const diagnosticItems = this._toInlineItems(
                diagnosticEdit, document, position, requestUuid, position, document, 'diagnostic');
            if (diagnosticItems.items.length > 0) {
                disposeWorkflowRace();
                return diagnosticItems;
            }
        }

        if (workflowResult.cachedNoEdit?.predictionComplete) {
            const jump = workflowResult.cachedNoEdit.jump;
            if (jump) {
                try {
                    const target = jump.uri === document.uri.toString()
                        ? document : await vscode.workspace.openTextDocument(vscode.Uri.parse(jump.uri));
                    if (isStale()) { disposeWorkflowRace(); return undefined; }
                    if (target.getText() === jump.targetDocumentText && jump.line < target.lineCount
                        && isEligibleForInlineCompletion(target)) {
                        disposeWorkflowRace();
                        return this._toCursorJumpItems(
                            target, new vscode.Position(jump.line, jump.character), requestUuid, document,
                        );
                    }
                } catch { /* The target may have closed or moved. */ }
                this._workflow.invalidateNoEdit?.(document);
                setTimeout(() => this._onDidChange.fire(), 0);
            }
            disposeWorkflowRace();
            return undefined;
        }

        // Retry via cursor prediction
        if (!promptPieces || !this._cursorPredictor.isEnabled()) {
            this._log.info(`[NES]  NO_RESULT — cursor prediction disabled or no prompt`);
            if (promptPieces) this._workflow.completeNoEditPrediction?.(document, position);
            disposeWorkflowRace();
            return undefined;
        }

        this._log.info(`[NES]  NO_RESULT — attempting cursor prediction retry`);

        // Keep both model calls tied to the editor request. A fixed timeout
        // discards valid cursor predictions from slower local endpoints.
        const predictionContextStamp = this._workflow.getContextStamp?.(document);
        const predictCts = new vscode.CancellationTokenSource();
        const cancelWithOriginal = token.onCancellationRequested(() => predictCts.cancel());
        let completeNoEditPrediction = true;
        let cachedJump: { uri: string; line: number; character: number; targetDocumentText: string } | undefined;
        try {
            const startPredictTime = Date.now();
            const predictionR = await this._cursorPredictor.predict(promptPieces, predictCts.token);
            this._log.info(`[NES]  cursor prediction took ${Date.now() - startPredictTime}ms`);

            if (predictionContextStamp !== undefined
                && this._workflow.getContextStamp?.(document) !== predictionContextStamp) {
                // The location model saw definitions from an older set of
                // open documents. Let the next invocation use fresh context.
                completeNoEditPrediction = false;
                return undefined;
            }
    
            if (predictionR.isError()) {
                this._log.debug(`[NES]  cursor prediction error: ${predictionR.err}`);
                // The edit request conclusively found no change, but a failed
                // location request has not conclusively found no next cursor.
                // Keep its prompt pending so a later editor invocation can
                // retry without repeating the edit model request.
                completeNoEditPrediction = false;
                return undefined;
            }
            if (predictCts.token.isCancellationRequested || isStale()) return undefined;
            const prediction = predictionR.val;
            const targetDocument = await this._resolvePredictionDocument(document, prediction);
            if (!targetDocument || predictCts.token.isCancellationRequested || isStale()) {
                completeNoEditPrediction = false;
                return undefined;
            }
            if (targetDocument.uri.toString() !== document.uri.toString()
                && !isEligibleForInlineCompletion(targetDocument)) {
                this._log.debug(`[NES] predicted cross-file target is disabled`);
                completeNoEditPrediction = false;
                return undefined;
            }
            const targetLine = prediction.lineNumber;
            if (targetLine >= targetDocument.lineCount) {
                completeNoEditPrediction = false;
                return undefined;
            }
            const targetVersion = targetDocument.version;
            const sameFileTarget = targetDocument.uri.toString() === document.uri.toString();
            this._log.debug(`[NES]  retry NES at predicted line ${targetLine}`);

            // Aligns with official: if predicted line falls within the original edit window,
            // the user already saw / is near this area — skip cursor prediction.
            if (sameFileTarget && promptPieces.editWindowLinesRange.contains(targetLine)) {
                this._log.debug(`[NES]  cursor prediction within edit window, skipping retry`);
                return undefined;
            }

            const predictedPos = new vscode.Position(
                targetLine,
                sameFileTarget ? this._nextCursorColumn(targetDocument.lineAt(targetLine).text) : 0,
            );
    
            const startRetryWorkflow = Date.now();
            let retryFailed = false;
            const { editResult: retryResult } = await this._workflow.execute(
                targetDocument, predictedPos, true, predictCts.token, false, false,
            ).catch((error): NesExecutionResult => {
                retryFailed = true;
                this._log.error(`[NES] cursor retry failed: ${error}`);
                return { editResult: undefined };
            });
            this._log.info(`[NES]  retry  workflow took ${Date.now() - startRetryWorkflow}ms`);
            if (predictCts.token.isCancellationRequested || isStale() || targetDocument.version !== targetVersion) {
                completeNoEditPrediction = false;
                if (targetDocument.version !== targetVersion) this._workflow.invalidateNoEdit?.(document);
                return undefined;
            }
    
            if (retryResult && retryResult.edits.length > 0 && (!retryResult.range.isEmpty || retryResult.edit !== '')) {
                completeNoEditPrediction = false;
                retryResult.cursorPrediction = prediction;
                if (!sameFileTarget) {
                    this._workflow.cacheCrossFileEdit(
                        document,
                        {
                            startLine: promptPieces.editWindowLinesRange.start,
                            endLineExclusive: promptPieces.editWindowLinesRange.endExclusive,
                        },
                        targetDocument,
                        predictedPos,
                        retryResult,
                    );
                } else {
                    this._workflow.cacheSameFileCursorJumpEdit(
                        document,
                        {
                            startLine: promptPieces.editWindowLinesRange.start,
                            endLineExclusive: promptPieces.editWindowLinesRange.endExclusive,
                        },
                        predictedPos,
                        retryResult,
                    );
                }
                return this._toInlineItems(retryResult, targetDocument, predictedPos, requestUuid, position, document);
            }
            if (retryFailed) completeNoEditPrediction = false;
            if (retryFailed || !this._config.nextCursorJumpWithoutEdit) return undefined;
            cachedJump = {
                uri: targetDocument.uri.toString(), line: predictedPos.line,
                character: predictedPos.character, targetDocumentText: targetDocument.getText(),
            };
            return this._toCursorJumpItems(targetDocument, predictedPos, requestUuid, document);
        } finally {
            if (completeNoEditPrediction && !predictCts.token.isCancellationRequested && !isStale()) {
                this._workflow.completeNoEditPrediction?.(document, position, cachedJump);
            }
            disposeWorkflowRace();
            cancelWithOriginal.dispose();
            predictCts.dispose();
        }
    }

    private _toCursorJumpItems(
        targetDocument: vscode.TextDocument,
        targetPosition: vscode.Position,
        requestUuid: string,
        requestingDocument: vscode.TextDocument,
    ): NesCompletionList {
        // The inline-completions-additions proposal renders this as a jump
        // action. A text edit or range here would insert unwanted source.
        const item: NesCompletionItem = {
            insertText: undefined as unknown as string,
            jumpToPosition: targetPosition,
            correlationId: requestUuid,
            wasShown: false,
        };
        if (targetDocument.uri.toString() !== requestingDocument.uri.toString()) {
            item.uri = targetDocument.uri;
        }
        this._activeItem = item;
        this._log.info(`[NES] cursor jump to ${targetDocument.uri.toString()}:${targetPosition.line + 1}`);
        return new NesCompletionList(requestUuid, [item]);
    }

    private _toInlineItems(
        result: NextEditResult,
        document: vscode.TextDocument,
        cursorPosition: vscode.Position,
        requestUuid: string,
        requestingPosition: vscode.Position = cursorPosition,
        requestingDocument: vscode.TextDocument = document,
        source: 'provider' | 'diagnostic' = 'provider',
    ): NesCompletionList {
        const info = new NesCompletionInfo(
            result,
            document.uri.toString(),
            document,
            requestUuid,
            source,
        );
        const recentlyAccepted = this._recentlyAcceptedDiagnostic;
        if (source === 'diagnostic' && recentlyAccepted && recentlyAccepted.expires > Date.now()
            && recentlyAccepted.key === this._diagnosticAcceptanceKey(info)) {
            return new NesCompletionList(requestUuid, []);
        }
        this._pruneRejectedSuggestions();
        if (this._rejectedSuggestions.has(this._rejectionKey(info))
            || this._rejectedEditHistory.isRejected(document, result.range, result.edit)) {
            return new NesCompletionList(requestUuid, []);
        }

        // 1. Try to convert to inline (ghost text) suggestion
        // A ghost preview cannot represent secondary edits safely. Keep the
        // primary edit as an inline suggestion only when this is a single edit;
        // bundled changes use the native inline-edit/diff presentation.
        const editCount = result.edits?.length ?? 1;
        const inline = editCount === 1
            ? this._inlineSuggestionResolver.resolve(cursorPosition, document, result.range, result.edit)
            : undefined;

        const isInlineCompletion = !!inline;

        // VS Code filters `isInlineEdit` items when the inline edit feature is
        // disabled. Apply the same gate in the provider so older hosts and
        // alternate inline-completion consumers receive the native behavior.
        if (!isInlineCompletion && !this._isInlineEditsEnabled(document)) {
            this._log.debug(`[NES]  inline edits disabled by editor setting`);
            return new NesCompletionList(requestUuid, []);
        }

        // 2. Gate: suppress if was previously shown as inline but now can't be
        if (
            this._config.mimicGhostTextBehavior
            && result.cacheEntry?.wasRenderedAsInlineSuggestion
            && !isInlineCompletion
        ) {
            this._log.debug(`[NES]  suppressing cached suggestion — was inline, now not`);
            return new NesCompletionList(requestUuid, []);
        }

        // 3. Mark cache entry as rendered inline
        if (isInlineCompletion && result.cacheEntry) {
            result.cacheEntry.wasRenderedAsInlineSuggestion = true;
        }

        // 4. Use adjusted range/text if inline, otherwise precise diff range/text
        const range = inline?.range ?? result.range;
        const insertText = inline?.newText ?? result.edit;
        const unificationState = (vscode.languages as unknown as {
            inlineCompletionsUnificationState?: { extensionUnification?: boolean };
        }).inlineCompletionsUnificationState;
        const extensionUnification = unificationState?.extensionUnification === true;

        // 5. Build item
        const item: NesCompletionItem = {
            insertText,
            range,
            isInlineEdit: !isInlineCompletion,
            isInlineCompletion,
            // The native provider hides the edit menu for a ghost item only
            // while extension unification is active. Older VS Code builds do
            // not expose the state, so preserve their normal menu behavior.
            showInlineEditMenu: !(extensionUnification && isInlineCompletion),
            showInlinedDiff: !isInlineCompletion,
            shouldBeInlineEdit: !isInlineCompletion,
            info,
            action: result.action,
            supportsRename: document.languageId === 'typescript' || document.languageId === 'typescriptreact',
            correlationId: requestUuid,
        };

        if (document.uri.toString() !== requestingDocument.uri.toString()) {
            item.uri = document.uri;
            item.isEditInAnotherDocument = true;
        }
        if (result.cursorPrediction) {
            const displayRange = new vscode.Range(requestingPosition, requestingPosition);
            item.showRange = displayRange;
            item.displayLocation = { range: displayRange, label: 'Go to next edit', kind: 2 };
        }

        if (result.displayLocation) {
            item.displayLocation = {
                range: result.displayLocation.range,
                label: result.displayLocation.label,
                kind: 1,
            };
        }
        this._activeItem = item;
        this._log.info(`[NES]  INLINE_EDIT — showing inline suggestion`);
        return new NesCompletionList(requestUuid, [item]);
    }

    private _isInlineEditsEnabled(document: vscode.TextDocument): boolean {
        return vscode.workspace
            .getConfiguration('editor.inlineSuggest', { uri: document.uri, languageId: document.languageId })
            .get<boolean>('edits.enabled', true) !== false;
    }

    private async _resolvePredictionDocument(
        document: vscode.TextDocument,
        prediction: CursorJumpPrediction,
    ): Promise<vscode.TextDocument | undefined> {
        if (prediction.kind === 'sameFile') return document;
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        const candidates = resolvePredictedFileUris(
            document.uri, folder, vscode.workspace.workspaceFolders ?? [], prediction.filePath,
        );
        for (const uri of candidates) {
            try {
                return await vscode.workspace.openTextDocument(uri);
            } catch (error) {
                this._log.debug(`[NES] predicted document unavailable at ${uri.toString()}: ${error}`);
            }
        }
        return undefined;
    }

    private _nextCursorColumn(line: string): number {
        const firstNonWhitespace = line.search(/\S/);
        return firstNonWhitespace < 0 ? line.length : firstNonWhitespace;
    }

    private _rejectionKey(info: NesCompletionInfo): string {
        const suggestion = info.suggestion;
        return `${info.documentId}:${info.document.version}:${suggestion.range.start.line}:${suggestion.range.start.character}:${suggestion.range.end.line}:${suggestion.range.end.character}:${suggestion.edit}`;
    }

    private _diagnosticAcceptanceKey(info: NesCompletionInfo): string {
        const suggestion = info.suggestion;
        return `${info.documentId}:${suggestion.range.start.line}:${suggestion.range.start.character}:${suggestion.range.end.line}:${suggestion.range.end.character}:${suggestion.edit}`;
    }

    private _pruneRejectedSuggestions(): void {
        const now = Date.now();
        for (const [key, expires] of this._rejectedSuggestions) if (expires <= now) this._rejectedSuggestions.delete(key);
    }

}

/** Keep absolute predictions on the same remote host as the active editor. */
export function resolvePredictedFileUri(
    sourceUri: vscode.Uri,
    workspaceFolderUri: vscode.Uri | undefined,
    filePath: string,
): vscode.Uri | undefined {
    if (path.isAbsolute(filePath)) {
        const hostUri = sourceUri.scheme === 'untitled' ? workspaceFolderUri ?? sourceUri : sourceUri;
        if (!['vscode-remote', 'vscode-vfs'].includes(hostUri.scheme)) return vscode.Uri.file(filePath);
        const normalizedPath = filePath.replace(/\\/g, '/');
        return hostUri.with({ path: /^[A-Za-z]:\//.test(normalizedPath) ? `/${normalizedPath}` : normalizedPath });
    }
    return workspaceFolderUri ? vscode.Uri.joinPath(workspaceFolderUri, filePath) : undefined;
}

/** Resolve multi-root predictions without assuming every relative path belongs to the active root. */
export function resolvePredictedFileUris(
    sourceUri: vscode.Uri,
    activeFolder: vscode.WorkspaceFolder | undefined,
    workspaceFolders: readonly vscode.WorkspaceFolder[],
    filePath: string,
): vscode.Uri[] {
    if (path.isAbsolute(filePath)) {
        const uri = resolvePredictedFileUri(sourceUri, activeFolder?.uri ?? workspaceFolders[0]?.uri, filePath);
        return uri ? [uri] : [];
    }

    const result: vscode.Uri[] = [];
    const seen = new Set<string>();
    const sameHost = (folder: vscode.WorkspaceFolder) => sourceUri.scheme === 'untitled'
        || (folder.uri.scheme === sourceUri.scheme && folder.uri.authority === sourceUri.authority);
    const add = (folder: vscode.WorkspaceFolder, relativePath: string) => {
        const uri = vscode.Uri.joinPath(folder.uri, relativePath);
        const key = uri.toString();
        if (!seen.has(key)) {
            seen.add(key);
            result.push(uri);
        }
    };
    const normalizedPath = filePath.replace(/\\/g, '/');
    const namedRoots = workspaceFolders.filter(folder => normalizedPath.startsWith(`${folder.name}/`));
    if (namedRoots.length > 0) {
        const matchingRoots = namedRoots.filter(sameHost);
        if (matchingRoots.length === 0) return result;
        // The native predictor treats paths as relative to the active root.
        // If that root's name is also the first path component, it may be a
        // real nested directory rather than a multi-root label.
        if (activeFolder && matchingRoots.some(folder => folder.uri.toString() === activeFolder.uri.toString())) {
            add(activeFolder, normalizedPath);
        }
        for (const folder of matchingRoots) {
            add(folder, normalizedPath.slice(folder.name.length + 1));
        }
        if (activeFolder && sameHost(activeFolder)) add(activeFolder, normalizedPath);
        return result;
    }
    if (activeFolder && sameHost(activeFolder)) add(activeFolder, normalizedPath);
    for (const folder of workspaceFolders.filter(sameHost)) add(folder, normalizedPath);
    return result;
}
