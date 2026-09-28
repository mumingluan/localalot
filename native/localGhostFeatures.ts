import * as vscode from 'vscode';
import { Features } from '../vendor/copilot/src/extension/completions-core/vscode-node/lib/src/experiments/features';
import type { TelemetryWithExp } from '../vendor/copilot/src/extension/completions-core/vscode-node/lib/src/telemetry';
import {
    DEFAULT_MAX_COMPLETION_LENGTH,
    DEFAULT_MAX_PROMPT_LENGTH,
} from '../vendor/copilot/src/extension/completions-core/vscode-node/prompt/src/prompt';

/** Keeps the original Ghost feature logic while using the selected local model's context window. */
export class LocalGhostFeatures extends Features {
    override maxPromptCompletionTokens(telemetry: TelemetryWithExp): number {
        const limits = vscode.workspace.getConfiguration('localalot.ghost.capabilities.limits');
        const defaultWindow = DEFAULT_MAX_PROMPT_LENGTH + DEFAULT_MAX_COMPLETION_LENGTH;
        const window = limits.get<number>('max_context_window_tokens', defaultWindow);
        if (!Number.isFinite(window) || window < 1024) return super.maxPromptCompletionTokens(telemetry);

        // Copilot reserves 500 tokens for completion when it computes its prompt
        // length. Adjust that combined limit for the smaller local output cap.
        const configuredOutput = limits.get<number>('max_output_tokens', DEFAULT_MAX_COMPLETION_LENGTH);
        const output = Number.isFinite(configuredOutput)
            ? Math.min(DEFAULT_MAX_COMPLETION_LENGTH, Math.max(1, Math.floor(configuredOutput)))
            : DEFAULT_MAX_COMPLETION_LENGTH;
        return Math.floor(window) - output + DEFAULT_MAX_COMPLETION_LENGTH;
    }
}
