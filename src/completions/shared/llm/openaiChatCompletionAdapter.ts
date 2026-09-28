import { ILogService } from '../log/logService';
import { ILLMAdapter, applyPromptContext, applyThinkingParams, bearerAuthHeaders } from './llmAdapter';
import { LLMRequest, LLMResponse, LLMError, Capabilities, normalizeBody } from './llmRequest';
import { iterateSSEStream, readSSEStream } from './sseStream';

export class OpenAIChatCompletionAdapter implements ILLMAdapter {

    async *sendStream(request: LLMRequest, signal?: AbortSignal): AsyncGenerator<string, LLMResponse> {
        const url = `${request.baseUrl}/chat/completions`;
        const body = JSON.stringify(this._bodyForRequest(request));

        const response = await fetch(url, {
            method: 'POST',
            signal,
            headers: {
                'Content-Type': 'application/json',
                ...bearerAuthHeaders(request.apiKey),
            },
            body: normalizeBody(body),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new LLMError(`OpenAI chat request failed: ${response.status}`, response.status, text);
        }

        const ct = response.headers.get('content-type') || '';
        if (ct.includes('text/event-stream')) {
            let text = '';
            let finishReason = 'stop';
            for await (const json of iterateSSEStream(response, signal)) {
                const choice = json.choices?.[0];
                if (choice?.delta?.content) {
                    text += choice.delta.content;
                    yield choice.delta.content;
                }
                if (choice?.finish_reason) finishReason = choice.finish_reason;
            }
            return { text, finishReason };
        }
        // Non-streaming fallback: yield full text, return the response
        const result = this._parseJSON(await response.text());
        yield result.text;
        return result;
    }

    async send(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
        const url = `${request.baseUrl}/chat/completions`;
        const body = JSON.stringify(this._bodyForRequest(request));

        const response = await fetch(url, {
            method: 'POST',
            signal,
            headers: {
                'Content-Type': 'application/json',
                ...bearerAuthHeaders(request.apiKey),
            },
            body: normalizeBody(body),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new LLMError(`OpenAI chat request failed: ${response.status}`, response.status, text);
        }

        const ct = response.headers.get('content-type') || '';
        if (ct.includes('text/event-stream')) {
            let text = '';
            let finishReason = 'stop';
            await readSSEStream(response, signal, json => {
                const choice = json.choices?.[0];
                if (choice?.delta?.content) {
                    text += choice.delta.content;
                }
                if (choice?.finish_reason) finishReason = choice.finish_reason;
            });
            return { text, finishReason };
        }
        return this._parseJSON(await response.text());
    }

    private _bodyForRequest(request: LLMRequest): Record<string, unknown> {
        const reasoningFamily = request.family === 'openai-o' || request.family === 'openai-gpt5';
        const reasoningActive = reasoningFamily && request.capabilities?.reasoning_effort !== 'none';
        const bodyObj: Record<string, unknown> = {
            model: request.model,
            messages: request.messages || [],
            ...(request.prediction ? { prediction: request.prediction } : {}),
            [reasoningFamily ? 'max_completion_tokens' : 'max_tokens']: request.max_tokens,
            stream: request.stream,
            stop: request.stop,
            n: request.n,
        };
        if (!reasoningActive) {
            bodyObj.temperature = request.temperature;
            bodyObj.top_p = request.top_p;
            bodyObj.presence_penalty = request.presence_penalty;
            bodyObj.frequency_penalty = request.frequency_penalty;
        }
        applyThinkingParams(bodyObj, request.capabilities, request.family);
        applyPromptContext(bodyObj, request.context, request.extra);
        return bodyObj;
    }

    private _parseJSON(raw: string): LLMResponse {
        const json = JSON.parse(raw) as Record<string, unknown>;
        const choices = json.choices as Array<Record<string, unknown>>;
        const parsedChoices = (choices ?? []).map(choice => {
            const message = choice.message as Record<string, string> | undefined;
            return {
                text: message?.content || '',
                finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop',
            };
        });
        return {
            text: parsedChoices[0]?.text ?? '',
            finishReason: parsedChoices[0]?.finishReason ?? 'stop',
            choices: parsedChoices,
        };
    }
}


