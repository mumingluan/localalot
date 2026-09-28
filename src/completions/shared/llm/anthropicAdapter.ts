import { ILLMAdapter } from './llmAdapter';
import { LLMRequest, LLMResponse, LLMError, normalizeBody } from './llmRequest';
import { iterateSSEStream, readSSEStream } from './sseStream';

export class AnthropicAdapter implements ILLMAdapter {

    async *sendStream(request: LLMRequest, signal?: AbortSignal): AsyncGenerator<string, LLMResponse> {
        const response = await this._openResponse(request, signal);
        if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
            const result = this._parseJSON(await response.text());
            if (result.text) yield result.text;
            return result;
        }
        let text = '';
        let finishReason = 'stop';
        for await (const json of iterateSSEStream(response, signal)) {
            if (json.type === 'content_block_delta') {
                const delta = json.delta;
                if (delta?.type === 'text_delta' && delta.text) {
                    text += delta.text;
                    yield delta.text;
                }
            } else if (json.type === 'message_delta' && json.delta?.stop_reason) {
                finishReason = json.delta.stop_reason;
            }
        }
        return { text, finishReason };
    }

    async send(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
        const response = await this._openResponse(request, signal);
        const ct = response.headers.get('content-type') || '';
        if (ct.includes('text/event-stream')) {
            let text = '';
            let finishReason = 'stop';
            await readSSEStream(response, signal, json => {
                if (json.type === 'content_block_delta') {
                    const d = json.delta;
                    if (d?.type === 'text_delta' && d.text) text += d.text;
                } else if (json.type === 'message_delta') {
                    if (json.delta?.stop_reason) finishReason = json.delta.stop_reason;
                }
            });
            return { text, finishReason };
        }
        return this._parseJSON(await response.text());
    }

    private async _openResponse(request: LLMRequest, signal?: AbortSignal): Promise<Response> {
        const url = `${request.baseUrl}/messages`;
        const messages = request.messages || [];
        let system: string | undefined;
        const userMessages = messages.filter(m => {
            if (m.role === 'system') { system = m.content; return false; }
            return true;
        });

        const bodyObj: Record<string, unknown> = {
            model: request.model,
            messages: userMessages,
            max_tokens: request.max_tokens,
            stream: request.stream
        };
        if (request.context?.length) {
            const context = request.context.join('\n\n');
            system = system ? `${system}\n\n${context}` : context;
        }
        if (system) bodyObj.system = system;
        if (request.stop) bodyObj.stop_sequences = request.stop;
        const version = claudeModelVersion(request.model);
        const adaptive = version?.adaptive === true;
        const thinkingRequested = request.capabilities?.thinking === true;
        if (thinkingRequested && adaptive) {
            bodyObj.thinking = { type: 'adaptive' };
        } else if (thinkingRequested && request.max_tokens >= 2_048) {
            // Manual thinking requires at least 1024 tokens and must leave
            // enough of max_tokens for the visible code or cursor answer.
            bodyObj.thinking = {
                type: 'enabled',
                budget_tokens: Math.min(8_192, Math.floor(request.max_tokens / 2)),
            };
        }
        // Thinking disallows non-default sampling. Newer Claude versions also
        // reject it even for requests where thinking was not explicitly set.
        if (bodyObj.thinking === undefined && !version?.rejectsSamplingOverrides) {
            bodyObj.temperature = request.temperature;
            if (request.top_p !== undefined) bodyObj.top_p = request.top_p;
        }

        const response = await fetch(url, {
            method: 'POST',
            signal,
            headers: {
                'Content-Type': 'application/json',
                ...(request.apiKey ? { 'x-api-key': request.apiKey } : {}),
                'anthropic-version': '2023-06-01',
            },
            body: normalizeBody(JSON.stringify(bodyObj)),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new LLMError(`Anthropic API failed: ${response.status}`, response.status, text);
        }
        return response;
    }

    private _parseJSON(raw: string): LLMResponse {
        const json = JSON.parse(raw) as Record<string, unknown>;
        const content = (json.content as Array<Record<string, unknown>> | undefined) ?? [];
        return {
            text: content.filter(block => block.type === 'text' || block.type === undefined)
                .map(block => typeof block.text === 'string' ? block.text : '').join(''),
            finishReason: json.stop_reason as string || 'stop',
        };
    }
}

function claudeModelVersion(model: string): { adaptive: boolean; rejectsSamplingOverrides: boolean } | undefined {
    if (/^claude-mythos-preview\b/i.test(model)) return { adaptive: true, rejectsSamplingOverrides: true };
    const match = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/i.exec(model);
    if (!match) return undefined;
    const family = match[1].toLowerCase();
    const major = Number(match[2]);
    const minor = Number(match[3] ?? 0);
    const adaptive = major >= 5 || (major === 4 && minor >= 6 && (family === 'opus' || family === 'sonnet'));
    const rejectsSamplingOverrides = major >= 5 || (major === 4 && minor >= 7 && (family === 'opus' || family === 'sonnet'));
    return { adaptive, rejectsSamplingOverrides };
}
