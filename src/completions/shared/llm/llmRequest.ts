export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/** Replace \r\n → \n before sending to LLM. LLMs handle \n consistently but \r\n support varies. */
export function normalizeBody(body: string): string {
    return body.replace(/\r\n/g, '\n');
}

export interface Capabilities {
    thinking?: boolean;
    reasoning_effort?: string;
}

/** Structured completion metadata understood by Copilot-compatible gateways. */
export interface CompletionExtra {
    language?: string;
    next_indent?: number;
    trim_by_indentation?: boolean;
    prompt_tokens?: number;
    suffix_tokens?: number;
}

export interface LLMRequest {
    model: string;
    baseUrl: string;
    apiKey: string; 
    family?: string;
    messages?: ChatMessage[];
    /** Predicted output for chat endpoints that support prefilled response matching. */
    prediction?: { type: 'content'; content: string | { type: string; text: string }[] };
    prompt?: string;
    suffix?:string;
    /** Auxiliary context sent separately from source code in completion APIs. */
    context?: string[];
    extra?: CompletionExtra;
    max_tokens: number;
    temperature: number;
    n?: number;
    top_p?: number;
    stop?: string[];
    capabilities?: Capabilities;
    presence_penalty?: number;
    frequency_penalty?: number;
    stream?: boolean;
}

export interface TokenUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

export interface LLMResponse {
    text: string;
    finishReason: string;
    choices?: Array<{ text: string; finishReason: string }>;
    usage?: TokenUsage;
}

/** Output-limit and interrupted responses may end inside a code edit or cursor coordinate. */
export function isIncompleteLLMResponse(response: LLMResponse | undefined): boolean {
    return /^(length|max_tokens|max_output_tokens|incomplete|content_filter|failed|cancelled|error)$/i
        .test(response?.finishReason ?? '');
}

export class LLMError extends Error {
    constructor(
        message: string,
        public readonly statusCode?: number,
        public readonly responseBody?: string,
    ) {
        super(message);
        this.name = 'LLMError';
    }

    toString(): string {
        const parts = [`${this.name}: ${this.message}`];
        if (this.statusCode !== undefined) parts.push(`status=${this.statusCode}`);
        if (this.responseBody) parts.push(`body=${this.responseBody}`);
        return parts.join(' ');
    }
}
