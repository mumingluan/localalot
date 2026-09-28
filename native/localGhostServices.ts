import * as vscode from 'vscode';
import { CopilotToken, createTestExtendedTokenInfo } from '../vendor/copilot/src/platform/authentication/common/copilotToken';
import { Event } from '../vendor/copilot/src/util/vs/base/common/event';
import type { ICompletionsCopilotTokenManager } from '../vendor/copilot/src/extension/completions-core/vscode-node/lib/src/auth/copilotTokenManager';
import type { ICompletionsModelManagerService } from '../vendor/copilot/src/extension/completions-core/vscode-node/lib/src/openai/model';
import { TokenizerName } from '../vendor/copilot/src/extension/completions-core/vscode-node/prompt/src/tokenization';

export const localToken = new CopilotToken(createTestExtendedTokenInfo({
    token: 'localalot-local-model',
    sku: 'no_auth_limited_copilot',
    expires_at: Number.MAX_SAFE_INTEGER,
}));

export class LocalTokenManager implements ICompletionsCopilotTokenManager {
    declare readonly _serviceBrand: undefined;
    get token() { return localToken; }
    async primeToken() { return true; }
    async getToken() { return localToken; }
    resetToken() { }
    getLastToken() { return localToken; }
}

export class LocalModelManager implements ICompletionsModelManagerService {
    declare readonly _serviceBrand: undefined;
    readonly onDidChangeModels = Event.None;

    private get modelId(): string {
        return vscode.workspace.getConfiguration('localalot.ghost').get<string>('model', '') || 'local-model';
    }

    private get tokenizer(): TokenizerName {
        return vscode.workspace.getConfiguration('localalot.ghost')
            .get<TokenizerName>('tokenizer', TokenizerName.o200k) === TokenizerName.cl100k
            ? TokenizerName.cl100k : TokenizerName.o200k;
    }

    getGenericCompletionModels() {
        return [{ modelId: this.modelId, label: this.modelId, preview: false, tokenizer: this.tokenizer }];
    }
    getDefaultModelId() { return this.modelId; }
    getTokenizerForModel() { return this.tokenizer; }
    getCurrentModelRequestInfo() {
        return { modelId: this.modelId, modelChoiceSource: 'custommodel' as const, headers: {} };
    }
}
