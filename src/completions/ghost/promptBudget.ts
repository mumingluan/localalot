export interface GhostPromptBudget {
    prefixChars: number;
    suffixChars: number;
    contextChars: number;
}

export interface GhostTokenBudget {
    prefixTokens: number;
    suffixTokens: number;
}

export interface GhostModelWindowBudget {
    inputTokens: number;
    outputTokens: number;
    safetyTokens: number;
}

/** Default Copilot completion budget: 8192 total tokens minus 500 for output. */
export const NATIVE_GHOST_PROMPT_TOKEN_LIMIT = 7_692;

/** Keep large-model headroom while letting small local models see useful source. */
export function allocateGhostModelWindow(
    contextWindowTokens: number,
    configuredOutputTokens: number,
): GhostModelWindowBudget {
    const contextWindow = Math.max(0, Math.floor(contextWindowTokens));
    const safetyTokens = Math.min(768, Math.max(32, Math.floor(contextWindow * 0.08)));
    const outputTokens = Math.min(
        Math.max(1, Math.floor(configuredOutputTokens)),
        Math.max(1, Math.floor(contextWindow * 0.45)),
    );
    return {
        inputTokens: Math.min(NATIVE_GHOST_PROMPT_TOKEN_LIMIT,
            Math.max(0, contextWindow - outputTokens - safetyTokens)),
        outputTokens,
        safetyTokens,
    };
}

/** Reserve suffix tokens, then cascade unused prefix room to the suffix. */
export function allocateGhostTokenBudget(
    totalTokens: number,
    prefixLengthTokens: number,
    suffixLengthTokens: number,
    suffixPercent = 20,
): GhostTokenBudget {
    const total = Math.max(0, Math.floor(totalTokens));
    const suffixLength = Math.max(0, Math.floor(suffixLengthTokens));
    let suffixTokens = Math.min(suffixLength,
        Math.floor(total * Math.max(0, Math.min(100, suffixPercent)) / 100));
    let prefixTokens = total - suffixTokens;
    const unusedPrefix = Math.max(0, prefixTokens - Math.max(0, Math.floor(prefixLengthTokens)));
    const extraSuffix = Math.min(suffixLength - suffixTokens, unusedPrefix);
    suffixTokens += extraSuffix;
    prefixTokens -= extraSuffix;
    return { prefixTokens, suffixTokens };
}

/** Allocate an approximate character budget while reserving room for prompt context. */
export function allocateGhostPromptBudget(
    totalChars: number,
    suffixLength: number,
    reserveContext: boolean,
    suffixPercent = 20,
    prefixLength?: number,
): GhostPromptBudget {
    const total = Math.max(0, Math.floor(totalChars));
    const contextChars = reserveContext ? Math.min(6_000, Math.floor(total * 0.12)) : 0;
    const sourceChars = Math.max(0, total - contextChars);
    let suffixChars = Math.min(
        Math.max(0, Math.floor(suffixLength)),
        Math.floor(sourceChars * Math.max(0, Math.min(100, suffixPercent)) / 100),
    );
    let prefixChars = sourceChars - suffixChars;
    if (prefixLength !== undefined) {
        const unusedPrefix = Math.max(0, prefixChars - Math.max(0, Math.floor(prefixLength)));
        const extraSuffix = Math.min(Math.max(0, Math.floor(suffixLength)) - suffixChars, unusedPrefix);
        suffixChars += extraSuffix;
        prefixChars -= extraSuffix;
    }
    return {
        prefixChars,
        suffixChars,
        contextChars,
    };
}
