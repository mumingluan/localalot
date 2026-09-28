import { sliceCompleteCodePoints } from '../../../common/unicodeSlice';

/** Conservative fallback when a model-specific tokenizer is unavailable. */
export function estimatePromptTokens(text: string): number {
    let tokens = 0;
    let asciiRun = 0;
    const flushAscii = () => {
        tokens += Math.ceil(asciiRun / 4);
        asciiRun = 0;
    };
    for (const character of text) {
        const codePoint = character.codePointAt(0)!;
        if (codePoint <= 0x7f) {
            asciiRun++;
        } else {
            flushAscii();
            tokens += codePoint > 0xffff ? 2 : 1;
        }
    }
    flushAscii();
    return tokens;
}

/** Keep fallback clipping within the same estimate used for prompt accounting. */
export function takeEstimatedPromptTokens(text: string, limit: number, fromEnd = false): string {
    if (limit <= 0) return '';
    if (estimatePromptTokens(text) <= limit) return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
        const length = Math.ceil((low + high) / 2);
        const candidate = fromEnd ? text.slice(-length) : text.slice(0, length);
        if (estimatePromptTokens(candidate) <= limit) low = length;
        else high = length - 1;
    }
    return sliceCompleteCodePoints(text, low, fromEnd);
}
