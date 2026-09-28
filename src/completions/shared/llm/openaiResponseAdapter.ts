import { ILLMAdapter, bearerAuthHeaders } from './llmAdapter';
import { LLMRequest, LLMResponse, LLMError, normalizeBody } from './llmRequest';
import { iterateSSEStream, readSSEStream } from './sseStream';

export class OpenAIResponseAdapter implements ILLMAdapter {

    async *sendStream(request: LLMRequest, signal?: AbortSignal): AsyncGenerator<string, LLMResponse> {
        const response = await this._openResponse(request, signal);
        if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
            const result = this._parseJSON(await response.text(), request.stop);
            if (result.text) yield result.text;
            return result;
        }
        const stops = new IncrementalStopFilter(request.stop);
        let text = '';
        let sawTextDelta = false;
        let finishReason = 'stop';
        for await (const json of iterateSSEStream(response, signal)) {
            let delta = '';
            if (json.type === 'response.output_text.delta') {
                sawTextDelta = true;
                delta = this._extractDeltaText(json.delta);
            } else if (this._isTerminalEvent(json.type)) {
                finishReason = this._finishReason(json.response, json.type);
                if (!sawTextDelta) delta = this._extractOutputText(json.response);
            }
            if (!delta) continue;
            const visible = stops.push(delta);
            if (visible) {
                text += visible;
                yield visible;
            }
            if (stops.stopped) return { text, finishReason: 'stop' };
        }
        const remaining = stops.finish();
        if (remaining) {
            text += remaining;
            yield remaining;
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
                if (json.type === 'response.output_text.delta') {
                    text += this._extractDeltaText(json.delta);
                } else if (this._isTerminalEvent(json.type)) {
                    finishReason = this._finishReason(json.response, json.type);
                    if (!text) text = this._extractOutputText(json.response);
                }
            });
            return { text: trimAtStops(text, request.stop), finishReason };
        }
        return this._parseJSON(await response.text(), request.stop);
    }

    private async _openResponse(request: LLMRequest, signal?: AbortSignal): Promise<Response> {
        const url = `${request.baseUrl}/responses`;
        const contextInput = request.context?.length
            ? [{ role: 'developer', content: request.context.join('\n\n') }]
            : [];
        const input = [...contextInput, ...(request.messages || [])].map(m => ({ role: m.role, content: m.content }));
        const bodyObj: Record<string, unknown> = {
            model: request.model,
            input,
            max_output_tokens: request.max_tokens,
            stream: request.stream
        };
        const reasoningEffort = (request.family === 'openai-o' || request.family === 'openai-gpt5')
            ? request.capabilities?.reasoning_effort : undefined;
        if ((!request.family || (request.family !== 'openai-o' && request.family !== 'openai-gpt5'))
                || reasoningEffort === 'none') {
            bodyObj.temperature = request.temperature;
            bodyObj.top_p = request.top_p;
        }
        // The Responses API does not expose Chat Completions' `stop` field.
        // Apply the same boundary client-side after receiving the output.
        // Responses supports OpenAI's reasoning field, but not the
        // enable_thinking/chat_template_kwargs fields used by gateway
        // adapters for Qwen/DeepSeek-style models.
        if (reasoningEffort) {
            bodyObj.reasoning = { effort: reasoningEffort };
        }
        const body = JSON.stringify(bodyObj);

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
            throw new LLMError(`OpenAI responses API failed: ${response.status}`, response.status, text);
        }
        return response;
    }

    private _parseJSON(raw: string, stops?: string[]): LLMResponse {
        const json = JSON.parse(raw) as Record<string, unknown>;
        return { text: trimAtStops(this._extractOutputText(json), stops), finishReason: this._finishReason(json) };
    }

    private _isTerminalEvent(type: unknown): boolean {
        return type === 'response.completed' || type === 'response.incomplete'
            || type === 'response.failed' || type === 'response.cancelled';
    }

    private _finishReason(response: unknown, eventType?: unknown): string {
        const data = response && typeof response === 'object' ? response as Record<string, unknown> : {};
        const status = typeof data.status === 'string' ? data.status
            : typeof eventType === 'string' ? eventType.replace(/^response\./, '') : undefined;
        if (status === 'incomplete') {
            const details = data.incomplete_details;
            if (details && typeof details === 'object' && typeof (details as Record<string, unknown>).reason === 'string') {
                return (details as Record<string, string>).reason;
            }
        }
        return status && status !== 'completed' ? status : 'stop';
    }

    private _extractOutputText(response: unknown): string {
        if (!response || typeof response !== 'object') return '';
        const data = response as Record<string, unknown>;
        if (typeof data.output_text === 'string' && data.output_text.length > 0) return data.output_text;
        const output: Array<Record<string, unknown>> = Array.isArray(data.output) ? data.output : [];
        return output.flatMap(item => {
            if (!item || typeof item !== 'object' || (item.type !== 'message' && item.type !== undefined)) return [];
            const content: Array<Record<string, unknown>> = Array.isArray(item.content) ? item.content : [];
            return content.filter(part => part && (part.type === 'output_text' || part.type === undefined)
                    && typeof part.text === 'string')
                .map(part => part.text as string);
        }).join('');
    }

    private _extractDeltaText(delta: unknown): string {
        if (typeof delta === 'string') return delta;
        if (delta && typeof delta === 'object' && 'text' in delta
                && typeof delta.text === 'string') return delta.text;
        return '';
    }
}

/** Hold possible stop prefixes until later SSE chunks disambiguate them. */
class IncrementalStopFilter {
    private pending = '';
    private readonly stops: string[];
    stopped = false;

    constructor(stops?: readonly string[]) {
        this.stops = (stops ?? []).filter(Boolean);
    }

    push(delta: string): string {
        if (this.stopped) return '';
        if (this.stops.length === 0) return delta;
        this.pending += delta;
        let stopAt = this.pending.length;
        for (const stop of this.stops) {
            const index = this.pending.indexOf(stop);
            if (index >= 0) stopAt = Math.min(stopAt, index);
        }
        if (stopAt < this.pending.length) {
            const visible = this.pending.slice(0, stopAt);
            this.pending = '';
            this.stopped = true;
            return visible;
        }
        let held = 0;
        for (const stop of this.stops) {
            for (let size = 1; size < stop.length && size <= this.pending.length; size++) {
                if (this.pending.endsWith(stop.slice(0, size))) held = Math.max(held, size);
            }
        }
        const visible = this.pending.slice(0, this.pending.length - held);
        this.pending = this.pending.slice(this.pending.length - held);
        return visible;
    }

    finish(): string {
        if (this.stopped) return '';
        const remaining = this.pending;
        this.pending = '';
        return remaining;
    }
}

function trimAtStops(text: string, stops?: readonly string[]): string {
    if (!text || !stops?.length) return text;
    let end = text.length;
    for (const stop of stops) {
        if (!stop) continue;
        const index = text.indexOf(stop);
        if (index >= 0) end = Math.min(end, index);
    }
    return text.slice(0, end);
}
