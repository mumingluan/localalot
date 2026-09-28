import * as vscode from 'vscode';
import { IInlineEditsModelService } from '../vendor/copilot/src/platform/inlineEdits/common/inlineEditsModelService';
import {
    applyStrategyConfig, isPromptingStrategy, LINT_OPTIONS_VALIDATOR,
    ModelConfiguration, PromptingStrategy,
} from '../vendor/copilot/src/platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { ImportChanges } from '../vendor/copilot/src/platform/inlineEdits/common/dataTypes/importFilteringOptions';
import { Event } from '../vendor/copilot/src/util/vs/base/common/event';
import { constObservable } from '../vendor/copilot/src/util/vs/base/common/observable';
import { localNextCursorPredictionEnabled } from './localNesSettings';
import { modelSettingScope } from '../src/config/modelSettingScope';

/** Maps Localalot's NES model setting into the original model selection interface. */
export class LocalNesModelService implements IInlineEditsModelService {
    declare readonly _serviceBrand: undefined;
    readonly onModelListUpdated = Event.None;
    readonly supportsUnifiedCompletions = constObservable<boolean | undefined>(
        this.selectedModelConfiguration().supportsUnifiedCompletions,
    );

    private get modelId(): string {
        return vscode.workspace.getConfiguration('localalot.nes').get<string>('model', 'gpt-4o');
    }

    get modelInfo() {
        return {
            models: [{ id: this.modelId, name: this.modelId }],
            currentModelId: this.modelId,
        };
    }

    async setCurrentModelId(modelId: string): Promise<void> {
        const normalized = modelId.trim();
        if (!normalized) return;
        const config = vscode.workspace.getConfiguration('localalot.nes');
        await config.update('model', normalized, modelSettingScope(config.inspect<string>('model')));
    }

    selectedModelConfiguration(): ModelConfiguration {
        const config = vscode.workspace.getConfiguration('localalot.nes');
        const configuredStrategy = config.get<string>('promptingStrategy', PromptingStrategy.Xtab275);
        const rawLintOptions = config.get<unknown>('lintOptions', {});
        const checkedLintOptions = LINT_OPTIONS_VALIDATOR.validate(rawLintOptions);
        const lintOptions = rawLintOptions && typeof rawLintOptions === 'object'
            && Object.keys(rawLintOptions).length > 0 && !checkedLintOptions.error
            ? checkedLintOptions.content : undefined;
        return applyStrategyConfig({
            modelName: this.modelId,
            promptingStrategy: isPromptingStrategy(configuredStrategy)
                ? configuredStrategy : PromptingStrategy.Xtab275,
            includeTagsInCurrentFile: config.get<boolean>('includeTagsInCurrentFile', true),
            includePostScript: config.get<boolean>('includePostScript', true),
            lintOptions,
            allowImportChanges: config.get<boolean>('allowImportChanges', true) ? ImportChanges.All : ImportChanges.None,
            nesMimicGhostTextBehavior: config.get<boolean>('mimicGhostTextBehavior', false),
            supportsNextCursorLinePrediction: localNextCursorPredictionEnabled(),
        });
    }

    defaultModelConfiguration(): ModelConfiguration {
        return this.selectedModelConfiguration();
    }
}
