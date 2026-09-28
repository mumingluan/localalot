import { createServiceIdentifier } from '../../../di/services';
import { Capabilities, CompletionExtra, LLMRequest, LLMResponse } from './llmRequest';
import { NesSupportedEndpoint } from '../../../config/nesConfig';

export const ILLMAdapterManager = createServiceIdentifier<ILLMAdapterManager>('ILLMAdapterManager');

export type LLMEndpoint = NesSupportedEndpoint | 'completions' | 'fim/completions';

export interface ILLMAdapter {
    send(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse>;
    /** Streaming variant: yields text deltas, returns the completed LLMResponse. */
    sendStream(request: LLMRequest, signal?: AbortSignal): AsyncGenerator<string, LLMResponse>;
}

/** Local endpoints may omit authentication entirely. */
export function bearerAuthHeaders(apiKey: string): Record<string, string> {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export function applyThinkingParams(
    body: Record<string, unknown>,
    capabilities?: Capabilities,
    family?: string,
): void {
    if (family === undefined) return;

    if (capabilities?.thinking !== undefined) {
        const enabled = capabilities?.thinking === true;
        switch (family) {
            case 'standard':
            case 'deepseek':
            case 'moonshot':
            case 'minimax':
            case 'qwen':
                body.enable_thinking = enabled;
                body.chat_template_kwargs = { enable_thinking: enabled };
                break;
        }
    }

    if (capabilities?.reasoning_effort) {
        const effort = (capabilities?.reasoning_effort as string) || 'medium';
        switch (family) {
            case 'openai-o':
                body.reasoning_effort = effort;
                break;
            case 'openai-gpt5':
                body.reasoning_effort = effort;
                break;
        }
    }
}

/** Match Copilot's `extra.context` request field without polluting FIM code. */
export function applyPromptContext(
    body: Record<string, unknown>,
    context?: string[],
    metadata?: CompletionExtra,
): void {
    if ((!context || context.length === 0) && (!metadata || Object.keys(metadata).length === 0)) return;
    const extra = body.extra && typeof body.extra === 'object'
        ? body.extra as Record<string, unknown>
        : {};
    body.extra = {
        ...extra,
        ...metadata,
        ...(context && context.length > 0 ? { context } : {}),
    };
}

export interface ILLMAdapterManager {
    readonly _serviceBrand: undefined;
    register(endpoint: LLMEndpoint, adapter: ILLMAdapter): void;
    getAdapter(endpoint: LLMEndpoint): ILLMAdapter;
}

export class LLMAdapterManager implements ILLMAdapterManager {
    readonly _serviceBrand: undefined;
    private readonly _adapters = new Map<string, ILLMAdapter>();

    register(endpoint: string, adapter: ILLMAdapter): void {
        this._adapters.set(endpoint, adapter);
    }

    getAdapter(endpoint: string): ILLMAdapter {
        const adapter = this._adapters.get(endpoint);
        if (!adapter) {
            throw new Error(`No adapter registered for endpoint: ${endpoint}`);
        }
        return adapter;
    }
}
