import * as vscode from 'vscode';
import { setTimeout as wait } from 'node:timers/promises';
import { iterateSSEStream } from '../src/completions/shared/llm/sseStream';
import { OpenAIResponseAdapter } from '../src/completions/shared/llm/openaiResponseAdapter';
import { AnthropicAdapter } from '../src/completions/shared/llm/anthropicAdapter';
import type { ChatMessage, LLMRequest } from '../src/completions/shared/llm/llmRequest';
import type { Completion } from '../vendor/copilot/src/platform/nesFetch/common/completionsAPI';
import type { RequestId } from '../vendor/copilot/src/platform/networking/common/fetch';
import { LiveOpenAIFetcher } from '../vendor/copilot/src/extension/completions-core/vscode-node/lib/src/openai/fetch';
import { getStops } from '../vendor/copilot/src/extension/completions-core/vscode-node/lib/src/openai/openai';
import type { CompletionError, CompletionParams, CompletionResults, FinishedCallback, ICompletionsOpenAIFetcherService } from '../vendor/copilot/src/extension/completions-core/vscode-node/lib/src/openai/fetch';
import type { TelemetryWithExp } from '../vendor/copilot/src/extension/completions-core/vscode-node/lib/src/telemetry';
import type { CancellationToken } from '../vendor/copilot/src/extension/completions-core/vscode-node/types/src';
import { beginLocalRequest, reportLocalRequestStatus } from './localRequestStatus';

export interface LocalGhostTransportOptions {
    baseUrl: string;
    apiKey: string;
    model: string;
    family?: string;
    endpoint: 'completions' | 'fim/completions' | 'chat/completions' | 'responses' | 'messages';
    maxOutputTokens: number;
    promptTemplate: string;
    stops: string[];
    contextPlacement?: 'prefix' | 'extra';
    presencePenalty?: number;
    frequencyPenalty?: number;
    stream?: boolean;
    reasoningEffort?: string;
    delayMs?: number;
}

function currentOptions(): LocalGhostTransportOptions {
    const config = vscode.workspace.getConfiguration('localalot.ghost');
    return {
        baseUrl: config.get<string>('baseUrl', ''),
        apiKey: config.get<string>('apiKey', ''),
        model: config.get<string>('model', ''),
        family: config.get<string>('family', 'standard'),
        endpoint: config.get<LocalGhostTransportOptions['endpoint']>('endpoint', 'completions'),
        maxOutputTokens: config.get<number>('capabilities.limits.max_output_tokens', 500),
        promptTemplate: config.get<string>('promptTemplate', '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>'),
        stops: config.get<string[]>('stops', []),
        contextPlacement: config.get<'prefix' | 'extra'>('contextPlacement', 'prefix'),
        presencePenalty: config.get<number>('presencePenalty', 0),
        frequencyPenalty: config.get<number>('frequencyPenalty', 0),
        stream: config.get<boolean>('stream', true),
        reasoningEffort: config.get<string>('capabilities.supports.reasoning_effort', 'low'),
        delayMs: config.get<number>('capabilities.limits.delay', 0),
    };
}

function requestId(id: string): RequestId {
    return {
        headerRequestId: id,
        gitHubRequestId: '',
        copilotServiceRequestId: '',
        completionId: '',
        created: Date.now(),
        serverExperiments: '',
        deploymentId: '',
    };
}

function toCompletion(choices: Array<{
    index?: number; text?: string; delta?: { content?: string | null };
    message?: { content?: string | null }; finish_reason?: string | null;
}>): Completion {
    return {
        choices: choices.map((choice, index) => ({
            index: choice.index ?? index,
            text: choice.text ?? choice.delta?.content ?? choice.message?.content ?? '',
            finish_reason: choice.finish_reason as Completion.FinishReason | null | undefined ?? null,
        })),
        system_fingerprint: '',
        object: 'text_completion',
        usage: undefined,
    };
}

function httpFailureReason(status: number, body: string): string {
    let detail: string | undefined;
    try {
        const parsed = JSON.parse(body) as { error?: string | { message?: string }; message?: string };
        detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message;
    } catch { /* Arbitrary server text can contain the source prompt. */ }
    return `Local completion endpoint returned ${status}${detail ? `: ${detail.slice(0, 240)}` : ''}`;
}

/** Local model transport for the unmodified Copilot Ghost request pipeline. */
export class LocalGhostTransport implements ICompletionsOpenAIFetcherService {
    declare readonly _serviceBrand: undefined;
    private nextRequestAt = 0;

    constructor(private readonly readOptions: () => LocalGhostTransportOptions = currentOptions) { }

    async fetchAndStreamCompletions(
        params: CompletionParams,
        telemetry: TelemetryWithExp,
        finishedCb: FinishedCallback,
        cancellationToken?: CancellationToken,
    ): Promise<CompletionResults | CompletionError> {
        const options = this.readOptions();
        if (!options.baseUrl.trim()) {
            return { type: 'failed', reason: 'Configure localalot.ghost.baseUrl' };
        }
        if (cancellationToken?.isCancellationRequested) {
            return { type: 'canceled', reason: 'before local request' };
        }

        const controller = new AbortController();
        const cancellation = cancellationToken?.onCancellationRequested(() => controller.abort());
        let statusRequest: number | undefined;
        try {
            const interval = Number.isFinite(options.delayMs) ? Math.max(0, Math.floor(options.delayMs ?? 0)) : 0;
            if (interval > 0) {
                const scheduledAt = Math.max(Date.now(), this.nextRequestAt);
                this.nextRequestAt = scheduledAt + interval;
                if (scheduledAt > Date.now()) await wait(scheduledAt - Date.now(), undefined, { signal: controller.signal });
            }
            if (controller.signal.aborted) {
                cancellation?.dispose();
                return { type: 'canceled', reason: 'before local request' };
            }
            statusRequest = beginLocalRequest('ghost');
            const isFim = options.endpoint === 'fim/completions';
            const isChat = options.endpoint === 'chat/completions';
            const context = params.prompt.context ?? [];
            const chatMessages: ChatMessage[] = [
                {
                    role: 'system',
                    content: 'Complete code at the cursor. Return only the text to insert, with no explanation, markdown, or repeated prefix or suffix. Preserve indentation and line breaks.',
                },
                {
                    role: 'user',
                    content: [
                        `Language: ${params.languageId}`,
                        ...(options.contextPlacement === 'extra' || context.length === 0
                            ? [] : [`Relevant context:\n${context.join('\n')}`]),
                        `Fill the gap between these exact code fragments. The cursor is immediately after CODE_BEFORE.\n<CODE_BEFORE>${params.prompt.prefix}</CODE_BEFORE>\n<CODE_AFTER>${params.prompt.suffix}</CODE_AFTER>`,
                    ].join('\n\n'),
                },
            ];
            const prefix = options.contextPlacement === 'extra' || context.length === 0
                ? params.prompt.prefix
                : `${context.join('\n')}\n${params.prompt.prefix}`;
            const prompt = isFim ? prefix : options.promptTemplate
                .replaceAll('{prefix}', prefix)
                .replaceAll('{suffix}', params.prompt.suffix);
            const outputLimit = Number.isFinite(options.maxOutputTokens)
                ? Math.max(1, Math.floor(options.maxOutputTokens)) : 500;
            const maxTokens = Math.min(outputLimit, params.postOptions?.max_tokens ?? outputLimit);
            const stop = options.stops.length ? options.stops : params.postOptions?.stop ?? getStops(params.languageId);
            if (options.endpoint === 'responses' || options.endpoint === 'messages') {
                const request: LLMRequest = {
                    model: options.model || params.engineModelId,
                    family: options.family,
                    baseUrl: options.baseUrl.replace(/\/+$/, ''),
                    apiKey: options.apiKey,
                    messages: chatMessages,
                    context: options.contextPlacement === 'extra' ? context : undefined,
                    max_tokens: maxTokens,
                    temperature: params.postOptions?.temperature ?? 0,
                    top_p: params.postOptions?.top_p ?? 1,
                    stop,
                    stream: options.stream ?? true,
                    capabilities: { reasoning_effort: options.reasoningEffort ?? 'low' },
                };
                const adapter = options.endpoint === 'responses'
                    ? new OpenAIResponseAdapter() : new AnthropicAdapter();
                const stream = async function* (): AsyncGenerator<Completion> {
                    let receivedChoices = false;
                    try {
                        if (request.stream) {
                            const generated = adapter.sendStream(request, controller.signal);
                            for (;;) {
                                const next = await generated.next();
                                if (next.done) {
                                    if (receivedChoices) {
                                        yield toCompletion([{ index: 0, text: '', finish_reason: next.value.finishReason || 'stop' }]);
                                    }
                                    break;
                                }
                                if (!next.value) continue;
                                if (!receivedChoices) reportLocalRequestStatus('ghost', undefined, statusRequest);
                                receivedChoices = true;
                                yield toCompletion([{ index: 0, text: next.value, finish_reason: null }]);
                            }
                        } else {
                            const result = await adapter.send(request, controller.signal);
                            if (result.text) {
                                receivedChoices = true;
                                reportLocalRequestStatus('ghost', undefined, statusRequest);
                                yield toCompletion([{ index: 0, text: result.text, finish_reason: result.finishReason || 'stop' }]);
                            }
                        }
                        if (!controller.signal.aborted && !receivedChoices) {
                            reportLocalRequestStatus('ghost', 'Local completion endpoint returned no choices', statusRequest);
                        }
                    } catch (error) {
                        if (!controller.signal.aborted) reportLocalRequestStatus('ghost', String(error), statusRequest);
                        throw error;
                    } finally {
                        cancellation?.dispose();
                    }
                };
                const responseStream = {
                    stream: stream(),
                    requestId: requestId(params.ourRequestId),
                    destroy: async () => { controller.abort(); cancellation?.dispose(); },
                } as Parameters<typeof LiveOpenAIFetcher.convertStreamToApiChoices>[0];
                return {
                    type: 'success',
                    choices: LiveOpenAIFetcher.convertStreamToApiChoices(responseStream, finishedCb, telemetry, cancellationToken),
                    getProcessingTime: () => 0,
                };
            }
            const body: Record<string, unknown> = isChat ? {
                model: options.model || params.engineModelId,
                messages: chatMessages,
                max_tokens: maxTokens,
                temperature: params.postOptions?.temperature ?? (params.count > 1 ? 0.2 : 0),
                top_p: params.postOptions?.top_p ?? 1,
                n: params.postOptions?.n ?? params.count,
                stop,
                presence_penalty: options.presencePenalty ?? 0,
                frequency_penalty: options.frequencyPenalty ?? 0,
                stream: options.stream ?? true,
                ...(options.contextPlacement === 'extra' ? { extra: { ...params.extra, ...(context.length ? { context } : {}) } } : {}),
            } : {
                ...params.postOptions,
                model: options.model || params.engineModelId,
                prompt,
                max_tokens: maxTokens,
                temperature: params.postOptions?.temperature ?? (params.count > 1 ? 0.2 : 0),
                top_p: params.postOptions?.top_p ?? 1,
                n: params.postOptions?.n ?? params.count,
                stop,
                presence_penalty: options.presencePenalty ?? 0,
                frequency_penalty: options.frequencyPenalty ?? 0,
                stream: options.stream ?? true,
                extra: {
                    ...params.extra,
                    ...(options.contextPlacement === 'extra' && context.length ? { context } : {}),
                },
            };
            if (isFim) body.suffix = params.prompt.suffix;
            const url = `${options.baseUrl.replace(/\/+$/, '')}/${options.endpoint}`;
            const response = await fetch(url, {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
                },
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                if (controller.signal.aborted) {
                    cancellation?.dispose();
                    return { type: 'canceled', reason: 'local request canceled' };
                }
                const detail = await response.text();
                cancellation?.dispose();
                const reason = httpFailureReason(response.status, detail);
                reportLocalRequestStatus('ghost', reason, statusRequest);
                return { type: 'failed', reason };
            }

            const stream = async function* (): AsyncGenerator<Completion> {
                try {
                    let receivedChoices = false;
                    if (response.headers.get('content-type')?.includes('text/event-stream')) {
                        for await (const chunk of iterateSSEStream(response, controller.signal)) {
                            if (chunk.error) throw new Error(typeof chunk.error === 'string' ? chunk.error : chunk.error.message ?? 'Local completion endpoint returned an error');
                            if (chunk.choices?.length) {
                                if (!receivedChoices) reportLocalRequestStatus('ghost', undefined, statusRequest);
                                receivedChoices = true;
                                yield toCompletion(chunk.choices);
                            }
                        }
                    } else {
                        const json = await response.json() as {
                            choices?: Array<{ index?: number; text?: string; message?: { content?: string | null }; finish_reason?: string | null }>;
                            error?: string | { message?: string };
                        };
                        if (json.error) throw new Error(typeof json.error === 'string' ? json.error : json.error.message ?? 'Local completion endpoint returned an error');
                        if (json.choices?.length) {
                            reportLocalRequestStatus('ghost', undefined, statusRequest);
                            receivedChoices = true;
                            yield toCompletion(json.choices);
                        }
                    }
                    if (!controller.signal.aborted) {
                        reportLocalRequestStatus('ghost', receivedChoices ? undefined : 'Local completion endpoint returned no choices', statusRequest);
                    }
                } catch (error) {
                    if (!controller.signal.aborted) reportLocalRequestStatus('ghost', String(error), statusRequest);
                    throw error;
                } finally {
                    cancellation?.dispose();
                }
            };
            const responseStream = {
                stream: stream(),
                requestId: requestId(params.ourRequestId),
                destroy: async () => {
                    controller.abort();
                    cancellation?.dispose();
                },
            } as Parameters<typeof LiveOpenAIFetcher.convertStreamToApiChoices>[0];
            return {
                type: 'success',
                choices: LiveOpenAIFetcher.convertStreamToApiChoices(responseStream, finishedCb, telemetry, cancellationToken),
                getProcessingTime: () => 0,
            };
        } catch (error) {
            cancellation?.dispose();
            if (controller.signal.aborted) return { type: 'canceled', reason: 'local request canceled' };
            reportLocalRequestStatus('ghost', String(error), statusRequest);
            return { type: 'failed', reason: String(error) };
        }
    }
}
