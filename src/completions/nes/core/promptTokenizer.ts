import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createTokenizer, getRegexByEncoder, getSpecialTokensByEncoder, TikTokenizer } from '@microsoft/tiktokenizer';
import { estimatePromptTokens, takeEstimatedPromptTokens } from './promptTokenEstimate';

const ENCODER = 'o200k_base';
let tokenizer: TikTokenizer | undefined;
let loadPromise: Promise<boolean> | undefined;

/** Other model families can use different vocabularies; retain the safe estimate for them. */
export function usesO200kPromptTokenizer(family: string | undefined): boolean {
    return family === 'standard' || family === 'openai-o' || family === 'openai-gpt5';
}

function tokenAssetPath(): string {
    const filename = 'o200k_base.tiktoken';
    const bundled = path.resolve(__dirname, 'tokenizer', filename);
    const compiledTest = path.resolve(__dirname, '../../../../dist/tokenizer', filename);
    return existsSync(bundled) ? bundled : compiledTest;
}

/** Load the bundled BPE dictionary once, before building a GPT prompt. */
export function ensurePromptTokenizerLoaded(): Promise<boolean> {
    if (tokenizer) return Promise.resolve(true);
    loadPromise ??= (async () => {
        try {
            const filename = tokenAssetPath();
            await fs.access(filename);
            tokenizer = createTokenizer(filename, getSpecialTokensByEncoder(ENCODER), getRegexByEncoder(ENCODER), 32768);
            return true;
        } catch {
            return false;
        }
    })();
    return loadPromise;
}

export function countPromptTokens(text: string, family: string | undefined): number {
    if (tokenizer && usesO200kPromptTokenizer(family)) {
        try {
            return tokenizer.encode(text).length;
        } catch {
            // Malformed input must not suppress code suggestions.
        }
    }
    return estimatePromptTokens(text);
}

/** Ghost has a model name but no model-family setting. */
export function usesO200kGhostTokenizer(model: string): boolean {
    return /^(?:gpt[-_]|o[1-9](?:[-_]|$))/i.test(model);
}

export function countO200kTokens(text: string): number {
    if (tokenizer) {
        try {
            return tokenizer.encode(text).length;
        } catch {
            // A tokenizer failure should not hide an inline suggestion.
        }
    }
    return estimatePromptTokens(text);
}

export function takeFirstO200kTokens(text: string, limit: number): string {
    if (limit <= 0) return '';
    if (tokenizer) {
        try {
            return tokenizer.encodeTrimSuffix(text, limit, []).text;
        } catch {
            // Use the same bounded fallback as token accounting.
        }
    }
    return takeEstimatedPromptTokens(text, limit);
}

export function takeLastO200kTokens(text: string, limit: number): string {
    if (limit <= 0) return '';
    if (tokenizer) {
        try {
            return tokenizer.encodeTrimPrefix(text, limit, []).text;
        } catch {
            // Use the same bounded fallback as token accounting.
        }
    }
    return takeEstimatedPromptTokens(text, limit, true);
}
