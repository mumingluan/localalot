import * as vscode from 'vscode';
import { IInstantiationService } from '../../di/instantiation';
import { ILLMAdapterManager } from '../shared/llm/llmAdapter';
import { isIncompleteLLMResponse, LLMError, LLMResponse } from '../shared/llm/llmRequest';
import { INesConfigProvider } from '../../config/nesConfig';
import { ILogService } from '../shared/log/logService';
import { renderCompletionPrompt } from './promptCraftingUtils';
import { IncludeLineNumbersOption, LintOptionShowCode, LintOptionWarning, PromptOptions } from './stubs/types';
import { constructTaggedFile, getUserPrompt, PromptPieces } from './promptCrafting';
import { OffsetRange } from './stubs/offsetRange';
import { Result } from '../../common/result';
import { CursorJumpPrediction } from './types';
import { effectiveNesOutputTokens } from './core/nesModelBudget';


export class NextCursorPredictor {
    private static readonly NCP_SYSTEM_PROMPT =
        "Your task is to predict the line number where the developer is most likely to make their next edit. If you jump in the current file, just output the line number. If you want to jump to another file, output the filepath (relative to workspace root), colon, then line number. If you don't think anywhere is a good next line jump target, just output the current line number of the cursor. Make sure to output no explanation, reasoning, extra spaces, etc.";

    private _isDisabled = false;
    private _disabledForEndpoint: string | undefined;

    constructor(
        @IInstantiationService private readonly _instaService: IInstantiationService,
        @INesConfigProvider private readonly _config: INesConfigProvider,
        @ILLMAdapterManager private readonly _llmManager: ILLMAdapterManager,
        @ILogService private readonly _log: ILogService,
    ) {}

    isEnabled(): boolean {
        this._refreshDisabledForConfig();
        if (this._isDisabled) {
            return false;
        }
        return this._config.nextCursorPredictionEnabled;
    }

    private _refreshDisabledForConfig(): void {
        if (this._disabledForEndpoint !== undefined
            && this._disabledForEndpoint !== this._endpointIdentity()) {
            this._isDisabled = false;
            this._disabledForEndpoint = undefined;
        }
    }

    private _endpointIdentity(): string {
        return JSON.stringify([this._config.baseUrl, this._config.endpoint, this._config.model, this._config.family]);
    }

    private _wasExplicitlyDisabled(): boolean {
        return this._config.nextCursorPredictionEnabled === false;
    }

    private _responseTokenLimit(): number {
        const endpoint = this._config.endpoint;
        const reasoning = endpoint === 'responses' || endpoint === 'messages'
            || this._config.family === 'anthropic'
            || this._config.family === 'openai-o'
            || this._config.family === 'openai-gpt5';
        // Cursor location is a separate request from NES edit generation.
        // A low edit-output limit must not consume the visible answer budget
        // of a reasoning model before it can emit a line number.
        const contextWindow = this._config.capabilities?.limits?.max_context_window_tokens;
        return effectiveNesOutputTokens(contextWindow, reasoning ? 2048 : 40);
    }

    async predict(
        promptPieces: PromptPieces,
        token?: vscode.CancellationToken,
    ): Promise<Result<CursorJumpPrediction, string>> {
        if (token?.isCancellationRequested) return Result.error('aborted');
        this._refreshDisabledForConfig();
        if (this._isDisabled || this._wasExplicitlyDisabled()) return Result.error('disabled');
        const configRevision = this._config.revision ?? 0;
        const endpointIdentity = this._endpointIdentity();
        const promptR = this.buildCursorPredictionPrompt(promptPieces);
        if (promptR.isError()) return Result.error(promptR.err);
        const { userMessage, keptRange } = promptR.val;
        if (token?.isCancellationRequested || (this._config.revision ?? 0) !== configRevision) return Result.error('aborted');

        let cancelListener: vscode.Disposable | undefined;
        try {
            const endpoint = this._config.endpoint;
            const adapter = this._llmManager.getAdapter(endpoint);
            const abortController = new AbortController();
            cancelListener = token?.onCancellationRequested(() => abortController.abort());
            if (token?.isCancellationRequested) {
                abortController.abort();
                return Result.error('aborted');
            }

            const requestBase = {
                baseUrl: this._config.baseUrl,
                apiKey: this._config.apiKey,
                model: this._config.model,
                family: this._config.family,
                // A cursor answer is one line, but reasoning tokens share
                // the same output budget with its visible answer.
                max_tokens: this._responseTokenLimit(),
                temperature: 0,
                n: 1,
                presence_penalty: this._config.presencePenalty,
                frequency_penalty: this._config.frequencyPenalty,
                capabilities: {
                    thinking: this._config.capabilities.supports.thinking,
                    reasoning_effort: this._config.capabilities.supports.reasoning_effort,
                },
            };

            let response: LLMResponse;
            if (endpoint === 'completions') {
                const prompt = renderCompletionPrompt(
                    this._config.promptTemplate,
                    NextCursorPredictor.NCP_SYSTEM_PROMPT,
                    userMessage,
                );
                this._log.debug(`completions prompt\n ${prompt}`);
                response = await adapter.send(
                    { ...requestBase, prompt },
                    abortController.signal,
                );
            } else {
                this._log.debug(`chat/completions prompt\n ${userMessage}`);
                response = await adapter.send(
                    {
                        ...requestBase,
                        messages: [
                            { role: 'system', content: NextCursorPredictor.NCP_SYSTEM_PROMPT },
                            { role: 'user', content: userMessage },
                        ],
                    },
                    abortController.signal,
                );
            }

            if (token?.isCancellationRequested || (this._config.revision ?? 0) !== configRevision
                || this._wasExplicitlyDisabled()) return Result.error('aborted');

            if (isIncompleteLLMResponse(response)
                && !hasCompleteCursorPredictionMarkers(response.text)) {
                return Result.error('incompleteResponse');
            }

            if (response.text.trim() === '') {
                return Result.error('emptyResponse');
            }
            this._log.debug(`predict next line: ${response.text}`);

            const target = extractCursorPredictionText(response.text);
            this._log.info(`predict next line: ${target}`);
            const parsed = parseCursorPrediction(target);
            if (parsed.isOk() && parsed.val.kind === 'sameFile'
                && !keptRange.contains(parsed.val.lineNumber)) {
                return Result.error('modelNotSeenLineNumber');
            }
            return parsed;
        } catch (err: unknown) {
            if ((err as { name?: string })?.name === 'AbortError') {
                return Result.error('aborted');
            }
            this._log.error(`[NCP] ERROR: ${err}`);

            // Native Copilot disables this predictor only when the endpoint
            // itself reports NotFound. Error-body text can mention "not found"
            // even for a retryable HTTP status or local transport failure.
            const msg = String(err);
            if (err instanceof LLMError && err.statusCode === 404) {
                this._isDisabled = true;
                this._disabledForEndpoint = endpointIdentity;
                this._log.info(`[NCP] disabled for session due to endpoint error`);
            }
            return Result.error(`fetchError:${msg}`);
        } finally {
            cancelListener?.dispose();
        }
    }

    /** Build the exact context used by the location request without contacting the model. */
    buildCursorPredictionPrompt(promptPieces: PromptPieces): Result<{ userMessage: string; keptRange: OffsetRange }, string> {
        const computeTokens = promptPieces.computeTokens;
        const contextWindow = this._config.capabilities?.limits?.max_context_window_tokens ?? 128_000;
        const maxInputTokens = contextWindow - this._responseTokenLimit() - 128;
        if (maxInputTokens <= 0) return Result.error('promptTooLarge');
        let currentMaxTokens = Math.min(3000, promptPieces.opts.currentFile.maxTokens);
        let recentMaxTokens = promptPieces.opts.recentlyViewedDocuments.maxTokens;
        let diffMaxTokens = promptPieces.opts.diffHistory.maxTokens;
        let neighborMaxTokens = promptPieces.opts.neighborFiles.maxTokens;
        let lintMaxLints = 5;
        let lintShowCode = LintOptionShowCode.YES_WITH_SURROUNDING;
        let areaRange = promptPieces.areaAroundEditWindowLinesRange;
        const editRange = promptPieces.editWindowLinesRange;
        const shrinkArea = (): boolean => {
            if (areaRange.start >= editRange.start && areaRange.endExclusive <= editRange.endExclusive) return false;
            areaRange = new OffsetRange(
                editRange.start - Math.floor((editRange.start - areaRange.start) / 2),
                editRange.endExclusive + Math.floor((areaRange.endExclusive - editRange.endExclusive) / 2),
            );
            return true;
        };

        for (let attempt = 0; attempt < 20; attempt++) {
            const taggedR = constructTaggedFile(
                promptPieces.currentDocument,
                promptPieces.editWindowLinesRange,
                areaRange,
                {
                    ...promptPieces.opts,
                    currentFile: {
                        ...promptPieces.opts.currentFile,
                        maxTokens: currentMaxTokens,
                        includeTags: false,
                    },
                },
                computeTokens,
                {
                    includeLineNumbers: {
                        areaAroundCodeToEdit: IncludeLineNumbersOption.None,
                        currentFileContent: IncludeLineNumbersOption.WithSpaceAfter,
                    },
                },
                true,
            );

            if (taggedR.isError()) {
                if (shrinkArea()) continue;
                this._log.debug('[NCP] mandatory edit area does not fit current-file budget');
                return Result.error('promptTooLarge');
            }

            const { clippedTaggedCurrentDoc, areaAroundCodeToEdit } = taggedR.val;

            const promptOptions: PromptOptions = {
                ...promptPieces.opts,
                includePostScript: false,
                // Cursor prediction only needs location context. Match the native
                // predictor's diagnostic and recent-file budget instead of
                // inheriting the larger edit-request settings.
                recentlyViewedDocuments: {
                    ...promptPieces.opts.recentlyViewedDocuments,
                    maxTokens: recentMaxTokens,
                    includeLineNumbers: IncludeLineNumbersOption.None,
                },
                diffHistory: { ...promptPieces.opts.diffHistory, maxTokens: diffMaxTokens },
                neighborFiles: { ...promptPieces.opts.neighborFiles, maxTokens: neighborMaxTokens },
                currentFile: { ...promptPieces.opts.currentFile, maxTokens: currentMaxTokens, includeTags: false },
                lintOptions: {
                    ...promptPieces.opts.lintOptions,
                    enable: true,
                    tagName: 'linter',
                    warnings: LintOptionWarning.YES_IF_NO_ERRORS,
                    showCode: lintShowCode,
                    maxLints: lintMaxLints,
                    maxLineDistance: 1000,
                    nRecentFiles: 0,
                },
            };

            const newPromptPieces = new PromptPieces(
                promptPieces.currentDocument,
                promptPieces.editWindowLinesRange,
                areaRange,
                promptPieces.activeDoc,
                promptPieces.xtabHistory,
                clippedTaggedCurrentDoc.lines,
                areaAroundCodeToEdit,
                promptPieces.langCtx,
                promptPieces.aggressivenessLevel,
                promptPieces.lintErrors,
                computeTokens,
                promptOptions,
                // NES has already gathered bounded semantic definitions and
                // references. Reuse them for location prediction as the local
                // counterpart of the native language-context section.
                promptPieces.neighborSnippets,
            );

            const { prompt: userMessage, sectionTokens } = getUserPrompt(newPromptPieces);
            const wirePrompt = this._config.endpoint === 'completions'
                ? renderCompletionPrompt(this._config.promptTemplate, NextCursorPredictor.NCP_SYSTEM_PROMPT, userMessage)
                : `${NextCursorPredictor.NCP_SYSTEM_PROMPT}\n${userMessage}`;
            const usedTokens = computeTokens(wirePrompt) + (this._config.endpoint === 'completions' ? 0 : 32);
            if (usedTokens <= maxInputTokens) {
                return Result.ok({ userMessage, keptRange: clippedTaggedCurrentDoc.keptRange });
            }
            const excess = usedTokens - maxInputTokens;
            const lintContent = userMessage.match(/<\|linter\|>([\s\S]*?)<\|\/linter\|>/)?.[1].trim();
            if (recentMaxTokens > 0 && sectionTokens.recent > 0) {
                recentMaxTokens = Math.max(0, Math.min(recentMaxTokens - 1, sectionTokens.recent - excess - 32));
            } else if (diffMaxTokens > 0 && sectionTokens.diff > 0) {
                diffMaxTokens = Math.max(0, Math.min(diffMaxTokens - 1, sectionTokens.diff - excess - 32));
            } else if (neighborMaxTokens > 0 && sectionTokens.neighbor > 0) {
                neighborMaxTokens = Math.max(0, Math.min(neighborMaxTokens - 1, sectionTokens.neighbor - excess - 32));
            } else if (lintContent && lintShowCode !== LintOptionShowCode.NO) {
                lintShowCode = lintShowCode === LintOptionShowCode.YES_WITH_SURROUNDING
                    ? LintOptionShowCode.YES : LintOptionShowCode.NO;
            } else if (lintContent && lintMaxLints > 0) {
                lintMaxLints = Math.floor(lintMaxLints / 2);
            } else if (sectionTokens.current > 0) {
                const mandatoryCurrent = computeTokens(promptPieces.currentDocument.lines
                    .slice(areaRange.start, areaRange.endExclusive).join('\n')) + 64;
                if (currentMaxTokens > mandatoryCurrent) {
                    currentMaxTokens = Math.max(mandatoryCurrent, Math.min(
                        currentMaxTokens - 1, currentMaxTokens - excess - 32,
                    ));
                } else if (!shrinkArea()) {
                    return Result.error('promptTooLarge');
                }
            } else if (!shrinkArea()) {
                return Result.error('promptTooLarge');
            }
        }
        return Result.error('promptTooLarge');
    }
}

/** Keep only one complete prediction, including for gateways that echo markers. */
export function extractCursorPredictionText(response: string): string {
    let text = response.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    if (text.startsWith('<think>')) return '';
    const lines = text.split(/\r?\n/).map(line => line.trim());
    const start = lines.findIndex(line => CURSOR_START_MARKER.test(line));
    const end = lines.findIndex((line, index) => index > start && CURSOR_END_MARKER.test(line));
    if (start < 0 && !lines.some(line => line.startsWith('###remain end boundary line'))) {
        // Some compatible chat models wrap their one-line answer in a code fence.
        // Only unwrap a complete fence with one payload line; incomplete or
        // multiline output must not become a cursor jump.
        const fenced = /^```[^\r\n]*\r?\n([^\r\n]+)\r?\n```$/.exec(text);
        return fenced ? fenced[1].trim() : text;
    }
    if (start < 0 || end < 0) return '';
    const payload = lines.slice(start + 1, end).filter(Boolean);
    return payload.length === 1 ? payload[0] : '';
}

function hasCompleteCursorPredictionMarkers(response: string): boolean {
    const lines = response.split(/\r?\n/).map(line => line.trim());
    const start = lines.findIndex(line => CURSOR_START_MARKER.test(line));
    return start >= 0 && lines.some((line, index) => index > start
        && CURSOR_END_MARKER.test(line));
}

const CURSOR_START_MARKER = /^###remain stat boundary line#{3,}$/;
const CURSOR_END_MARKER = /^###remain end boundary line#{3,}$/;

/** Parse the complete model answer; partial numeric prefixes must not become jumps. */
export function parseCursorPrediction(text: string): Result<CursorJumpPrediction, string> {
    const value = text.trim();
    if (/^\d+$/.test(value)) {
        const lineNumber = Number(value);
        return Number.isSafeInteger(lineNumber)
            ? Result.ok({ kind: 'sameFile', lineNumber })
            : Result.error('invalidLineNumber');
    }
    const separator = value.lastIndexOf(':');
    if (separator <= 0) {
        return Result.error('invalidPrediction');
    }
    const filePath = value.slice(0, separator).trim();
    const lineText = value.slice(separator + 1);
    const lineNumber = Number.parseInt(lineText, 10);
    if (!filePath || !Number.isSafeInteger(lineNumber) || lineNumber < 0) {
        return Result.error('invalidCrossFilePrediction');
    }
    return Result.ok({ kind: 'differentFile', filePath, lineNumber });
}
