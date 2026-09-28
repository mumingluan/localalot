import * as vscode from 'vscode';
import { GlobalBudgetOptions } from '../vendor/copilot/src/platform/inlineEdits/common/dataTypes/xtabPromptOptions';

export interface LocalNesTokenBudget {
    maxOutputTokens: number;
    maxPromptTokens: number;
    globalBudgetTokens?: number;
}

/** Size the original NES prompt pool and output within a local model's context window. */
export function localNesTokenBudget(contextWindow: number, outputLimit: number): LocalNesTokenBudget {
    const window = Number.isFinite(contextWindow) ? Math.max(1024, Math.floor(contextWindow)) : 128000;
    const desiredOutput = Number.isFinite(outputLimit)
        ? Math.max(1, Math.min(Math.floor(outputLimit), window - 256)) : 9216;
    const overhead = Math.min(1024, Math.floor(window / 4));
    const defaultPrompt = GlobalBudgetOptions.DEFAULT_TOTAL_TOKENS;
    if (window >= defaultPrompt + overhead + desiredOutput) {
        return { maxOutputTokens: desiredOutput, maxPromptTokens: window - desiredOutput };
    }

    const minimumOutput = Math.min(desiredOutput, Math.max(256, Math.floor(window / 4)));
    if (window >= defaultPrompt + overhead + minimumOutput) {
        const output = Math.min(desiredOutput, window - defaultPrompt - overhead);
        return { maxOutputTokens: output, maxPromptTokens: window - output };
    }

    return {
        maxOutputTokens: minimumOutput,
        maxPromptTokens: window - minimumOutput,
        globalBudgetTokens: Math.max(128, window - minimumOutput - overhead),
    };
}

export function localNesGlobalBudget(upstream: GlobalBudgetOptions | undefined): GlobalBudgetOptions | undefined {
    const config = vscode.workspace.getConfiguration('localalot.nes.capabilities.limits');
    const budget = localNesTokenBudget(
        config.get<number>('max_context_window_tokens', 128000),
        config.get<number>('max_output_tokens', 9216),
    ).globalBudgetTokens;
    if (budget === undefined || (upstream && upstream.totalTokens <= budget)) return upstream;
    return {
        totalTokens: budget,
        order: upstream?.order ?? GlobalBudgetOptions.DEFAULT_ORDER,
        shares: upstream?.shares ?? GlobalBudgetOptions.DEFAULT_SHARES,
    };
}
