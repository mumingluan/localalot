import * as vscode from 'vscode';
import { getLocalConfiguration } from '../src/config/compatConfiguration';
import { randomUUID } from 'crypto';
import type { Raw } from '@vscode/prompt-tsx';
import { ChatFetchResponseType, ChatResponse } from '../vendor/copilot/src/platform/chat/common/commonTypes';
import type { IMakeChatRequestOptions } from '../vendor/copilot/src/platform/networking/common/networking';
import { OpenAIChatCompletionAdapter } from '../src/completions/shared/llm/openaiChatCompletionAdapter';
import { OpenAIResponseAdapter } from '../src/completions/shared/llm/openaiResponseAdapter';
import { AnthropicAdapter } from '../src/completions/shared/llm/anthropicAdapter';
import { OpenAICompletionAdapter } from '../src/completions/shared/llm/openaiCompletionAdapter';
import type { ILLMAdapter } from '../src/completions/shared/llm/llmAdapter';
import { isIncompleteLLMResponse, LLMError, type LLMRequest, type ChatMessage } from '../src/completions/shared/llm/llmRequest';
import { localNesTokenBudget } from './localNesTokenBudget';
import { beginLocalRequest, reportLocalRequestStatus } from './localRequestStatus';

type LocalEndpoint = 'chat/completions' | 'responses' | 'messages' | 'completions';

export interface LocalNesEndpointOptions {
    model: string;
    baseUrl: string;
    apiKey: string;
    endpoint: LocalEndpoint;
    family: string;
    maxOutputTokens: number;
    maxContextWindowTokens: number;
    promptTemplate: string;
    presencePenalty: number;
    frequencyPenalty: number;
    stream: boolean;
    thinking: boolean;
    reasoningEffort: string;
    sendPrediction?: boolean;
}

function currentOptions(): LocalNesEndpointOptions {
    const config = getLocalConfiguration('localalot.nes');
    return {
        model: config.get<string>('model', 'gpt-4o'),
        baseUrl: config.get<string>('baseUrl', ''),
        apiKey: config.get<string>('apiKey', ''),
        endpoint: config.get<LocalEndpoint>('endpoint', 'chat/completions'),
        family: config.get<string>('family', 'standard'),
        maxOutputTokens: config.get<number>('capabilities.limits.max_output_tokens', 9216),
        maxContextWindowTokens: config.get<number>('capabilities.limits.max_context_window_tokens', 128000),
        promptTemplate: config.get<string>('promptTemplate', '{system}\n{user}'),
        presencePenalty: config.get<number>('presencePenalty', 0),
        frequencyPenalty: config.get<number>('frequencyPenalty', 0),
        stream: config.get<boolean>('stream', true),
        thinking: config.get<boolean>('capabilities.supports.thinking', false),
        reasoningEffort: config.get<string>('capabilities.supports.reasoning_effort', 'medium'),
        sendPrediction: config.get<boolean>('sendPrediction', false),
    };
}

function messageText(message: Raw.ChatMessage): string {
    return message.content.map(part => part.type === 1 ? part.text : '').join('');
}

function requestMessages(messages: Raw.ChatMessage[]): ChatMessage[] {
    return messages.filter(message => message.role !== 3).map(message => ({
        role: message.role === 0 ? 'system' : message.role === 2 ? 'assistant' : 'user',
        content: messageText(message),
    }));
}

function adapterFor(endpoint: LocalEndpoint): ILLMAdapter {
    switch (endpoint) {
        case 'responses': return new OpenAIResponseAdapter();
        case 'messages': return new AnthropicAdapter();
        case 'completions': return new OpenAICompletionAdapter({ debug() { }, error() { } } as never);
        default: return new OpenAIChatCompletionAdapter();
    }
}

function localRequestError(error: unknown): string {
    if (!(error instanceof LLMError)) return error instanceof Error ? error.message : String(error);
    let detail: string | undefined;
    try {
        const body = JSON.parse(error.responseBody ?? '') as {
            error?: string | { message?: string };
            message?: string;
        };
        detail = typeof body.error === 'string' ? body.error : body.error?.message ?? body.message;
    } catch { /* A raw server response may echo the request, so omit it from the editor status. */ }
    return detail ? `${error.message}: ${detail.slice(0, 240)}` : error.message;
}

/** Network-only bridge used by the original Xtab and cursor predictor classes. */
export class LocalNesEndpoint {
    readonly model: string;
    readonly family: string;
    readonly modelMaxPromptTokens: number;
    readonly maxOutputTokens: number;
    readonly apiType: 'responses' | 'messages' | 'chatCompletions';
    readonly urlOrRequestMetadata: string;

    constructor(model?: string, private readonly readOptions: () => LocalNesEndpointOptions = currentOptions) {
        const options = this.readOptions();
        this.model = model || options.model;
        this.family = options.family;
        const budget = localNesTokenBudget(options.maxContextWindowTokens, options.maxOutputTokens);
        this.modelMaxPromptTokens = budget.maxPromptTokens;
        this.maxOutputTokens = budget.maxOutputTokens;
        this.apiType = options.endpoint === 'responses' ? 'responses' : options.endpoint === 'messages' ? 'messages' : 'chatCompletions';
        this.urlOrRequestMetadata = `${options.baseUrl.replace(/\/+$/, '')}/${options.endpoint}`;
    }

    async makeChatRequest2(options: IMakeChatRequestOptions, token: vscode.CancellationToken): Promise<ChatResponse> {
        const local = this.readOptions();
        const endpoint = local.endpoint;
        const baseUrl = local.baseUrl.replace(/\/+$/, '');
        const requestId = randomUUID();
        if (!baseUrl) {
            return { type: ChatFetchResponseType.Failed, reason: 'Configure localalot.nes.baseUrl', requestId, serverRequestId: undefined };
        }
        const statusRequest = beginLocalRequest('nes');
        const messages = requestMessages(options.messages);
        const request: LLMRequest = {
            model: this.model,
            baseUrl,
            apiKey: local.apiKey,
            family: this.family,
            messages,
            prediction: endpoint === 'chat/completions' && local.sendPrediction
                ? options.requestOptions?.prediction : undefined,
            prompt: local.promptTemplate
                .replaceAll('{system}', messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n'))
                .replaceAll('{user}', messages.filter(m => m.role !== 'system').map(m => m.content).join('\n\n')),
            max_tokens: Math.min(this.maxOutputTokens, options.requestOptions?.max_tokens ?? this.maxOutputTokens),
            temperature: options.requestOptions?.temperature ?? 0,
            top_p: options.requestOptions?.top_p ?? 1,
            presence_penalty: local.presencePenalty,
            frequency_penalty: local.frequencyPenalty,
            stream: local.stream,
            capabilities: {
                thinking: local.thinking,
                reasoning_effort: local.reasoningEffort,
            },
        };
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        try {
            const adapter = adapterFor(endpoint);
            let text = '';
            let finishReason = 'stop';
            if (request.stream && adapter.sendStream) {
                const stream = adapter.sendStream(request, controller.signal);
                for (;;) {
                    const next = await stream.next();
                    if (next.done) {
                        finishReason = next.value.finishReason;
                        break;
                    }
                    text += next.value;
                    const finishOffset = await options.finishedCb?.(text, 0, { text: next.value });
                    if (finishOffset !== undefined) {
                        text = text.slice(0, Math.max(0, Math.min(text.length, finishOffset)));
                        await stream.return?.({ text, finishReason: 'stop' });
                        break;
                    }
                }
            } else {
                const response = await adapter.send(request, controller.signal);
                text = response.text;
                finishReason = response.finishReason;
                if (text) {
                    const finishOffset = await options.finishedCb?.(text, 0, { text });
                    if (finishOffset !== undefined) {
                        text = text.slice(0, Math.max(0, Math.min(text.length, finishOffset)));
                        finishReason = 'stop';
                    }
                }
            }
            if (controller.signal.aborted) {
                return { type: ChatFetchResponseType.Canceled, reason: 'Local NES request canceled', requestId, serverRequestId: undefined };
            }
            if (isIncompleteLLMResponse({ text, finishReason })) {
                reportLocalRequestStatus('nes', `Local next-edit response reached its output limit (${finishReason})`, statusRequest);
                return { type: ChatFetchResponseType.Length, reason: finishReason, truncatedValue: text, requestId, serverRequestId: undefined };
            }
            reportLocalRequestStatus('nes', undefined, statusRequest);
            return {
                type: ChatFetchResponseType.Success,
                value: text,
                requestId,
                serverRequestId: undefined,
                usage: undefined,
                resolvedModel: this.model,
            };
        } catch (error) {
            const reason = localRequestError(error);
            if (!controller.signal.aborted) reportLocalRequestStatus('nes', reason, statusRequest);
            return controller.signal.aborted
                ? { type: ChatFetchResponseType.Canceled, reason: 'Local NES request canceled', requestId, serverRequestId: undefined }
                : { type: ChatFetchResponseType.Failed, reason, requestId, serverRequestId: undefined };
        } finally {
            cancellation.dispose();
        }
    }
}
