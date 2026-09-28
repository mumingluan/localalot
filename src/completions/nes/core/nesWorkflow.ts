import * as vscode from 'vscode';
import { INesConfigProvider } from '../../../config/nesConfig';
import { ILLMAdapterManager } from '../../shared/llm/llmAdapter';
import { isIncompleteLLMResponse, LLMRequest, LLMResponse } from '../../shared/llm/llmRequest';
import { ILogService } from '../../shared/log/logService';
import { CachedEdit, CachedNoEdit, CachedOrRebasedEdit, INextEditCache } from '../nextEditCache';
import { NextEditResult } from '../types';
import { PromptPieces } from '../promptCrafting';
import { AggressivenessLevel } from '../stubs/types';
import { renderCompletionPrompt } from '../promptCraftingUtils';
import { DocumentId } from '../stubs/types';
import { PromptAssembler } from './promptAssembler';
import { EditWindowResolver } from './editWindowResolver';
import { EditResultAssembler } from './editResultAssembler';
import { ResponsePipeline, ResponsePipelineContext } from '../response/responsePipeline';
import { EditFilterChain } from '../response/editFilterChain';
import { ResponseDiffer } from '../response/responseDiffer';
import { allowImportChanges, allowWhitespaceOnlyChanges, filterLineEdits } from '../response/lineEditFilters';
import { NesHistoryTracker } from './nesHistoryTracker';
import { Deferred } from '../../../common/async';
import { SemanticContextService } from '../semanticContextService';
import { ensurePromptTokenizerLoaded, usesO200kPromptTokenizer } from './promptTokenizer';
import { effectiveNesOutputTokens } from './nesModelBudget';
import { detectLanguage } from '../../shared/languageDetection';
import { diagnosticFingerprint } from '../../shared/diagnosticFingerprint';

// Serialize request starts without leaving superseded callers waiting forever.
let lastRequestTime = 0;
let requestGate = Promise.resolve();

async function waitForRequestSlot(signal: AbortSignal, stillNeeded: () => boolean): Promise<boolean> {
    const previous = requestGate;
    let release!: () => void;
    requestGate = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
        if (signal.aborted || !stillNeeded()) return false;
        while (true) {
            const waitTime = Math.max(0, 200 - (Date.now() - lastRequestTime));
            if (waitTime === 0) break;
            // A canceled caller should release this serialized slot promptly
            // so the next visible edit is not queued behind a stale request.
            await new Promise<void>(resolve => setTimeout(resolve, Math.min(waitTime, 25)));
            if (signal.aborted || !stillNeeded()) return false;
        }
        lastRequestTime = Date.now();
        return true;
    } finally {
        release();
    }
}

export interface NesExecutionResult {
    editResult: NextEditResult | undefined;
    cachedNoEdit?: CachedNoEdit;
    /** Undefined when editResult exists or the request was cancelled/disabled early. */
    promptPieces?: PromptPieces;
    /** Set when a cache entry is owned by the active document but edits target another file. */
    targetDocument?: vscode.TextDocument;
    targetPosition?: vscode.Position;
}

interface PendingNesRequest {
    headerRequestId: string;
    documentUri: string;
    documentText: string;
    configRevision: number;
    diagnosticRevision: number;
    contextStamp: string;
    position: vscode.Position;
    /** A prefetch is safe to claim only while the cursor is still near its seed. */
    speculative: boolean;
    abortController: AbortController;
    liveDependants: number;
    deferred: Deferred<NesExecutionResult>;
}

interface RejectedEditHint {
    readonly expires: number;
    readonly text: string;
}

export class NesWorkflow {
    private readonly _editWindowResolver = new EditWindowResolver();
    private readonly _promptAssembler: PromptAssembler;
    private readonly _responsePipeline = new ResponsePipeline();
    private readonly _editFilterChain = new EditFilterChain();
    private readonly _responseDiffer = new ResponseDiffer();
    private readonly _resultAssembler: EditResultAssembler;

    private readonly _historyTracker = new NesHistoryTracker();
    private readonly _semanticContext = new SemanticContextService();

    private _pendingRequest: PendingNesRequest | undefined;
    /** The post-accept request survives visible calls made during type-through. */
    private _pendingSpeculativeRequest: PendingNesRequest | undefined;
    private readonly _activeRequests = new Map<AbortController, string>();
    private _observedConfigRevision: number | undefined;
    private _clearGeneration = 0;
    private _expandedWindowGeneration = 0;
    private _consumedExpandedWindowGeneration = 0;
    private readonly _diagnosticRevisions = new Map<string, number>();
    private readonly _diagnosticFingerprints = new Map<string, string>();
    private readonly _rejectedEdits = new Map<string, RejectedEditHint[]>();

    constructor(
        @INesConfigProvider private readonly _config: INesConfigProvider,
        @ILLMAdapterManager private readonly _llmManager: ILLMAdapterManager,
        @ILogService private readonly _log: ILogService,
        @INextEditCache private readonly _cache: INextEditCache,
    ) {
        this._promptAssembler = new PromptAssembler(_config, this._editWindowResolver);
        this._resultAssembler = new EditResultAssembler(this._editWindowResolver);
    }

    dispose(): void {
        for (const controller of this._activeRequests.keys()) controller.abort();
        this._activeRequests.clear();
        this._pendingRequest = undefined;
        this._pendingSpeculativeRequest = undefined;
        this._historyTracker.dispose();
    }

    clearPendingAndCachedEdits(): void {
        this._clearGeneration++;
        this._consumedExpandedWindowGeneration = this._expandedWindowGeneration;
        for (const controller of this._activeRequests.keys()) controller.abort();
        this._pendingRequest?.abortController.abort();
        this._pendingSpeculativeRequest?.abortController.abort();
        this._pendingRequest = undefined;
        this._pendingSpeculativeRequest = undefined;
        this._cache.clearAll();
    }

    setAggressiveness(level: AggressivenessLevel): void {
        this._promptAssembler.setAggressiveness(level);
    }

    /** The next network request can continue a just-accepted edit farther down the file. */
    noteAcceptedEdit(): void {
        this._expandedWindowGeneration++;
    }

    completeNoEditPrediction(document: vscode.TextDocument, position: vscode.Position, jump?: CachedNoEdit['jump']): void {
        this._cache.markNoNextEditPredictionComplete(
            DocumentId.create(document.uri.toString()), document.getText(), position.line, jump, position.character,
        );
    }

    getContextStamp(document: vscode.TextDocument): string {
        return this._cache.getContextStamp(DocumentId.create(document.uri.toString()));
    }

    invalidateNoEdit(document: vscode.TextDocument): void {
        this._cache.clearNoNextEdit(DocumentId.create(document.uri.toString()));
    }

    noteDiagnosticsChanged(documentUri: string, diagnostics?: readonly vscode.Diagnostic[]): boolean {
        if (diagnostics) {
            const fingerprint = diagnosticFingerprint(diagnostics);
            if (fingerprint === this._diagnosticFingerprints.get(documentUri)) return false;
            this._diagnosticFingerprints.set(documentUri, fingerprint);
        }
        this._diagnosticRevisions.set(documentUri, (this._diagnosticRevisions.get(documentUri) ?? 0) + 1);
        this._cache.clear(DocumentId.create(documentUri));
        for (const [controller, uri] of this._activeRequests) {
            if (uri === documentUri) controller.abort();
        }
        for (const pending of [this._pendingRequest, this._pendingSpeculativeRequest]) {
            if (pending?.documentUri === documentUri) pending.abortController.abort();
        }
        return true;
    }

    recordRejectedEdit(documentId: string, range: vscode.Range, edit: string): void {
        if (!edit) return;
        const hints = this._rejectedEdits.get(documentId) ?? [];
        hints.push({
            expires: Date.now() + 60_000,
            text: `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1} ${edit.slice(0, 700)}`,
        });
        this._rejectedEdits.set(documentId, hints.slice(-3));
    }

    async execute(
        document: vscode.TextDocument,
        position: vscode.Position,
        lintEnable: boolean,
        token?: vscode.CancellationToken,
        speculative = false,
        allowNoEditCache = true,
    ): Promise<NesExecutionResult> {
        const t0 = Date.now();
        this._log.info(`[NES]  ===== START =====`);

        // Step 0.5: Check for pending in-flight request
        const docUri = document.uri.toString();
        const diagnosticRevision = this._diagnosticRevisions.get(docUri) ?? 0;
        const docText = document.getText();
        const docId = DocumentId.create(docUri);
        const currentContextStamp = this._cache.getContextStamp(docId);
        const configRevision = this._config.revision ?? 0;
        const clearGeneration = this._clearGeneration;
        if (this._observedConfigRevision !== undefined && this._observedConfigRevision !== configRevision) {
            this._cache.clearAll();
            this._pendingRequest?.abortController.abort();
            this._pendingSpeculativeRequest?.abortController.abort();
            this._log.debug(`[NES]  CLEAR cached and pending edits after config change`);
        }
        this._observedConfigRevision = configRevision;

        // A cancelled editor request must not wait for another caller's stream.
        // The same applies when NES was disabled while a request was in flight.
        if (token?.isCancellationRequested) {
            this._log.info(`[NES]  CANCEL before_start`);
            return { editResult: undefined };
        }
        if (!this._config.enabled) {
            this._log.info(`[NES]  SKIP — disabled by config`);
            return { editResult: undefined };
        }
        if (this._config.endpointConfigured === false) {
            this._log.debug(`[NES]  SKIP — configure nes.baseUrl to enable requests`);
            return { editResult: undefined };
        }

        const pending = [this._pendingSpeculativeRequest, this._pendingRequest].find(candidate => {
            if (!candidate || candidate.abortController.signal.aborted || candidate.configRevision !== configRevision
                || candidate.diagnosticRevision !== diagnosticRevision
                || candidate.contextStamp !== currentContextStamp) return false;
            if (candidate.documentUri !== docUri || candidate.documentText !== docText) return false;
            const lineDistance = Math.abs(candidate.position.line - position.line);
            // The generated edit is tied to the seed cursor's edit window.
            // A nearby cursor outside that window needs its own prompt.
            const seedWindow = this._editWindowResolver.resolve({
                lineCount: document.lineCount,
                lineText: line => document.lineAt(line).text,
            }, candidate.position.line);
            if (!seedWindow.contains(position.line)) return false;
            return candidate.speculative
                ? lineDistance <= 3 && (lineDistance > 0 || Math.abs(candidate.position.character - position.character) <= 160)
                : lineDistance <= 10;
        });
        if (pending) {
            // Join existing pending request
            this._log.info(`[NES]  JOIN pending=${pending.headerRequestId} liveDependants=${pending.liveDependants}`);
            pending.liveDependants++;
            let cancelled = false;

            let resolveCancelled!: (result: NesExecutionResult) => void;
            const cancelledResult = new Promise<NesExecutionResult>(resolve => { resolveCancelled = resolve; });

            const cancelJoined = () => {
                if (cancelled) return;
                cancelled = true;
                pending.liveDependants--;
                resolveCancelled({ editResult: undefined });
                if (pending.liveDependants <= 0) {
                    this._log.info(`[NES]  ABORT — all dependants gone.`);
                    setTimeout(() => {
                        if (pending.liveDependants <= 0) {
                            pending.abortController.abort();
                        }
                    }, 1200);
                }
            };
            const cancelDisposable = token?.onCancellationRequested(cancelJoined);
            if (token?.isCancellationRequested) cancelJoined();

            try {
                const result = await (token
                    ? Promise.race([pending.deferred.promise, cancelledResult])
                    : pending.deferred.promise);
                this._log.info(`[NES]  JOIN_RESULT edit=${result.editResult?.edit.length ?? 0}ch`);
                if (cancelled || token?.isCancellationRequested) return { editResult: undefined };
                if (document.getText() === docText
                    && this._cache.getContextStamp(docId) === pending.contextStamp
                    && (this._config.revision ?? 0) === configRevision
                    && (this._diagnosticRevisions.get(docUri) ?? 0) === diagnosticRevision) {
                    return result;
                }
                this._log.debug(`[NES]  DISCARD joined result after context changed`);
            } finally {
                if (!cancelled) pending.liveDependants--;
                cancelDisposable?.dispose();
            }
        }
        if (this._pendingRequest?.liveDependants === 0) this._pendingRequest = undefined;
        if (speculative && this._pendingRequest && !this._pendingRequest.abortController.signal.aborted) {
            // A background prefetch must not replace a visible request.
            this._log.debug(`[NES]  SKIP speculative request — visible request in flight`);
            return { editResult: undefined };
        }

        // Step 1: Cache lookup
        const t1 = Date.now();
        const cached = this._cache.lookupNextEdit(DocumentId.create(document.uri.toString()), document, position);
        if (cached) {
            this._log.info(`[NES]  CACHE_HIT edit=${cached.edit.length}ch age=${Date.now() - cached.cacheTime}ms total=${Date.now() - t0}ms`);
            if (token?.isCancellationRequested) {
                this._log.info(`[NES]  CANCEL after_cache_hit`);
                return { editResult: undefined };
            }
            if (cached.targetDocId && cached.targetDocumentBeforeEdit !== undefined) {
                try {
                    const targetDocument = await vscode.workspace.openTextDocument(cached.targetDocId.toUri());
                    if ((this._config.revision ?? 0) !== configRevision) return { editResult: undefined };
                    if (targetDocument.getText() !== cached.targetDocumentBeforeEdit
                        || document.getText() !== docText
                        || this._cache.getContextStamp(docId) !== cached.contextStamp) {
                        // The edit offsets belong to the target snapshot. Keep the
                        // owner cache from serving stale coordinates after a target
                        // file was changed independently.
                        this._cache.clear(DocumentId.create(document.uri.toString()));
                    } else {
                        const targetWindow = cached.targetEditWindow ?? cached.editWindow;
                        const targetPosition = cached.targetPosition
                            ? new vscode.Position(cached.targetPosition.line, cached.targetPosition.character)
                            : new vscode.Position(targetWindow.startLine, 0);
                        const result = this._buildResultFromCached(cached, targetDocument, targetPosition, targetWindow);
                        if (result.edits.length > 0) {
                            this._log.info(`edit = '${result.edit}', editfull = '${result.fullEditText}'\n range = (start = ${result.range.start}, end =${result.range.end}), cursorAfterEdit = ${result.cursorAfterEdit}\njump = ${result.isFromCursorJump}, ${result.jumpToPosition}`);
                            return { editResult: result, targetDocument, targetPosition };
                        }
                        this._cache.clear(DocumentId.create(document.uri.toString()));
                    }
                } catch {
                    this._cache.clear(DocumentId.create(document.uri.toString()));
                }
            } else {
                const result = this._buildResultFromCached(cached, document, position);
                if (result.edits.length > 0) {
                    const originalWindow = cached.originalEditWindow;
                    const inTargetWindow = position.line >= cached.editWindow.startLine
                        && position.line < cached.editWindow.endLineExclusive;
                    if (originalWindow && !inTargetWindow
                        && position.line >= originalWindow.startLine
                        && position.line < originalWindow.endLineExclusive) {
                        result.cursorPrediction = { kind: 'sameFile', lineNumber: cached.targetPosition?.line ?? cached.editWindow.startLine };
                    }
                    this._log.info(`edit = '${result.edit}', editfull = '${result.fullEditText}'\n range = (start = ${result.range.start}, end =${result.range.end}), cursorAfterEdit = ${result.cursorAfterEdit}\njump = ${result.isFromCursorJump}, ${result.jumpToPosition}`);
                    return { editResult: result };
                }
                this._cache.clear(DocumentId.create(document.uri.toString()));
            }
        }
        const needsExpandedWindow = !speculative
            && this._expandedWindowGeneration > this._consumedExpandedWindowGeneration;
        const noEdit = !needsExpandedWindow
            ? this._cache.getNoNextEdit(DocumentId.create(docUri), document, position) : undefined;
        if (noEdit) {
            this._log.info(`[NES]  CACHE_HIT no edit total=${Date.now() - t0}ms`);
            return {
                editResult: undefined,
                promptPieces: noEdit.predictionComplete ? undefined : noEdit.promptPieces,
                cachedNoEdit: noEdit,
            };
        }
        this._log.debug(`[NES]  cache_miss [${Date.now() - t1}ms]`);

        if (token?.isCancellationRequested) {
            this._log.info(`[NES]  CANCEL after_cache_miss`);
            return { editResult: undefined };
        }

        // Step 2: Build prompt
        let promptAssembly;
        let expandedWindowGeneration: number | undefined;
        try {
            const xtabHistory = this._historyTracker.getHistory(DocumentId.create(document.uri.toString()));
            const semanticSnippets = await this._semanticContext.collect(document, position, token);
            if (usesO200kPromptTokenizer(this._config.family)) {
                await ensurePromptTokenizerLoaded();
            }
            if (token?.isCancellationRequested || clearGeneration !== this._clearGeneration) return { editResult: undefined };
            const rejected = (this._rejectedEdits.get(docUri) ?? []).filter(item => item.expires > Date.now());
            this._rejectedEdits.set(docUri, rejected);
            expandedWindowGeneration = !speculative && this._expandedWindowGeneration > this._consumedExpandedWindowGeneration
                ? this._expandedWindowGeneration : undefined;
            promptAssembly = this._promptAssembler.assemble(
                document, position, lintEnable, xtabHistory, semanticSnippets, rejected.map(item => item.text),
                expandedWindowGeneration === undefined ? undefined : 10,
            );
        } catch {
            this._log.info(`[NES]  SKIP — prompt too large`);
            return { editResult: undefined };
        }

        if (token?.isCancellationRequested) {
            this._log.info(`[NES]  CANCEL after_prompt_build`);
            return { editResult: undefined };
        }
        if ((this._config.revision ?? 0) !== configRevision || clearGeneration !== this._clearGeneration) {
            this._log.info(`[NES]  CANCEL — configuration or cache changed during prompt build`);
            return { editResult: undefined };
        }
        const requestContextStamp = this._cache.getContextStamp(docId);

        // Step 3: Network request (streaming)
        const t4 = Date.now();
        const endpoint = this._config.endpoint;
        const maxOutputTokens = effectiveNesOutputTokens(
            this._config.capabilities?.limits?.max_context_window_tokens,
            this._config.maxOutputTokens,
        );
        const adapter = this._llmManager.getAdapter(endpoint);
        const abortController = new AbortController();
        const headerRequestId = `nes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const deferred = new Deferred<NesExecutionResult>();
        const pendingRequest: PendingNesRequest = {
            headerRequestId,
            documentUri: docUri,
            documentText: docText,
            configRevision,
            diagnosticRevision,
            contextStamp: requestContextStamp,
            position,
            speculative,
            abortController,
            liveDependants: 1,
            deferred,
        };
        // Prompt/context collection is asynchronous. A visible request may have
        // started while this prefetch was building its prompt.
        if (speculative && this._pendingRequest && !this._pendingRequest.speculative
            && this._pendingRequest.liveDependants > 0 && !this._pendingRequest.abortController.signal.aborted) {
            this._log.debug(`[NES]  SKIP speculative request — visible request started during prompt build`);
            return { editResult: undefined };
        }
        this._activeRequests.set(abortController, docUri);
        // Keep a post-accept speculative stream separate from the visible
        // stream for partially typed text. The provider cancels speculation
        // when the document leaves the type-through trajectory.
        if (speculative) {
            this._pendingSpeculativeRequest?.abortController.abort();
            this._pendingSpeculativeRequest = pendingRequest;
        } else {
            this._pendingRequest?.abortController.abort();
            this._pendingRequest = pendingRequest;
        }
        let cancelTimer: ReturnType<typeof setTimeout> | undefined;
        let originalCancelled = false;
        const cancelListener = token?.onCancellationRequested(() => {
            if (originalCancelled) return;
            originalCancelled = true;
            pendingRequest.liveDependants--;
            this._log.info(`[NES]  ABORT — CancellationToken triggered.`);
            if (cancelTimer) clearTimeout(cancelTimer);
            cancelTimer = setTimeout(() => {
                if (abortController.signal.aborted) return;
                if (pendingRequest.liveDependants > 0) {
                    this._log.info(`[NES]  ABORT — skipped (${pendingRequest.liveDependants} dependants)`);
                    return;
                }
                this._log.info(`[NES]  ABORT — executing after.`);
                abortController.abort();
            }, 1200);
        });

        this._log.debug(`[NES]  endpoint=${endpoint} model=${this._config.model} max_tokens=${maxOutputTokens}`);

        let backgroundStreamStarted = false;
        try {
            if (!await waitForRequestSlot(abortController.signal, () =>
                pendingRequest.liveDependants > 0
                && document.getText() === docText
                && (this._config.revision ?? 0) === configRevision
                && (this._diagnosticRevisions.get(docUri) ?? 0) === diagnosticRevision
                && this._cache.getContextStamp(docId) === requestContextStamp
                && clearGeneration === this._clearGeneration
                && this._config.enabled
            )) {
                const cancelled: NesExecutionResult = { editResult: undefined };
                deferred.resolve(cancelled);
                return cancelled;
            }
            this._log.info(`[NES]  REQUEST sent [${Date.now() - t4}ms] requestId=${headerRequestId} endpoint=${endpoint} model=${this._config.model} max_tokens=${maxOutputTokens}`);
            if (expandedWindowGeneration !== undefined) {
                this._consumedExpandedWindowGeneration = Math.max(
                    this._consumedExpandedWindowGeneration, expandedWindowGeneration,
                );
            }
            const useStream = this._config.stream !== false;
            const request: LLMRequest = {
                baseUrl: this._config.baseUrl,
                apiKey: this._config.apiKey,
                model: this._config.model,
                family: this._config.family,
                max_tokens: maxOutputTokens,
                temperature: 0,
                top_p: 1,
                n: 1,
                stream: useStream,
                presence_penalty: this._config.presencePenalty,
                frequency_penalty: this._config.frequencyPenalty,
                capabilities: {
                    thinking: this._config.capabilities.supports.thinking,
                    reasoning_effort: this._config.capabilities.supports.reasoning_effort,
                },
            };
            if (endpoint === 'completions') {
                const prompt = renderCompletionPrompt(
                    this._config.promptTemplate,
                    promptAssembly.systemPrompt,
                    promptAssembly.userPrompt,
                );
                this._log.debug('completions\n' + prompt);
                request.prompt = prompt;
            } else {
                this._log.debug('chat/completions \n' + promptAssembly.userPrompt);
                request.messages = [
                    { role: 'system', content: promptAssembly.systemPrompt },
                    { role: 'user', content: promptAssembly.userPrompt },
                ];
            }
            const stream: AsyncGenerator<string, LLMResponse> = useStream
                ? adapter.sendStream(request, abortController.signal)
                : (async function* (): AsyncGenerator<string, LLMResponse> {
                    const response = await adapter.send(request, abortController.signal);
                    if (response.text) yield response.text;
                    return response;
                })();

            let accumulated = '';
            let finalResponse: LLMResponse | undefined;
            let firstEditResolved = false;
            let firstResult: NextEditResult | undefined;
            const editWindowHadCursorTag = promptAssembly.editWindowLines.some(l => l.includes('<|cursor|>'));
            const pipelineContext: ResponsePipelineContext = {
                editWindowHadCursorTag,
                languageId: detectLanguage(document).languageId,
                originalEditWindowLines: promptAssembly.editWindowLines,
            };

            // Use next() directly: breaking a for-await loop calls return() on
            // the iterator and would close the stream before the background
            // reader can collect later edits.
            while (true) {
                const next = await stream.next();
                if ((this._diagnosticRevisions.get(docUri) ?? 0) !== diagnosticRevision) {
                    abortController.abort();
                    break;
                }
                if ((this._config.revision ?? 0) !== configRevision) {
                    abortController.abort();
                    break;
                }
                if (this._cache.getContextStamp(docId) !== requestContextStamp) {
                    abortController.abort();
                    break;
                }
                if (next.done) {
                    finalResponse = next.value;
                    if (finalResponse?.text && finalResponse.text.startsWith(accumulated)) {
                        accumulated = finalResponse.text;
                    }
                    break;
                }
                if (abortController.signal.aborted) break;

                const delta = next.value;
                accumulated += delta;

                if (!firstEditResolved) {
                    const responseComplete = accumulated.includes('###remain edit end boundary line###');
                    let parsedLines: string[] | undefined;
                    let progressiveEarlyEdit = false;
                    if (responseComplete) {
                        parsedLines = this._responsePipeline.process(accumulated, pipelineContext);
                    } else {
                        const completedLines = this._responsePipeline.processCompletedMarkedPrefix(accumulated, pipelineContext);
                        if (completedLines) {
                            const converged = filterLineEdits(
                                this._responseDiffer.computeConverged(promptAssembly.editWindowLines, completedLines),
                                promptAssembly.editWindowLines,
                                detectLanguage(document).languageId,
                                allowWhitespaceOnlyChanges(document),
                                allowImportChanges(document),
                            );
                            const fastCursorLine = this._responseDiffer.computeFastCursorLine(
                                promptAssembly.editWindowLines,
                                completedLines,
                                position.line - promptAssembly.editWindowRange.start,
                                position.line + 1 < document.lineCount ? document.lineAt(position.line + 1).text : undefined,
                            );
                            const first = converged[0] ?? (fastCursorLine && filterLineEdits(
                                [fastCursorLine], promptAssembly.editWindowLines, detectLanguage(document).languageId,
                                allowWhitespaceOnlyChanges(document),
                                allowImportChanges(document),
                            )[0]);
                            if (first) {
                                parsedLines = [...promptAssembly.editWindowLines];
                                parsedLines.splice(
                                    first.lineRange.startLineNumber - 1,
                                    first.lineRange.endLineNumberExclusive - first.lineRange.startLineNumber,
                                    ...first.newLines,
                                );
                                progressiveEarlyEdit = converged.length === 0;
                            }
                        }
                    }
                    if (parsedLines && parsedLines.length > 0 && !parsedLines.every(l => l.trim() === '')) {
                        const finalEdit = this._editFilterChain.apply(parsedLines, promptAssembly.editWindowLines);
                        if (finalEdit) {
                            this._log.info('\n' + parsedLines.join('\n'));
                            const result = this._resultAssembler.assemble(
                                parsedLines,
                                document,
                                position,
                                undefined,
                                this._config.suffixOverlapThreshold,
                                this._config.suffixOverlapType,
                                this._log,
                                { start: promptAssembly.editWindowRange.start, endExclusive: promptAssembly.editWindowRange.endExclusive },
                                { skipDuplicateAdditions: progressiveEarlyEdit },
                            );
                            if (result.edits.length === 0) continue;
                            firstResult = result;
                            firstEditResolved = true;
                            const streamedCacheEntry: CachedEdit = {
                                docId: DocumentId.create(document.uri.toString()),
                                documentBeforeEdit: docText,
                                editWindow: {
                                    startLine: promptAssembly.editWindowRange.start,
                                    endLineExclusive: promptAssembly.editWindowRange.endExclusive,
                                },
                                edit: finalEdit,
                                cacheTime: Date.now(),
                                cursorLineAtCacheTime: position.line,
                            };
                            this._cache.setKthNextEdit(streamedCacheEntry.docId, streamedCacheEntry);
                            result.cacheEntry = streamedCacheEntry;
                            this._stageFollowingEdit(document, docText, promptAssembly.editWindowRange, parsedLines, result);

                            const networkMs = Date.now() - t4;
                            this._log.info(`[NES]  FIRST_EDIT network=${networkMs}ms edit=${result.edit.length}ch`);

                            // Background: continue consuming stream to populate cache
                            backgroundStreamStarted = true;
                            void this._consumeRemainingStream(
                                stream, accumulated,
                                DocumentId.create(document.uri.toString()),
                                docText, document,
                                position, promptAssembly,
                                pipelineContext, abortController.signal, result, configRevision, diagnosticRevision,
                                requestContextStamp,
                            ).catch(err => {
                                if ((err as { name?: string })?.name !== 'AbortError') {
                                    this._log.error(`[NES]  background_stream error: ${err}`);
                                }
                            }).finally(() => {
                                this._activeRequests.delete(abortController);
                            });
                            break;
                        }
                    }
                }
            }

            // If first edit was found during streaming, return it immediately
            if (firstResult) {
                const totalMs = Date.now() - t0;
                this._log.info(`[NES]  RESULT (streaming) edit=${firstResult.edit.length}ch total=${totalMs}ms`);
                this._log.info(`edit = '${firstResult.edit}', editfull = '${firstResult.fullEditText}'\n range = (start = ${firstResult.range.start}, end =${firstResult.range.end}), cursorAfterEdit = ${firstResult.cursorAfterEdit}\njump = ${firstResult.isFromCursorJump}, ${firstResult.jumpToPosition}`);
                const nesResult: NesExecutionResult = { editResult: firstResult, promptPieces: promptAssembly.promptPieces };
                deferred.resolve(nesResult);
                return nesResult;
            }

            // An adapter may end its iterator normally after the signal is
            // aborted. Its accumulated text is then only a partial response.
            if (abortController.signal.aborted) {
                const cancelled: NesExecutionResult = { editResult: undefined };
                deferred.resolve(cancelled);
                return cancelled;
            }

            // A model that hit its output limit may have stopped halfway
            // through an unmarked replacement. Only a closed edit window is
            // safe to use from such a response.
            if ((!finalResponse || isIncompleteLLMResponse(finalResponse))
                && !this._responsePipeline.hasCompleteMarkedWindow(accumulated)) {
                this._log.info(`[NES]  INCOMPLETE_EDIT finish=${finalResponse?.finishReason}`);
                const incomplete: NesExecutionResult = { editResult: undefined, promptPieces: promptAssembly.promptPieces };
                deferred.resolve(incomplete);
                return incomplete;
            }

            const cacheNoEdit = () => {
                if (!allowNoEditCache || !finalResponse || isIncompleteLLMResponse(finalResponse)
                    || (this._config.revision ?? 0) !== configRevision
                    || (this._diagnosticRevisions.get(docUri) ?? 0) !== diagnosticRevision
                    || this._cache.getContextStamp(docId) !== requestContextStamp
                    || clearGeneration !== this._clearGeneration
                    || document.getText() !== docText) return;
                this._cache.setNoNextEdit(
                    DocumentId.create(docUri), docText,
                    { startLine: promptAssembly.editWindowRange.start, endLineExclusive: promptAssembly.editWindowRange.endExclusive },
                    position.line, promptAssembly.promptPieces, position.character,
                );
            };

            // Fallback: stream completed without finding an edit
            const networkMs = Date.now() - t4;
            this._log.info(`[NES]  NETWORK finish (no first edit) [${networkMs}ms]`);
            this._log.info('\n' + accumulated);

            // Step 4: Response pipeline (on full accumulated text)
            const parsedLines = this._responsePipeline.process(accumulated, pipelineContext);
            if (!parsedLines || parsedLines.length === 0
                || (parsedLines.every(l => l.trim() === '')
                    && !this._responsePipeline.hasCompleteMarkedWindow(accumulated))) {
                if (this._responsePipeline.isExplicitDeletion(accumulated)
                    && promptAssembly.editWindowLines.some(line => line.trim() !== '')) {
                    const deletion = this._resultAssembler.assemble(
                        [], document, position, undefined,
                        this._config.suffixOverlapThreshold, this._config.suffixOverlapType, this._log,
                        { start: promptAssembly.editWindowRange.start, endExclusive: promptAssembly.editWindowRange.endExclusive },
                    );
                    if (deletion.edits.length > 0) {
                        const nesResult: NesExecutionResult = { editResult: deletion, promptPieces: promptAssembly.promptPieces };
                        deferred.resolve(nesResult);
                        return nesResult;
                    }
                }
                this._log.info(`[NES]  EMPTY_EDIT — pipeline returned no content total=${Date.now() - t0}ms`);
                if (accumulated.trim() === '') cacheNoEdit();
                const nesResult: NesExecutionResult = { editResult: undefined, promptPieces: promptAssembly.promptPieces };
                deferred.resolve(nesResult);
                return nesResult;
            }

            // Step 5: Edit filtering
            const finalEdit = this._editFilterChain.apply(parsedLines, promptAssembly.editWindowLines);
            if (finalEdit === undefined) {
                this._log.info(`[NES]  FILTERED — edit rejected by filter chain total=${Date.now() - t0}ms`);
                if (parsedLines.join('\n') === promptAssembly.editWindowLines.join('\n')) cacheNoEdit();
                const nesResult: NesExecutionResult = { editResult: undefined, promptPieces: promptAssembly.promptPieces };
                deferred.resolve(nesResult);
                return nesResult;
            }

            // Step 6: Build result
            const result = this._resultAssembler.assemble(
                parsedLines, document, position, undefined,
                this._config.suffixOverlapThreshold, this._config.suffixOverlapType, this._log,
                { start: promptAssembly.editWindowRange.start, endExclusive: promptAssembly.editWindowRange.endExclusive },
            );
            if (result.edits.length === 0) {
                if (parsedLines.join('\n') === promptAssembly.editWindowLines.join('\n')) cacheNoEdit();
                const nesResult: NesExecutionResult = { editResult: undefined, promptPieces: promptAssembly.promptPieces };
                deferred.resolve(nesResult);
                return nesResult;
            }

            // Step 7: Cache result
            const cacheEntry: CachedEdit = {
                docId,
                documentBeforeEdit: docText,
                editWindow: {
                    startLine: promptAssembly.editWindowRange.start,
                    endLineExclusive: promptAssembly.editWindowRange.endExclusive,
                },
                edit: finalEdit,
                cacheTime: Date.now(),
                cursorLineAtCacheTime: position.line,
            };
            this._cache.setKthNextEdit(docId, cacheEntry);

            result.cacheEntry = cacheEntry;
            this._stageFollowingEdit(document, docText, promptAssembly.editWindowRange, parsedLines, result);

            const totalMs = Date.now() - t0;
            this._log.info(`[NES]  RESULT (fallback) edit=${result.edit.length}ch total=${totalMs}ms`);
            this._log.info(`edit = '${result.edit}', editfull = '${result.fullEditText}'\n range = (start = ${result.range.start}, end =${result.range.end}), cursorAfterEdit = ${result.cursorAfterEdit}\njump = ${result.isFromCursorJump}, ${result.jumpToPosition}`);

            const nesResult: NesExecutionResult = { editResult: result, promptPieces: promptAssembly.promptPieces };
            deferred.resolve(nesResult);
            return nesResult;

        } catch (err) {
            if ((err as { name?: string })?.name === 'AbortError') {
                this._log.info(`[NES]  ABORTED after ${Date.now() - t0}ms`);
                deferred.resolve({ editResult: undefined });
                return { editResult: undefined };
            }
            this._log.error(`[NES]  ERROR after ${Date.now() - t0}ms: ${err}`);
            deferred.resolve({ editResult: undefined });
            return { editResult: undefined };
        } finally {
            if (!backgroundStreamStarted) this._activeRequests.delete(abortController);
            if (cancelTimer) clearTimeout(cancelTimer);
            cancelListener?.dispose();
            if (this._pendingRequest === pendingRequest) {
                this._pendingRequest = undefined;
            }
            if (this._pendingSpeculativeRequest === pendingRequest) {
                this._pendingSpeculativeRequest = undefined;
            }
        }
    }

    private async _consumeRemainingStream(
        stream: AsyncGenerator<string, LLMResponse>,
        accumulated: string,
        docId: DocumentId,
        documentText: string,
        document: vscode.TextDocument,
        position: vscode.Position,
        promptAssembly: { promptPieces: PromptPieces; editWindowLines: string[]; editWindowRange: { start: number; endExclusive: number } },
        pipelineContext: ResponsePipelineContext,
        signal: AbortSignal,
        shownResult: NextEditResult,
        configRevision: number,
        diagnosticRevision: number,
        contextStamp: string,
    ): Promise<void> {
        let text = accumulated;
        let stagedPrefix = '';
        let lastCompletedOffset = text.lastIndexOf('\n');
        let finalResponse: LLMResponse | undefined;
        while (true) {
            const next = await stream.next();
            if (next.done) {
                finalResponse = next.value;
                if (finalResponse?.text && finalResponse.text.startsWith(text)) {
                    text = finalResponse.text;
                }
                break;
            }
            if (signal.aborted || (this._config.revision ?? 0) !== configRevision
                || (this._diagnosticRevisions.get(docId.uri) ?? 0) !== diagnosticRevision
                || this._cache.getContextStamp(docId) !== contextStamp) return;
            const delta = next.value;
            text += delta;
            if (shownResult.cacheEntry?.rejected) return;
            const completedOffset = text.lastIndexOf('\n');
            if (completedOffset <= lastCompletedOffset) continue;
            lastCompletedOffset = completedOffset;
            const completedLines = this._responsePipeline.processCompletedMarkedPrefix(text, pipelineContext);
            if (!completedLines) continue;
            const converged = filterLineEdits(
                this._responseDiffer.computeConverged(promptAssembly.editWindowLines, completedLines),
                promptAssembly.editWindowLines,
                pipelineContext.languageId ?? '',
                allowWhitespaceOnlyChanges(document),
                allowImportChanges(document),
            );
            if (converged.length < 2) continue;
            const nextLines = [...promptAssembly.editWindowLines];
            // Diff ranges refer to the original window. Apply from the end so
            // earlier line offsets remain stable when an edit adds lines.
            for (const edit of [...converged].reverse()) {
                nextLines.splice(
                    edit.lineRange.startLineNumber - 1,
                    edit.lineRange.endLineNumberExclusive - edit.lineRange.startLineNumber,
                    ...edit.newLines,
                );
            }
            const fingerprint = nextLines.join('\n');
            if (fingerprint === stagedPrefix) continue;
            const firstPatch = converged[0];
            const firstPatchLine = promptAssembly.editWindowRange.start + firstPatch.lineRange.startLineNumber - 1;
            if (firstPatchLine !== shownResult.range.start.line
                || firstPatch.newLines.join('\n') !== shownResult.fullEditText) continue;
            stagedPrefix = fingerprint;
            this._stageFollowingEdit(
                document, documentText, promptAssembly.editWindowRange, nextLines, shownResult,
            );
        }
        if (signal.aborted || (this._config.revision ?? 0) !== configRevision
            || (this._diagnosticRevisions.get(docId.uri) ?? 0) !== diagnosticRevision
            || this._cache.getContextStamp(docId) !== contextStamp) return;
        if (shownResult.cacheEntry?.rejected) return;
        if ((!finalResponse || isIncompleteLLMResponse(finalResponse))
            && !this._responsePipeline.hasCompleteMarkedWindow(text)) return;
        const afterShownEdit = this._documentAfterShownEdit(document, documentText, shownResult);
        const currentText = document.getText();
        // The first streamed edit may already have been accepted while the
        // model is still producing a later, independent edit.
        if (currentText !== documentText && currentText !== afterShownEdit) {
            this._log.debug(`[NES]  background_stream skip cache — document changed`);
            return;
        }
        // Cache results from the complete response in the background
        const parsedLines = this._responsePipeline.process(text, pipelineContext);
        if (parsedLines && parsedLines.length > 0 && !parsedLines.every(l => l.trim() === '')) {
            const finalEdit = this._editFilterChain.apply(parsedLines, promptAssembly.editWindowLines);
            const usableEdits = filterLineEdits(
                this._responseDiffer.compute(promptAssembly.editWindowLines, parsedLines),
                promptAssembly.editWindowLines,
                pipelineContext.languageId ?? '',
                allowWhitespaceOnlyChanges(document),
                allowImportChanges(document),
            );
            if (finalEdit && usableEdits.length > 0) {
                const cacheEntry: CachedEdit = {
                    docId,
                    documentBeforeEdit: documentText,
                    editWindow: {
                        startLine: promptAssembly.editWindowRange.start,
                        endLineExclusive: promptAssembly.editWindowRange.endExclusive,
                    },
                    originalEditWindow: shownResult.cacheEntry?.originalEditWindow,
                    targetPosition: shownResult.cacheEntry?.targetPosition,
                    edit: finalEdit,
                    cacheTime: Date.now(),
                    cursorLineAtCacheTime: position.line,
                };
                if (currentText === documentText) {
                    this._cache.setKthNextEdit(docId, cacheEntry);
                    // The visible item may be rejected after the background stream
                    // finishes. Keep its cache reference pointed at the final entry.
                    shownResult.cacheEntry = cacheEntry;
                }
                this._stageFollowingEdit(
                    document, documentText, promptAssembly.editWindowRange, parsedLines, shownResult,
                );
                this._log.debug(`[NES]  background_stream cached edit=${finalEdit.length}ch`);
            }
        }
    }

    private _buildResultFromCached(
        cached: CachedOrRebasedEdit,
        document: vscode.TextDocument,
        position: vscode.Position,
        editWindow: { startLine: number; endLineExclusive: number } = cached.editWindow,
    ): NextEditResult {
        const responseLines = (cached.rebasedEdit ?? cached.edit).split('\n');
        const result = this._resultAssembler.assemble(
            responseLines,
            document,
            position,
            cached,
            this._config.suffixOverlapThreshold,
            this._config.suffixOverlapType,
            this._log,
            { start: editWindow.startLine, endExclusive: editWindow.endLineExclusive },
        );
        this._stageFollowingEdit(
            document,
            document.getText(),
            { start: editWindow.startLine, endExclusive: editWindow.endLineExclusive },
            responseLines,
            result,
        );
        return result;
    }

    /** Keep a predicted same-file edit available at both the source and target cursor windows. */
    cacheSameFileCursorJumpEdit(
        document: vscode.TextDocument,
        originalWindow: { startLine: number; endLineExclusive: number },
        targetPosition: vscode.Position,
        result: NextEditResult,
    ): void {
        const entry = result.cacheEntry;
        if (!entry || entry.docId.uri !== document.uri.toString()
            || entry.documentBeforeEdit !== document.getText()) return;
        entry.originalEditWindow = originalWindow;
        entry.targetPosition = { line: targetPosition.line, character: targetPosition.character };
        this._cache.setKthNextEdit(entry.docId, entry);
    }

    /**
     * Preserve an active-document -> target-document association for a cursor
     * prediction. This mirrors native NES caching: the active document gates
     * when the item can be shown, while the target snapshot gates where it can
     * safely be applied.
     */
    cacheCrossFileEdit(
        ownerDocument: vscode.TextDocument,
        ownerWindow: { startLine: number; endLineExclusive: number },
        targetDocument: vscode.TextDocument,
        targetPosition: vscode.Position,
        result: NextEditResult,
    ): void {
        if (ownerDocument.uri.toString() === targetDocument.uri.toString()) return;
        const targetEntry = result.cacheEntry;
        const targetWindow = targetEntry?.editWindow ?? result.editWindow;
        if (!targetWindow) return;
        const edit = targetEntry?.edit ?? result.fullEditText;
        if (!edit) return;
        const ownerId = DocumentId.create(ownerDocument.uri.toString());
        this._cache.setKthNextEdit(ownerId, {
            docId: ownerId,
            documentBeforeEdit: ownerDocument.getText(),
            editWindow: ownerWindow,
            edit,
            cacheTime: Date.now(),
            cursorLineAtCacheTime: targetPosition.line,
            targetDocId: DocumentId.create(targetDocument.uri.toString()),
            targetDocumentBeforeEdit: targetDocument.getText(),
            targetEditWindow: targetWindow,
            targetPosition: { line: targetPosition.line, character: targetPosition.character },
        });
    }

    /** Cache the next independent change against the document state after accepting this one. */
    private _stageFollowingEdit(
        document: vscode.TextDocument,
        documentText: string,
        editWindow: { start: number; endExclusive: number },
        targetLines: string[],
        result: NextEditResult,
    ): void {
        // Compare later streamed patches against the document produced by
        // accepting the visible replacement, including any combined changes.
        if (!result.edits?.length || (result.range.isEmpty && result.edit === '')) return;
        const afterFirstEdit = this._documentAfterShownEdit(document, documentText, result);
        if (!afterFirstEdit || (document.getText() !== documentText && document.getText() !== afterFirstEdit)) return;
        const lineDelta = afterFirstEdit.split(/\r\n|\n/).length - documentText.split(/\r\n|\n/).length;
        const nextWindow = {
            startLine: editWindow.start,
            endLineExclusive: editWindow.endExclusive + lineDelta,
        };
        if (nextWindow.endLineExclusive <= nextWindow.startLine) return;
        const afterFirstWindowLines = afterFirstEdit.replace(/\r\n/g, '\n').split('\n')
            .slice(nextWindow.startLine, nextWindow.endLineExclusive);
        // A displayed inline edit can already contain several disjoint
        // patches. Stage only the changes left after accepting that exact
        // edit, including later patches revealed by the continuing stream.
        if (filterLineEdits(
            this._responseDiffer.compute(afterFirstWindowLines, targetLines),
            afterFirstWindowLines,
            detectLanguage(document).languageId,
            allowWhitespaceOnlyChanges(document),
            allowImportChanges(document),
        ).length === 0) return;
        this._cache.setKthNextEdit(DocumentId.create(document.uri.toString()), {
            docId: DocumentId.create(document.uri.toString()),
            documentBeforeEdit: afterFirstEdit,
            editWindow: nextWindow,
            edit: targetLines.join('\n'),
            cacheTime: Date.now(),
            cursorLineAtCacheTime: result.cursorAfterEdit?.line ?? editWindow.start,
            subsequentN: 1,
        });
    }

    private _documentAfterShownEdit(
        document: vscode.TextDocument,
        originalText: string,
        result: NextEditResult,
    ): string | undefined {
        if (!result.edits?.length) return undefined;
        const offsetAtSnapshot = (position: vscode.Position): number => {
            let offset = 0;
            for (let line = 0; line < position.line; line++) {
                const newline = originalText.indexOf('\n', offset);
                if (newline < 0) return originalText.length;
                offset = newline + 1;
            }
            return Math.min(originalText.length, offset + position.character);
        };
        const replacement = document.eol === vscode.EndOfLine.CRLF
            ? result.edit.replace(/\n/g, '\r\n')
            : result.edit;
        const start = offsetAtSnapshot(result.range.start);
        const end = offsetAtSnapshot(result.range.end);
        if (start > end) return undefined;
        const after = originalText.slice(0, start) + replacement + originalText.slice(end);
        return after === originalText ? undefined : after;
    }


    private _trunc(s: string, max: number): string {
        const escaped = s.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
        return escaped.length <= max ? escaped : escaped.substring(0, max) + '…';
    }
}
