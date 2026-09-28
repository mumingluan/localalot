/** Parse complete SSE events, including a final event without a blank line. */

export interface SSEChunk {
    error?: string | { message?: string };
    choices?: Array<{
        index: number;
        text?: string;
        delta?: { content: string | null };
        message?: { content?: string | null; prefix?: boolean; role?: string };
        finish_reason?: string | null;
    }>;
    model?: string;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        input_tokens?: number;
        output_tokens?: number;
    };
    // Anthropic
    type?: string;
    delta?: { type?: string; text?: string; stop_reason?: string };
    message?: { usage?: { input_tokens: number; output_tokens: number } };
    // Responses API
    response?: {
        output?: Array<{ content?: Array<{ text?: string }> }>;
        usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
        error?: string | { message?: string };
    };
}

function throwIfStreamFailed(chunk: SSEChunk): void {
    if (chunk.error === undefined && chunk.type !== 'error'
        && chunk.type !== 'response.failed' && chunk.type !== 'response.cancelled') return;
    const error = chunk.error ?? chunk.response?.error;
    const detail = typeof error === 'string' ? error : error?.message;
    throw new Error(`Local model stream failed${detail ? `: ${detail.slice(0, 240)}` : `: ${chunk.type ?? 'error'}`}`);
}

export type TextAccumulator = {
    addCompletionText(chunk: SSEChunk): void;
    addChatDelta(chunk: SSEChunk): void;
    addAnthropicDelta(chunk: SSEChunk, result: { text: string; finishReason: string }): void;
    addResponseDelta(chunk: SSEChunk, result: { text: string }): void;
};

export async function readSSEStream(
    response: Response,
    signal: AbortSignal | undefined,
    onChunk: (chunk: SSEChunk) => void,
): Promise<void> {
    for await (const chunk of iterateSSEStream(response, signal)) onChunk(chunk);
}

/** Expose SSE events incrementally to adapters that yield model text. */
export async function* iterateSSEStream(
    response: Response,
    signal?: AbortSignal,
): AsyncGenerator<SSEChunk> {
    const stream = response.body!.pipeThrough(new TextDecoderStream());
    const reader = stream.getReader();
    const cancelRead = () => { void reader.cancel().catch(() => undefined); };
    signal?.addEventListener('abort', cancelRead, { once: true });
    if (signal?.aborted) cancelRead();
    let pending = '';
    let dataLines: string[] = [];
    const finishEvent = (): SSEChunk | 'done' | undefined => {
        if (dataLines.length === 0) return undefined;
        const data = dataLines.join('\n');
        dataLines = [];
        if (data.trim() === '[DONE]') return 'done';
        try { return JSON.parse(data) as SSEChunk; } catch { return undefined; }
    };
    const consumeLine = (line: string): SSEChunk | 'done' | undefined => {
        if (line === '') return finishEvent();
        if (line === 'data') dataLines.push('');
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        else return undefined;
        // Most gateways send one JSON object per event. Dispatch as soon as
        // it is complete, including gateways that omit the blank separator.
        // Pretty-printed JSON remains buffered until its last data line.
        const data = dataLines.join('\n');
        if (data.trim() === '[DONE]') return finishEvent();
        try { JSON.parse(data); } catch { return undefined; }
        return finishEvent();
    };
    try {
        while (true) {
            if (signal?.aborted) return;
            const { value: rawChunk, done } = await reader.read();
            if (signal?.aborted) return;
            if (done) break;
            pending += rawChunk ?? '';
            while (true) {
                const end = pending.search(/[\r\n]/);
                if (end < 0 || (pending[end] === '\r' && end === pending.length - 1)) break;
                const line = pending.slice(0, end);
                const width = pending[end] === '\r' && pending[end + 1] === '\n' ? 2 : 1;
                pending = pending.slice(end + width);
                const event = consumeLine(line);
                if (event === 'done') return;
                if (event) {
                    throwIfStreamFailed(event);
                    yield event;
                }
            }
        }
        if (pending) {
            const event = consumeLine(pending.replace(/\r$/, ''));
            if (event === 'done') return;
            if (event) {
                throwIfStreamFailed(event);
                yield event;
            }
        }
        const finalEvent = finishEvent();
        if (finalEvent !== 'done' && finalEvent) {
            throwIfStreamFailed(finalEvent);
            yield finalEvent;
        }
    } finally {
        signal?.removeEventListener('abort', cancelRead);
        try { await reader.cancel(); } catch { /* ignore */ }
        try { await response.body?.cancel(); } catch { /* ignore */ }
    }
}
