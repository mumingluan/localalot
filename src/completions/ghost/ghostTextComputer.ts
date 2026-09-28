import * as vscode from 'vscode';
import { IInstantiationService } from '../../di/instantiation';
import { IGhostConfigProvider } from '../../config/ghostConfig';
import { IGhostPromptFactory } from './promptFactory';
import { IGhostCompletionsCache, CompletionChoice } from './completionsCache';
import { IRecentEditsProvider } from './recentEditsProvider';
import { ILLMAdapterManager } from '../shared/llm/llmAdapter';
import { LLMResponse } from '../shared/llm/llmRequest';
import { ILogService } from '../shared/log/logService';
import { CurrentGhostText, LastGhostText } from './ghostTextState';
import { IAsyncCompletionsManager } from './asyncCompletions';
import { getBlockPositionType, BlockPositionType, trimCompletion } from './blockTrimmer';
import { DiagnosticSummary, GhostCompletion, ResultType } from './types';
import { isInlineSuggestionFromTextAfterCursor } from './inlineSuggestion';
import { IMultilineStrategy } from './multiline/types';
import { MultilineContextBuilder } from './multiline/MultilineContextBuilder';
import { nativeBlockMode } from './multiline/nativeBlockMode';
import { SemanticContextService } from '../nes/semanticContextService';
import { INeighborFileSnippet } from '../nes/similarFilesContextService';
import { choiceTextForLineMode, completedSingleLineText, getGhostGenerationOptions, shouldTrimByIndentation } from './generationStrategy';
import { allocateGhostModelWindow, allocateGhostPromptBudget, allocateGhostTokenBudget } from './promptBudget';
import {
    countO200kTokens, countPromptTokens, ensurePromptTokenizerLoaded,
    takeFirstO200kTokens, takeLastO200kTokens, usesO200kGhostTokenizer,
} from '../nes/core/promptTokenizer';
import { takeEstimatedPromptTokens } from '../nes/core/promptTokenEstimate';
import type { GhostVirtualCompletion } from './inlineCompletion';
import { RequestStartLimiter } from './requestStartLimiter';
import { buildSelectedCompletionContext, buildVirtualGhostContext } from './virtualDocument';
import { trimRepetitiveTail } from './repetitionDetector';
import { cachedLexicalLines, lexicalFocus, selectLexicalWindow } from './lexicalContext';
import { selectNeighborDocuments } from './neighborFileAccess';
import { detectLanguage } from '../shared/languageDetection';
import { ghostDiagnosticRevision } from './diagnosticRevision';
import { sliceCompleteCodePoints } from '../../common/unicodeSlice';
export { buildVirtualGhostContext } from './virtualDocument';

const requestStartLimiter = new RequestStartLimiter();
const GHOST_SEMANTIC_CONTEXT_TIMEOUT_MS = 200;
const ghostDocumentIdentities = new WeakMap<object, number>();
let nextGhostDocumentIdentity = 0;

function ghostDocumentIdentity(document: object): number {
    // Test snapshots need no object identity; real VS Code documents can be
    // recreated with the same URI and version after an editor is closed.
    if (!('getText' in document)) return 0;
    let identity = ghostDocumentIdentities.get(document);
    if (identity === undefined) {
        identity = ++nextGhostDocumentIdentity;
        ghostDocumentIdentities.set(document, identity);
    }
    return identity;
}

/** Keep every open source snapshot in the reuse key: semantic providers can
 * resolve a definition from a buffer outside the recent-file window. */
export function ghostRequestScope(
    document: Pick<vscode.TextDocument, 'uri' | 'languageId'>,
    config: Pick<IGhostConfigProvider, 'revision' | 'baseUrl' | 'model' | 'endpoint' | 'promptTemplate' | 'contextPlacement'>,
    openDocuments: readonly Pick<vscode.TextDocument, 'uri' | 'version' | 'languageId'>[],
): string {
    const relatedDocumentVersions = openDocuments
        .filter(other => other.uri.toString() !== document.uri.toString())
        .map(other => [other.uri.toString(), other.version, other.languageId, ghostDocumentIdentity(other)] as const)
        .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
    return JSON.stringify([
        document.uri.toString(), document.languageId, ghostDocumentIdentity(document), config.revision ?? 0,
        config.baseUrl, config.model, config.endpoint,
        config.promptTemplate, config.contextPlacement,
        ghostDiagnosticRevision(document.uri.toString()),
        relatedDocumentVersions,
    ]);
}

/** A change to a source actually used in the prompt makes the response stale.
 * Other editor buffers still change the next request's cache key, but do not
 * suppress an in-flight suggestion for the current file. */
export function ghostRelevantSourcesStable(previous: string, next: string, relevantUris: ReadonlySet<string>): boolean {
    const before = JSON.parse(previous) as Array<unknown>;
    const after = JSON.parse(next) as Array<unknown>;
    if (JSON.stringify(before.slice(0, -1)) !== JSON.stringify(after.slice(0, -1))) return false;
    const oldDocuments = before.at(-1) as Array<[string, number, string, number]>;
    const newDocuments = after.at(-1) as Array<[string, number, string, number]>;
    const oldByUri = new Map(oldDocuments.map(entry => [entry[0], entry]));
    const newByUri = new Map(newDocuments.map(entry => [entry[0], entry]));
    for (const uri of relevantUris) {
        const oldEntry = oldByUri.get(uri);
        const newEntry = newByUri.get(uri);
        if (oldEntry && (!newEntry || oldEntry[1] !== newEntry[1]
            || oldEntry[2] !== newEntry[2] || oldEntry[3] !== newEntry[3])) return false;
    }
    return true;
}

/** Native prompt extraction removes indentation on a whitespace-only last line. */
function trimGhostPromptLastLine(prefix: string): string {
    const lastLineStart = prefix.lastIndexOf('\n') + 1;
    return prefix.slice(lastLineStart).trim().length === 0
        ? prefix.slice(0, lastLineStart)
        : prefix;
}

/** Match the native same-line suffix coverage used to size a ghost range. */
export function calculateSuffixCoverage(completionText: string, suffix: string): number {
    if (!completionText || !suffix) return 0;
    const restOfLine = suffix.split('\n', 1)[0];
    if (!restOfLine) return 0;
    if (completionText.includes(restOfLine)) return restOfLine.length;
    let lastIndex = -1;
    let covered = 0;
    for (const character of restOfLine) {
        const index = completionText.indexOf(character, lastIndex + 1);
        if (index <= lastIndex) break;
        covered++;
        lastIndex = index;
    }
    return covered;
}

export function isDuplicateOfNextNonEmptyLine(text: string, followingLines: readonly string[], trimWhitespace = true): boolean {
    if (!text || /\r?\n/.test(text)) return false;
    const candidate = trimWhitespace ? text.trim() : text;
    if (!candidate) return false;
    for (const line of followingLines) {
        const next = trimWhitespace ? line.trim() : line;
        if (!next) continue;
        return next === candidate;
    }
    return false;
}

export interface GhostTextResult {
    completions: GhostCompletion[];
    resultType: ResultType;
    suffixCoverage: number;
}

/** Keep nearby actionable diagnostics on either side of the caret. */
export function selectGhostDiagnostics(
    diagnostics: readonly vscode.Diagnostic[],
    cursorLine: number,
    maxDistance = 20,
): DiagnosticSummary[] {
    return diagnostics
        .filter(d => (d.severity === vscode.DiagnosticSeverity.Error
            || d.severity === vscode.DiagnosticSeverity.Warning)
            && Math.abs(d.range.start.line - cursorLine) <= maxDistance)
        .sort((a, b) => Math.abs(a.range.start.line - cursorLine) - Math.abs(b.range.start.line - cursorLine)
            || a.severity - b.severity)
        .slice(0, 5)
        .map(d => ({
            line: d.range.start.line + 1,
            column: d.range.start.character + 1,
            severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error' as const : 'warning' as const,
            code: typeof d.code === 'string' || typeof d.code === 'number' ? String(d.code)
                : d.code && typeof d.code === 'object' ? String(d.code.value) : undefined,
            source: d.source,
            message: d.message,
        }));
}

async function awaitUntilCanceled<T>(pending: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
    if (signal.aborted) return undefined;
    return new Promise<T | undefined>((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            resolve(undefined);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        pending.then(value => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        }, error => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
        });
    });
}

interface GhostLexicalSnippet {
    uri: string;
    path: string;
    snippet: string;
    startLine: number;
    endLineExclusive: number;
}

/** Preserve distinct source regions when a semantic and a lexical hit share a file. */
export function mergeGhostRelatedFiles(
    semantic: readonly INeighborFileSnippet[],
    lexical: readonly GhostLexicalSnippet[],
    maxEntries = 6,
    maxChars = 6_000,
): Array<{ path: string; snippet: string }> {
    const selected: Array<{ uri: string; path: string; snippet: string; startLine: number; endLineExclusive: number; kind?: 'facts' }> = [];
    for (const item of semantic) {
        const startLine = item.lineRange?.startLine ?? 0;
        selected.push({
            uri: item.uri,
            path: item.relativePath ?? item.uri,
            snippet: item.snippet,
            startLine,
            endLineExclusive: Math.min(item.lineRange?.endLineExclusive ?? Number.MAX_SAFE_INTEGER,
                startLine + item.snippet.split('\n').length),
            // Hover/signature facts and snippets without source coordinates
            // cannot be compared with lexical file ranges.
            kind: item.kind ?? (item.lineRange ? undefined : 'facts'),
        });
    }
    for (const item of lexical) {
        const overlapping = selected.some(existing => {
            if (existing.kind === 'facts' || existing.uri !== item.uri) return false;
            const overlap = Math.max(0, Math.min(existing.endLineExclusive, item.endLineExclusive)
                - Math.max(existing.startLine, item.startLine));
            const smaller = Math.min(existing.endLineExclusive - existing.startLine, item.endLineExclusive - item.startLine);
            return smaller > 0 && overlap / smaller >= 0.65;
        });
        if (!overlapping) selected.push(item);
    }
    const result: Array<{ path: string; snippet: string }> = [];
    let usedChars = 0;
    for (const item of selected) {
        if (result.length >= maxEntries || usedChars >= maxChars) break;
        const snippet = sliceCompleteCodePoints(item.snippet, maxChars - usedChars);
        if (!snippet.trim()) continue;
        result.push({ path: item.path, snippet });
        usedChars += snippet.length;
    }
    return result;
}

export class GhostTextComputer {
    constructor(
        private readonly _currentGhostText: CurrentGhostText,
        private readonly _lastGhostText: LastGhostText,
        @IInstantiationService private readonly _instantiationService: IInstantiationService,
        @IGhostConfigProvider private readonly _config: IGhostConfigProvider,
        @IGhostPromptFactory private readonly _promptFactory: IGhostPromptFactory,
        @IGhostCompletionsCache private readonly _cache: IGhostCompletionsCache,
        @IRecentEditsProvider private readonly _recentEdits: IRecentEditsProvider,
        @ILLMAdapterManager private readonly _llmManager: ILLMAdapterManager,
        @IAsyncCompletionsManager private readonly _asyncManager: IAsyncCompletionsManager,
        @ILogService private readonly _log: ILogService,
        @IMultilineStrategy private readonly multilineStrategy: IMultilineStrategy,
    ) {}

    private readonly _semanticContext = new SemanticContextService({
        providerMs: 130, importMs: 130, documentMs: 60,
    });

    async getGhostText(
        document: vscode.TextDocument,
        position: vscode.Position,
        token?: vscode.CancellationToken,
        isSpeculative: boolean = false,
        isCycling: boolean = false,
        selectedCompletionInfo?: vscode.SelectedCompletionInfo,
        virtualCompletion?: GhostVirtualCompletion,
    ): Promise<GhostTextResult | undefined> {
        const t0 = Date.now();
        const cacheRevision = this._cache.revision;
        this._log.info(`[GHOST] ===== START speculative=${isSpeculative} =====`);

        // Multiple provider calls can share the same document version (for
        // example automatic refresh and explicit cycling). Only the latest
        // visible request may update acceptance bookkeeping.
        const stateRequestId = !isSpeculative
            ? this._currentGhostText.beginRequest()
            : undefined;

        // Step 0: Check cancellation before any work
        if (token?.isCancellationRequested) {
            this._log.info(`[GHOST] CANCEL before_start`);
            return undefined;
        }

        // Step 1: Config check
        if (!this._config.enabled) {
            this._log.info(`[GHOST] SKIP — disabled by config`);
            return undefined;
        }
        if (this._config.endpointConfigured === false) {
            this._log.debug(`[GHOST] SKIP — configure ghost.baseUrl to enable requests`);
            return undefined;
        }
        const detectedLanguageId = detectLanguage(document).languageId;
        let requestScope = ghostRequestScope(document, this._config, vscode.workspace.textDocuments);
        let relevantSourceUris: ReadonlySet<string> = new Set();
        const scopeIsCurrent = () => ghostRelevantSourcesStable(
            requestScope,
            ghostRequestScope(document, this._config, vscode.workspace.textDocuments),
            relevantSourceUris,
        );

        // Apply the selected IntelliSense replacement before checking the
        // caret and constructing FIM context. The original line can contain
        // code that the selected item will replace.
        const t1 = Date.now();
        const virtualContext = virtualCompletion
            ? buildVirtualGhostContext(document, virtualCompletion)
            : selectedCompletionInfo
                ? buildSelectedCompletionContext(document, position, selectedCompletionInfo)
                : undefined;
        const contextDocument = virtualContext?.document ?? document;
        const contextPosition = virtualContext?.position ?? position;
        const contextLine = contextDocument.lineAt(contextPosition.line);
        const inlineSuggestion = isInlineSuggestionFromTextAfterCursor(
            contextLine.text.substring(contextPosition.character),
        );
        if (inlineSuggestion === undefined) {
            this._log.debug(`[GHOST] SKIP — invalid mid-line position`);
            return undefined;
        }

        // Step 3: Extract prefix/suffix. FIM suffix starts at the caret and
        // includes the rest of the current line, which is required for cases
        // such as `foo(|);` where the model must see `);`.
        const isMiddleOfTheLine = inlineSuggestion;
        // Virtual follow-up documents normalize line endings to LF. Use the
        // same form for a real editor request so a CRLF file can reuse the
        // suggestion prefetched for the accepted completion.
        const prefix = virtualContext?.prefix ?? document.getText(new vscode.Range(new vscode.Position(0, 0), position)).replace(/\r\n|\r/g, '\n');
        const suffix = virtualContext?.suffix ?? (() => {
            return document.getText(new vscode.Range(
                position,
                document.lineAt(document.lineCount - 1).range.end,
            )).replace(/\r\n/g, '\n');
        })();
        this._log.debug(`[GHOST] prefix=${prefix.length}ch suffix=${suffix.length}ch [${Date.now() - t1}ms]`);
        this._log.debug(`[GHOST] prefix_tail="${this._trunc(prefix, 80)}"`);
        this._log.debug(`[GHOST] suffix_head="${this._trunc(suffix, 80)}"`);

        // Determine the editor's line mode before local reuse. Native Copilot
        // limits cached and in-flight choices to one generated line when the
        // current position is a single-line opportunity.
        const afterAccept = virtualCompletion !== undefined
            || this._currentGhostText.hasAcceptedCurrentCompletion(prefix, suffix, requestScope);
        const multilineCtx = new MultilineContextBuilder().build({
            document: contextDocument,
            position: contextPosition,
            prefix,
            suffix,
            languageId: detectedLanguageId,
            isMiddleOfTheLine,
            afterAccept,
        });
        // An accepted completion forces a multiline follow-up only when this
        // position would otherwise be single-line. Native parsing modes keep
        // their normal block budget when the parser already found a block.
        const naturallyMultiline = await this.multilineStrategy.determineMultiline({
            ...multilineCtx, afterAccept: false,
        });
        const requestMultiline = afterAccept || naturallyMultiline;
        const blockMode = nativeBlockMode(detectedLanguageId);
        const isMoreMultiline = blockMode === 'client';
        const clientBlockFollowUp = afterAccept && blockMode === 'client';
        const longFileClientFollowUp = clientBlockFollowUp && contextDocument.lineCount >= 8000;
        const acceptedFollowUp = afterAccept && !clientBlockFollowUp
            && (blockMode === 'server' || !naturallyMultiline);
        if (token?.isCancellationRequested || !scopeIsCurrent()) return undefined;

        // Step 3.5: Typing-as-suggested check (via CurrentGhostText singleton)
        const typingSuggested = !isCycling
            ? this._currentGhostText.getCompletionsForUserTyping(prefix, suffix, requestScope)
            : undefined;
        if (typingSuggested && typingSuggested.length > 0) {
            // Apply line-level suffix overlap trim to each completion, filter empty results
            const trimmedCompletions = typingSuggested
                .map(c => ({
                    ...c,
                    completionText: this._trimLineSuffixOverlap(c.completionText, suffix),
                }))
                .filter(c => c.completionText !== '');
            if (trimmedCompletions.length > 0) {
                // Native Copilot keeps the already visible suggestion first and
                // appends distinct cached alternatives during typing.
                const seen = new Set(trimmedCompletions.map(choice => choice.completionText));
                const cachedAlternatives = this._cache.findAll(prefix, suffix, requestScope)
                    .map(choice => this._postProcessChoiceInContext(
                        { text: this._trimLineSuffixOverlap(choiceTextForLineMode(choice.text, requestMultiline), suffix), finishReason: choice.finishReason },
                        contextDocument, contextPosition, isMoreMultiline,
                    ))
                    .filter(choice => {
                        if (!choice.text.trim() || seen.has(choice.text)) return false;
                        seen.add(choice.text);
                        return true;
                    });
                const completions = [
                    ...trimmedCompletions.map(choice => ({ text: choice.completionText, finishReason: choice.finishReason ?? 'stop' })),
                    ...cachedAlternatives,
                ].map((choice, completionIndex) => this._toGhostCompletion(
                    choice, contextDocument, contextPosition, isMiddleOfTheLine,
                    calculateSuffixCoverage(choice.text, suffix), completionIndex,
                ));
                this._log.info(`[GHOST] TYPING_AS_SUGGESTED count=${completions.length} total=${Date.now() - t0}ms`);
                return {
                    completions,
                    resultType: ResultType.TypingAsSuggested,
                    suffixCoverage: completions[0].suffixCoverage ?? 0,
                };
            }
            this._log.debug('[GHOST] TYPING_AS_SUGGESTED candidates trimmed to empty; checking cache');
        }

        // Step 4: Cache lookup
        const t2 = Date.now();
        const cached = this._cache.findAll(prefix, suffix, requestScope);
        let cachedChoicesForCycling: CompletionChoice[] = [];
        if (cached.length > 0) {
            const cacheChoices = cached.map(choice => {
                const trimmedText = this._trimLineSuffixOverlap(choiceTextForLineMode(choice.text, requestMultiline), suffix);
                return this._postProcessChoiceInContext(
                    { text: trimmedText, finishReason: choice.finishReason },
                    contextDocument,
                    contextPosition,
                    isMoreMultiline,
                );
            }).filter(choice => choice.text.trim());
            if (cacheChoices.length === 0) {
                this._log.debug(`[GHOST] CACHE_DISCARD duplicate or closing-only completion`);
            } else if (isCycling && cacheChoices.length === 1) {
                // Native cycling keeps the first automatic candidate while it
                // fetches additional choices, so a slow/empty cycling request
                // never makes the visible suggestion disappear.
                cachedChoicesForCycling = cacheChoices;
            } else {
                const completions = cacheChoices.map((choice, completionIndex) => this._toGhostCompletion(
                    choice, contextDocument, contextPosition, isMiddleOfTheLine,
                    calculateSuffixCoverage(choice.text, suffix),
                    completionIndex,
                ));
                this._log.info(`[GHOST] CACHE_HIT count=${completions.length} result="${this._trunc(cacheChoices[0].text, 60)}" [${Date.now() - t2}ms] total=${Date.now() - t0}ms`);
                if (!isSpeculative) {
                    this._currentGhostText.setGhostText(prefix, suffix, completions, ResultType.Cache, cacheChoices[0].finishReason, stateRequestId, requestScope);
                }
                return {
                    completions,
                    resultType: ResultType.Cache,
                    suffixCoverage: completions[0].suffixCoverage ?? 0,
                };
            }
        }
        this._log.debug(`[GHOST] cache_miss [${Date.now() - t2}ms]`);

        if (token?.isCancellationRequested) {
            this._log.info(`[GHOST] CANCEL after_cache_check`);
            return undefined;
        }

        // Step 4.5: Check async completions (in-flight request reuse)
        const asyncHeaderRequestId = `ghost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        if (!isCycling && this._asyncManager.shouldWaitForAsyncCompletions(prefix, suffix, requestScope)) {
            this._log.info(`[GHOST] async_wait — checking in-flight requests`);
            const reuseWaitController = new AbortController();
            const reuseCancelListener = token?.onCancellationRequested(() => reuseWaitController.abort());
            if (token?.isCancellationRequested) reuseWaitController.abort();
            let asyncResult;
            try {
                asyncResult = await this._asyncManager.getFirstMatchingRequest(
                    asyncHeaderRequestId, prefix, suffix, 200, requestScope, reuseWaitController.signal, document.uri.toString(), isSpeculative,
                );
            } finally {
                reuseCancelListener?.dispose();
            }
            if (token?.isCancellationRequested || !scopeIsCurrent()) return undefined;
            if (asyncResult) {
                const trimmedAsyncText = this._trimLineSuffixOverlap(choiceTextForLineMode(asyncResult.completionText, requestMultiline), suffix);
                const choice: CompletionChoice = {
                    text: trimmedAsyncText,
                    finishReason: asyncResult.finishReason,
                };
                const processed = this._postProcessChoiceInContext(choice, contextDocument, contextPosition, isMoreMultiline);
                if (!processed.text.trim()) {
                    this._log.debug(`[GHOST] ASYNC_DISCARD duplicate or closing-only completion; requesting a fresh candidate`);
                } else {
                    const suffixCoverage = calculateSuffixCoverage(processed.text, suffix);
                    this._log.info(`[GHOST] ASYNC_REUSE result=${processed.text.length}ch total=${Date.now() - t0}ms`);
                    const ghostCompletion = this._toGhostCompletion(
                        processed, contextDocument, contextPosition, isMiddleOfTheLine, suffixCoverage,
                    );
                    if (!isSpeculative) {
                        this._currentGhostText.setGhostText(prefix, suffix, [ghostCompletion], ResultType.Async, undefined, stateRequestId, requestScope);
                    }
                    return {
                        completions: [ghostCompletion],
                        resultType: ResultType.Async,
                        suffixCoverage,
                    };
                }
            }
            this._log.info(`[GHOST] async_wait — no matching request found`);
        }

        // Step 5: Collect diagnostics
        const t3 = Date.now();
        const diagnostics = this._collectDiagnostics(document, position);
        const recentEdits = this._recentEdits.getRecentEditsFor?.(document, position)
            ?? this._recentEdits.recentEdits;
        const lexicalRelatedFiles = this._collectRelatedFiles(document, prefix);
        const tokenizerReady = usesO200kGhostTokenizer(this._config.model)
            ? ensurePromptTokenizerLoaded()
            : Promise.resolve(false);
        const semanticRelatedFiles = await this._collectSemanticContextWithin(document, position, token);
        relevantSourceUris = new Set([
            ...semanticRelatedFiles.map(file => file.uri),
            ...lexicalRelatedFiles.map(file => file.uri),
        ]);
        const relatedFiles = mergeGhostRelatedFiles(semanticRelatedFiles, lexicalRelatedFiles);
        const scopeAfterSemantic = ghostRequestScope(document, this._config, vscode.workspace.textDocuments);
        if (!ghostRelevantSourcesStable(requestScope, scopeAfterSemantic, relevantSourceUris)) return undefined;
        requestScope = scopeAfterSemantic;
        this._log.debug(`[GHOST] diagnostics=${diagnostics.length} recentEdits=${recentEdits.length} [${Date.now() - t3}ms]`);

        // Step 6: Build prompt
        const t4 = Date.now();
        const exactPromptTokens = await tokenizerReady;
        if (token?.isCancellationRequested || !scopeIsCurrent()) return undefined;
        const contextWindow = this._config.capabilities?.limits.max_context_window_tokens ?? 128_000;
        const modelWindow = allocateGhostModelWindow(contextWindow, this._config.maxOutputTokens);
        if (modelWindow.inputTokens < 32) {
            this._log.debug('[GHOST] SKIP — model context window too small for a completion prompt');
            return undefined;
        }
        const maxInputChars = modelWindow.inputTokens * 4;
        // Native Copilot sends context in `extra.context`. Generic completion
        // endpoints may ignore that field, so allow placing it before the FIM
        // source prefix when explicitly configured.
        const includePromptContext = true;
        const contextBudget = allocateGhostPromptBudget(maxInputChars, suffix.length, includePromptContext);
        const contextParams = {
            languageId: detectedLanguageId,
            diagnostics,
            recentEdits,
            relatedFiles,
            maxContextChars: contextBudget.contextChars,
        };
        const requestContext = this._promptFactory.createContext(contextParams);
        const trimmedPrefix = trimGhostPromptLastLine(prefix);
        const llmEndpoint = this._config.endpoint === 'fim/completions' ? 'fim/completions' : 'completions';
        const maxInputTokens = modelWindow.inputTokens;
        let prefixTokenLimit = 0;
        let suffixTokenLimit = 0;
        let modelPrefix: string;
        let modelSuffix: string;
        if (exactPromptTokens) {
            const emptyTemplate = this._config.promptTemplate.replace(/\{prefix\}|\{suffix\}/g, '');
            const templateTokens = llmEndpoint === 'fim/completions' ? 0 : countO200kTokens(emptyTemplate);
            const availableSourceTokens = Math.max(0,
                maxInputTokens - countO200kTokens(requestContext) - templateTokens - 12);
            const allocation = allocateGhostTokenBudget(
                availableSourceTokens, countO200kTokens(trimmedPrefix), countO200kTokens(suffix),
            );
            prefixTokenLimit = allocation.prefixTokens;
            suffixTokenLimit = allocation.suffixTokens;
            modelPrefix = this._clipPrefixByTokens(trimmedPrefix, prefixTokenLimit);
            modelSuffix = takeFirstO200kTokens(suffix, suffixTokenLimit);
        } else {
            const sourceBudget = allocateGhostPromptBudget(
                maxInputChars - requestContext.length, suffix.length, false, 20, trimmedPrefix.length,
            );
            modelPrefix = this._clipPrefix(trimmedPrefix, sourceBudget.prefixChars);
            modelSuffix = sliceCompleteCodePoints(suffix, sourceBudget.suffixChars);
        }
        const contextInPrefix = this._config.contextPlacement === 'prefix';
        let requestPrefix = contextInPrefix ? requestContext + modelPrefix : modelPrefix;
        const renderPrompt = () => this._promptFactory.createPrompt({
            ...contextParams,
            template: this._config.promptTemplate,
            prefix: requestPrefix,
            suffix: modelSuffix,
            includeContext: false,
        }).replace(/\r\n/g, '\n');
        let prompt = renderPrompt();
        if (exactPromptTokens) {
            const requestTokenCount = () => (llmEndpoint === 'fim/completions'
                ? countO200kTokens(requestPrefix) + countO200kTokens(modelSuffix)
                : countO200kTokens(prompt))
                + (contextInPrefix ? 0 : countO200kTokens(requestContext));
            // Custom templates can repeat placeholders. Keep the final wire
            // request inside the model window even when allocations alone do
            // not describe the rendered prompt's actual token cost.
            for (let attempt = 0; attempt < 4; attempt++) {
                const excess = requestTokenCount() - maxInputTokens;
                if (excess <= 0) break;
                if (prefixTokenLimit > 0 && modelPrefix) {
                    prefixTokenLimit = Math.max(0, prefixTokenLimit - excess - 4);
                    modelPrefix = this._clipPrefixByTokens(trimmedPrefix, prefixTokenLimit);
                } else {
                    suffixTokenLimit = Math.max(0, suffixTokenLimit - excess - 4);
                    modelSuffix = takeFirstO200kTokens(suffix, suffixTokenLimit);
                }
                requestPrefix = contextInPrefix ? requestContext + modelPrefix : modelPrefix;
                prompt = renderPrompt();
            }
            if (requestTokenCount() > maxInputTokens) {
                this._log.debug('[GHOST] SKIP — prompt exceeds model context window after clipping');
                return undefined;
            }
        } else {
            const requestTokenCount = () => (llmEndpoint === 'fim/completions'
                ? countPromptTokens(requestPrefix, undefined) + countPromptTokens(modelSuffix, undefined)
                : countPromptTokens(prompt, undefined))
                + (contextInPrefix ? 0 : countPromptTokens(requestContext, undefined));
            for (let attempt = 0; attempt < 6; attempt++) {
                const excess = requestTokenCount() - maxInputTokens;
                if (excess <= 0) break;
                if (modelPrefix) {
                    modelPrefix = takeEstimatedPromptTokens(trimmedPrefix,
                        Math.max(0, countPromptTokens(modelPrefix, undefined) - excess - 8), true);
                } else if (modelSuffix) {
                    modelSuffix = takeEstimatedPromptTokens(suffix,
                        Math.max(0, countPromptTokens(modelSuffix, undefined) - excess - 8));
                } else {
                    break;
                }
                requestPrefix = contextInPrefix ? requestContext + modelPrefix : modelPrefix;
                prompt = renderPrompt();
            }
            if (requestTokenCount() > maxInputTokens) {
                this._log.debug('[GHOST] SKIP — estimated prompt exceeds model context window after clipping');
                return undefined;
            }
        }
        this._log.debug(`[GHOST] prompt=${prompt.length}ch model=${this._config.model} [${Date.now() - t4}ms]`);
        this._log.debug('\n' + prompt);

        if (token?.isCancellationRequested) {
            this._log.info(`[GHOST] CANCEL after_prompt_build`);
            return undefined;
        }

        // Step 7: Determine multiline strategy via detector chain
        // Native Ghost Text gives accepted block completions a longer lookahead
        // at an empty block or block end. Keep this parser result separate from
        // the detector decision so YAML/JSON structural detection remains fast.
        // The native strategy skips local block parsing at 8000 lines, then
        // still serves an accepted completion with its short line limit.
        const blockPosition = (acceptedFollowUp || clientBlockFollowUp) && contextDocument.lineCount < 8000
            ? await getBlockPositionType(contextDocument, contextPosition, detectedLanguageId)
            : undefined;
        const generation = getGhostGenerationOptions(
            requestMultiline,
            clientBlockFollowUp ? Math.min(modelWindow.outputTokens, 200) : modelWindow.outputTokens,
            this._config.stops,
            acceptedFollowUp || longFileClientFollowUp,
            1,
            blockPosition,
            detectedLanguageId,
        );
        this._log.debug(`[GHOST] strategy multiline=${requestMultiline} tokens=${generation.maxTokens}`);

        // Step 8: Network request with rate limiting + AbortController
        const t5 = Date.now();
        const ourRequestId = `ghost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const abortController = new AbortController();
        const waitController = new AbortController();
        let cancelTimer: ReturnType<typeof setTimeout> | undefined;
        const cancelWait = () => {
            if (waitController.signal.aborted) return;
            waitController.abort();
            if (isCycling) {
                abortController.abort();
                return;
            }
            this._log.info(`[GHOST] ABORT — CancellationToken triggered (1000ms delay)`);
            if (cancelTimer) clearTimeout(cancelTimer);
            cancelTimer = setTimeout(() => {
                if (abortController.signal.aborted) return;
                if (this._asyncManager.hasActiveWaiters(ourRequestId)) {
                    this._log.info(`[GHOST] ABORT — skipped, active waiters present`);
                    return;
                }
                this._log.info(`[GHOST] ABORT — executing after 1000ms delay`);
                abortController.abort();
            }, 1000);
        };
        const cancelListener = token?.onCancellationRequested(cancelWait);
        if (token?.isCancellationRequested) cancelWait();

        try {
            const canStart = await requestStartLimiter.wait(
                this._config.delay,
                () => token?.isCancellationRequested === true || abortController.signal.aborted,
            );
            if (!canStart || !scopeIsCurrent()) return undefined;
            const adapter = this._llmManager.getAdapter(llmEndpoint);
            const asyncCancellationTokenSource = { cancel: () => abortController.abort() };
            // Start the request before registering it for reuse. Stream deltas
            // update the pending candidate so subsequent keystrokes can reject
            // a request whose output no longer matches the typed prefix.
            const request = {
                    baseUrl: this._config.baseUrl,
                    apiKey: this._config.apiKey,
                    model: this._config.model,
                    // FIM 端点需要原始代码 prefix + 独立 suffix（服务端自行套 FIM 模板）。
                    // completions 端点沿用渲染好的 <|fim_*|> prompt。
                    prompt: llmEndpoint === 'fim/completions' ? requestPrefix : prompt,
                    suffix: llmEndpoint === 'fim/completions' ? modelSuffix : undefined,
                    context: !contextInPrefix && requestContext ? [requestContext] : undefined,
                    max_tokens: generation.maxTokens,
                    temperature: isCycling ? 0.2 : 0,
                    stop: generation.stop.length > 0 ? generation.stop : undefined,
                    top_p:1,
                    n: isCycling ? 3 : 1,
                    stream: isCycling ? false : this._config.stream,
                    presence_penalty: this._config.presencePenalty,
                    frequency_penalty: this._config.frequencyPenalty,
                    extra: !contextInPrefix ? {
                        language: detectedLanguageId,
                        next_indent: this._nextIndent(contextDocument, contextPosition),
                        trim_by_indentation: shouldTrimByIndentation(detectedLanguageId, acceptedFollowUp),
                        prompt_tokens: exactPromptTokens
                            ? countO200kTokens(modelPrefix) + countO200kTokens(requestContext)
                            : countPromptTokens(modelPrefix, undefined) + countPromptTokens(requestContext, undefined),
                        suffix_tokens: exactPromptTokens
                            ? countO200kTokens(modelSuffix)
                            : countPromptTokens(modelSuffix, undefined),
                    } : undefined,
                };
            const requestPromise = !isCycling && request.stream
                ? (async () => {
                    const stream = adapter.sendStream(request, abortController.signal);
                    let partialText = '';
                    while (true) {
                        const next = await stream.next();
                        if (next.done) return next.value;
                        partialText += next.value;
                        const completedLine = requestMultiline ? undefined : completedSingleLineText(partialText);
                        this._asyncManager.updateCompletion(ourRequestId, completedLine ?? partialText);
                        if (completedLine !== undefined) {
                            const result: LLMResponse = { text: completedLine, finishReason: 'stop' };
                            // Closing the generator cancels its SSE reader. The
                            // first display line is already complete, so later
                            // tokens cannot change this visible suggestion.
                            try { await stream.return(result); } catch { /* The completed line is usable. */ }
                            return result;
                        }
                    }
                })()
                : adapter.send(request, abortController.signal);

            let networkChoices: CompletionChoice[];
            if (isCycling) {
                const response = await awaitUntilCanceled(requestPromise, waitController.signal);
                if (!response) return undefined;
                networkChoices = response.choices?.length
                    ? response.choices
                    : [{ text: response.text, finishReason: response.finishReason }];
            } else {
                // Register as pending immediately so a normal automatic request
                // can be reused by a later provider invocation.
                void this._asyncManager.queueCompletionRequest(
                    ourRequestId,
                    prefix,
                    suffix,
                    asyncCancellationTokenSource,
                    requestPromise.then(response => ({
                        completionText: response.text,
                        finishReason: response.finishReason,
                    })),
                    requestScope,
                    document.uri.toString(),
                );
                const asyncResult = await this._asyncManager.getFirstMatchingRequest(
                    ourRequestId, prefix, suffix, undefined, requestScope, waitController.signal, document.uri.toString(), isSpeculative,
                );
                if (!asyncResult) {
                    this._log.info(`[GHOST] NO_RESULT — getFirstMatchingRequest returned undefined total=${Date.now() - t0}ms`);
                    return undefined;
                }
                networkChoices = [{ text: asyncResult.completionText, finishReason: asyncResult.finishReason }];
            }
            if (token?.isCancellationRequested || !scopeIsCurrent()) return undefined;

            const networkMs = Date.now() - t5;
            this._log.info(`[GHOST] NETWORK choices=${networkChoices.length} [${networkMs}ms]`);
            const processedChoicesWithDuplicates = (await Promise.all(networkChoices.map(async (choice, choiceIndex) => {
                const rawText = choice.text;
                const blockTrimmedText = await trimCompletion(
                    contextDocument,
                    contextPosition,
                    prefix,
                    rawText,
                    requestMultiline,
                    acceptedFollowUp || longFileClientFollowUp ? 2 : clientBlockFollowUp
                        ? (blockPosition === BlockPositionType.EmptyBlock || blockPosition === BlockPositionType.BlockEnd ? 9 : 3)
                        : undefined,
                    detectedLanguageId,
                    longFileClientFollowUp,
                );
                const trimmedText = this._trimLineSuffixOverlap(blockTrimmedText, suffix);
                const processed = this._postProcessChoiceInContext(
                    { text: trimmedText, finishReason: choice.finishReason }, contextDocument, contextPosition, isMoreMultiline,
                );
                if (!processed.text.trim()) return undefined;
                return {
                    choice: { text: processed.text, finishReason: choice.finishReason },
                    ghost: this._toGhostCompletion(
                        processed, contextDocument, contextPosition, isMiddleOfTheLine,
                        calculateSuffixCoverage(processed.text, suffix),
                        choiceIndex,
                    ),
                    suffixCoverage: calculateSuffixCoverage(processed.text, suffix),
                };
            }))).filter((value): value is {
                choice: CompletionChoice;
                ghost: GhostCompletion;
                suffixCoverage: number;
            } => value !== undefined);
            // Providers and compatible gateways occasionally return the same
            // candidate in multiple `n` slots. Keep cycling deterministic and
            // avoid showing duplicate ghost text entries.
            const seenChoiceText = new Set<string>();
            const processedChoices = [
                ...cachedChoicesForCycling.map((choice, choiceIndex) => ({
                    choice,
                    ghost: this._toGhostCompletion(
                        choice, contextDocument, contextPosition, isMiddleOfTheLine,
                        calculateSuffixCoverage(choice.text, suffix), choiceIndex,
                    ),
                    suffixCoverage: calculateSuffixCoverage(choice.text, suffix),
                })),
                ...processedChoicesWithDuplicates,
            ].filter(item => {
                if (seenChoiceText.has(item.choice.text)) return false;
                seenChoiceText.add(item.choice.text);
                return true;
            });
            processedChoices.forEach((item, index) => {
                item.ghost.completionIndex = index;
            });
            if (token?.isCancellationRequested || !scopeIsCurrent() || cacheRevision !== this._cache.revision) return undefined;
            if (processedChoices.length === 0) return undefined;

            // Native completions use a minimum time from request issuance to
            // display, rather than spacing network starts by that duration.
            // This keeps very fast replies from flashing while slow replies
            // incur no additional delay.
            if (!isCycling) {
                const remainingDisplayDelay = Math.max(0, 200 - (Date.now() - t0));
                if (remainingDisplayDelay > 0) {
                    await new Promise<void>(resolve => setTimeout(resolve, remainingDisplayDelay));
                    if (token?.isCancellationRequested || !scopeIsCurrent()
                        || cacheRevision !== this._cache.revision) return undefined;
                }
            }

            for (const item of processedChoices) this._cache.append(prefix, suffix, item.choice, requestScope);
            const resultType = isCycling ? ResultType.Cycling : ResultType.Network;
            const completions = processedChoices.map(item => item.ghost);
            if (!isSpeculative) {
                this._currentGhostText.setGhostText(prefix, suffix, completions, resultType, processedChoices[0].choice.finishReason, stateRequestId, requestScope);
            }
            return {
                completions,
                resultType,
                suffixCoverage: processedChoices[0].suffixCoverage,
            };
        } catch (err) {
            if ((err as {name?: string})?.name === 'AbortError') {
                this._log.info(`[GHOST] ABORTED after ${Date.now() - t0}ms`);
                return undefined;
            }
            this._log.error(`[GHOST] ERROR after ${Date.now() - t0}ms: ${err}`);
            return undefined;
        } finally {
            // A canceled editor request has released its waiter. Keep the
            // delayed network abort so an unclaimed request is still stopped.
            if (cancelTimer && !waitController.signal.aborted) clearTimeout(cancelTimer);
            cancelListener?.dispose();
        }
    }

    // Remove only whole lines that duplicate the lines following the cursor.
    _trimLineSuffixOverlap(text: string, suffix: string): string {
        // The first suffix line is only the remainder of the cursor line.
        // It may be replaced by the suggestion, so fuzzy whole-line matching
        // against it can erase a valid same-line edit.
        const nextLineStart = suffix.indexOf('\n');
        if (nextLineStart < 0) return text;
        const followingLines = suffix.slice(nextLineStart + 1);
        if (!followingLines.trim()) return text;
        const lineBreak = text.includes('\r\n') ? '\r\n' : '\n';
        const completionLines = text.split(/\r?\n/);
        const completionNonEmpty = completionLines
            .map((line, index) => ({ index, text: line }))
            .filter(line => line.text.trim());
        const suffixNonEmpty = followingLines.split(/\r?\n/)
            .filter(line => line.trim());
        for (let count = Math.min(completionNonEmpty.length, suffixNonEmpty.length); count > 0; count--) {
            const first = completionNonEmpty.length - count;
            if (completionNonEmpty.slice(first).every((line, index) => line.text === suffixNonEmpty[index])) {
                this._log.info(`[GHOST] line_trim exact_overlap=${count} lines`);
                return completionLines.slice(0, completionNonEmpty[first].index).join(lineBreak);
            }
        }
        return text;
    }

    private _postProcessChoiceInContext(
        choice: CompletionChoice,
        document: vscode.TextDocument,
        position: vscode.Position,
        isMoreMultiline = false,
    ): CompletionChoice {
        let text = choice.text;
        text = trimRepetitiveTail(text);
        if (!text.trim()) return { ...choice, text: '' };
        if (this._matchesNextDocumentLine(text, document, position, isMoreMultiline)) {
            return { ...choice, text: '' };
        }
        text = this._snipExistingClosingBlock(text, document, position);
        return { ...choice, text };
    }

    /**
     * Copilot compares a single-line completion with the first non-empty line
     * after the cursor. Searching farther can hide a valid completion merely
     * because the same text appears later in the file.
     */
    private _matchesNextDocumentLine(text: string, document: vscode.TextDocument, position: vscode.Position, isMoreMultiline = false): boolean {
        if (!text || /\r?\n/.test(text)) return false;
        for (let line = position.line + 1; line < document.lineCount; line++) {
            const next = document.lineAt(line).text;
            if (isMoreMultiline ? next !== '' : next.trim() !== '') {
                return isDuplicateOfNextNonEmptyLine(text, [next], !isMoreMultiline);
            }
        }
        return false;
    }

    /** Remove a trailing line already present after the cursor, preserving the useful body. */
    private _snipExistingClosingBlock(text: string, document: vscode.TextDocument, position: vscode.Position): string {
        const lineBreak = text.includes('\r\n') ? '\r\n' : '\n';
        const lines = text.split(/\r?\n/);
        if (lines.length <= 1) return text;
        const closeToken = this._closingToken(detectLanguage(document).languageId);

        for (let start = 1; start < lines.length; start++) {
            let documentLine = position.line + 1;
            let completionLine = start;
            let matched = true;
            let compared = 0;
            while (completionLine < lines.length) {
                while (documentLine < document.lineCount && document.lineAt(documentLine).text.trim() === '') documentLine++;
                while (completionLine < lines.length && lines[completionLine].trim() === '') completionLine++;
                if (completionLine >= lines.length) break;
                const existing = documentLine < document.lineCount ? document.lineAt(documentLine).text : undefined;
                const generated = lines[completionLine];
                const last = completionLine === lines.length - 1;
                if (existing === undefined || !generated.trim()) {
                    matched = false;
                    break;
                }
                if (!last) {
                    if (existing !== generated || generated.trim() !== closeToken) {
                        matched = false;
                        break;
                    }
                } else {
                    // A final generated line may be just the beginning of
                    // the next line already in the document. Compare the
                    // exact text, including indentation, before removing it.
                    if (!existing.startsWith(generated)) {
                        matched = false;
                        break;
                    }
                }
                compared++;
                documentLine++;
                completionLine++;
            }
            if (matched && compared > 0) {
                return lines.slice(0, start).join(lineBreak);
            }
        }
        return text;
    }

    private _closingToken(languageId: string): string | undefined {
        if (['yaml', 'python', 'markdown', 'plaintext'].includes(languageId)) return undefined;
        if (['ruby', 'elixir', 'crystal'].includes(languageId)) return 'end';
        if (['shellscript', 'shell', 'bash', 'zsh', 'fish'].includes(languageId)) return 'fi';
        if ([
            'javascript', 'javascriptreact', 'typescript', 'typescriptreact',
            'json', 'jsonc', 'json5',
            'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'php', 'dart',
            'kotlin', 'swift', 'objective-c', 'objective-cpp', 'scala',
            'css', 'scss',
        ].includes(languageId)) return '}';
        return undefined;
    }

    private _toGhostCompletion(
        choice: CompletionChoice,
        document: vscode.TextDocument,
        position: vscode.Position,
        isMiddleOfTheLine: boolean,
        suffixCoverage = 0,
            completionIndex = 0,
    ): GhostCompletion {
        const currentLine = document.lineAt(position.line);
        const beforeCursor = currentLine.text.substring(0, position.character);
        const trailingWs = beforeCursor.slice(beforeCursor.trimEnd().length);
        let displayText = choice.text;
        let displayNeedsWsOffset = false;
        if (trailingWs) {
            if (choice.text.startsWith(trailingWs)) {
                displayText = choice.text.substring(trailingWs.length);
            } else {
                const generatedWs = choice.text.slice(0, choice.text.length - choice.text.trimStart().length);
                if (trailingWs.startsWith(generatedWs)) {
                    displayText = choice.text.trimStart();
                    displayNeedsWsOffset = true;
                }
            }
        }

        return {
            completionIndex,
            completionText: choice.text,
            finishReason: choice.finishReason,
            displayText,
            displayNeedsWsOffset,
            isMiddleOfTheLine,
            suffixCoverage: isMiddleOfTheLine ? suffixCoverage : 0,
        };
    }

    private _collectDiagnostics(document: vscode.TextDocument, position: vscode.Position): DiagnosticSummary[] {
        return selectGhostDiagnostics(vscode.languages.getDiagnostics(document.uri), position.line);
    }

    private _collectRelatedFiles(document: vscode.TextDocument, prefix: string): GhostLexicalSnippet[] {
        const focus = lexicalFocus(prefix);
        if (focus.length === 0) return [];
        const neighbors = selectNeighborDocuments(document, vscode.workspace.textDocuments);
        return neighbors
            .map(other => {
                const selected = selectLexicalWindow(cachedLexicalLines(other), focus);
                return selected && {
                    uri: other.uri.toString(),
                    path: vscode.workspace.asRelativePath(other.uri),
                    snippet: `related code (${selected.anchorLine + 1})\n${selected.snippet}`,
                    startLine: selected.startLine,
                    endLineExclusive: selected.startLine + selected.snippet.split('\n').length,
                    score: selected.score,
                };
            })
            .filter((candidate): candidate is GhostLexicalSnippet & { score: number } => !!candidate)
            .sort((a, b) => b.score - a.score)
            .slice(0, 4)
            .map(({ score: _score, ...snippet }) => snippet);
    }

    private _clipPrefix(prefix: string, maxChars: number): string {
        if (maxChars <= 0) return '';
        if (prefix.length <= maxChars) return prefix;
        return this._wholeLineTail(prefix, sliceCompleteCodePoints(prefix, maxChars, true));
    }

    private _clipPrefixByTokens(prefix: string, maxTokens: number): string {
        if (maxTokens <= 0) return '';
        if (countO200kTokens(prefix) <= maxTokens) return prefix;
        return this._wholeLineTail(prefix, takeLastO200kTokens(prefix, maxTokens));
    }

    /** Native prefix elision keeps the lines closest to the cursor. */
    private _wholeLineTail(prefix: string, tail: string): string {
        if (!tail || !prefix.endsWith(tail)) return tail;
        const start = prefix.length - tail.length;
        if (start === 0 || prefix[start - 1] === '\n') return tail;
        const newline = tail.indexOf('\n');
        // When the cursor line alone exceeds the budget, keep its last tokens.
        return newline < 0 || newline === tail.length - 1 ? tail : tail.slice(newline + 1);
    }

    private async _collectSemanticContextWithin(
        document: vscode.TextDocument,
        position: vscode.Position,
        token?: vscode.CancellationToken,
    ): Promise<INeighborFileSnippet[]> {
        if (token?.isCancellationRequested) return [];
        const semanticCts = new vscode.CancellationTokenSource();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancelWait!: (value: INeighborFileSnippet[]) => void;
        const canceled = new Promise<INeighborFileSnippet[]>(resolve => { cancelWait = resolve; });
        const cancelListener = token?.onCancellationRequested(() => {
            semanticCts.cancel();
            cancelWait([]);
        });
        if (token?.isCancellationRequested) {
            semanticCts.cancel();
            cancelWait([]);
        }
        try {
            return await Promise.race([
                this._semanticContext.collect(document, position, semanticCts.token).catch(error => {
                    this._log.debug(`[GHOST] semantic context unavailable: ${error}`);
                    return [] as INeighborFileSnippet[];
                }),
                new Promise<INeighborFileSnippet[]>(resolve => {
                    timer = setTimeout(() => {
                        this._log.debug('[GHOST] semantic context deadline reached');
                        semanticCts.cancel();
                        resolve([]);
                    }, GHOST_SEMANTIC_CONTEXT_TIMEOUT_MS);
                }),
                canceled,
            ]);
        } finally {
            if (timer) clearTimeout(timer);
            cancelListener?.dispose();
            semanticCts.dispose();
        }
    }

    private _nextIndent(document: vscode.TextDocument, position: vscode.Position): number {
        // Copilot's next_indent describes the next existing non-blank line,
        // rather than the line being completed. It bounds server-side
        // indentation trimming when a generated block precedes a sibling.
        for (let line = position.line + 1; line < document.lineCount; line++) {
            const text = document.lineAt(line).text;
            if (text.trim()) return (text.match(/^[\t ]*/) ?? [''])[0].length;
        }
        return 0;
    }

    private _trunc(s: string, max: number): string {
        const escaped = s.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
        return escaped.length <= max ? escaped : escaped.substring(0, max) + '…';
    }
}
