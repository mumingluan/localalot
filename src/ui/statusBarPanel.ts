import * as vscode from 'vscode';
import { getLocalConfiguration } from '../config/compatConfiguration';
import { createServiceIdentifier } from '../di/services';
import { IGhostConfigProvider } from '../config/ghostConfig';
import { INesConfigProvider } from '../config/nesConfig';
import { ILogService } from '../completions/shared/log/logService';
import { isEligibleForInlineCompletion, isSourceDocumentUri, isUnavailableForInlineCompletion } from '../completions/shared/documentEligibility';
import { modelSettingScope } from '../config/modelSettingScope';
import { getPendingNextEditAction, onDidChangePendingNextEdit } from '../completions/shared/inlineRegistration';
import { listLocalModelIds } from './localModelPicker';

export const IStatusBarPanel = createServiceIdentifier<IStatusBarPanel>('IStatusBarPanel');

export interface IStatusBarPanel {
    readonly _serviceBrand: undefined;
    register(): vscode.Disposable;
}

type InlineSuggestOverride = {
    key: 'workspaceFolderLanguageValue' | 'workspaceFolderValue'
        | 'workspaceLanguageValue' | 'workspaceValue'
        | 'globalLanguageValue' | 'globalValue';
    target: vscode.ConfigurationTarget;
    languageOverride: boolean;
};

const inlineSuggestOverrides: readonly InlineSuggestOverride[] = [
    { key: 'workspaceFolderLanguageValue', target: vscode.ConfigurationTarget.WorkspaceFolder, languageOverride: true },
    { key: 'workspaceFolderValue', target: vscode.ConfigurationTarget.WorkspaceFolder, languageOverride: false },
    { key: 'workspaceLanguageValue', target: vscode.ConfigurationTarget.Workspace, languageOverride: true },
    { key: 'workspaceValue', target: vscode.ConfigurationTarget.Workspace, languageOverride: false },
    { key: 'globalLanguageValue', target: vscode.ConfigurationTarget.Global, languageOverride: true },
    { key: 'globalValue', target: vscode.ConfigurationTarget.Global, languageOverride: false },
];

/** An explicit false at a more specific scope can mask a true written elsewhere. */
export function disabledInlineSuggestOverrides(
    inspected: Partial<Record<InlineSuggestOverride['key'], boolean>> | undefined,
): readonly InlineSuggestOverride[] {
    return inlineSuggestOverrides.filter(override => inspected?.[override.key] === false);
}

export interface LocalRequestStatus {
    component: 'ghost' | 'nes';
    message: string;
}

/** Match the native menu: an unconfigured language changes the `*` fallback. */
export function enabledConfigAfterMenuToggle(
    current: Record<string, boolean> | boolean,
    languageId: string,
    enabled: boolean,
): Record<string, boolean> {
    const result: Record<string, boolean> = typeof current === 'boolean' ? { '*': current } : { ...current };
    if (Object.prototype.hasOwnProperty.call(result, languageId)) result[languageId] = enabled;
    else result['*'] = enabled;
    return result;
}

export class StatusBarPanel implements IStatusBarPanel {
    readonly _serviceBrand: undefined;
    private _statusBarItem: vscode.StatusBarItem;
    private _invalidateGhost?: () => void;
    private _invalidateNes?: () => void;
    private _nesHandlesCompletions?: () => boolean;
    private _requestStatuses: () => readonly LocalRequestStatus[] = () => [];

    setRequestStatusProvider(read: () => readonly LocalRequestStatus[]): void {
        this._requestStatuses = read;
        this._updateStatusBar();
    }

    refresh(): void {
        this._updateStatusBar();
    }

    setCacheInvalidators(ghost: () => void, nes: () => void): void {
        this._invalidateGhost = ghost;
        this._invalidateNes = nes;
    }

    setUnifiedCompletionsProvider(read: () => boolean): void {
        this._nesHandlesCompletions = read;
        this._updateStatusBar();
    }

    constructor(
        @IGhostConfigProvider private readonly _ghostConfig: IGhostConfigProvider,
        @INesConfigProvider private readonly _nesConfig: INesConfigProvider,
        @ILogService private readonly _log: ILogService,
    ) {
        this._statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100,
        );
        this._statusBarItem.name = 'Localalot';
        this._updateStatusBar();
    }

    register(): vscode.Disposable {
        this._statusBarItem.show();
        this._statusBarItem.command = 'localalot.togglePanel';

        const commandDisposable = vscode.commands.registerCommand(
            'localalot.togglePanel',
            () => this._showQuickPick(),
        );
        const commandDisposables = [
            vscode.commands.registerCommand('localalot.toggleLanguage', () => this._toggleLanguage()),
            vscode.commands.registerCommand('localalot.enableInlineSuggestions', () => this._setInlineSuggestionsEnabled(true)),
            vscode.commands.registerCommand('localalot.disableInlineSuggestions', () => this._setInlineSuggestionsEnabled(false)),
            vscode.commands.registerCommand('localalot.toggleInlineSuggestions', () => {
                const document = vscode.window.activeTextEditor?.document;
                if (!document) return;
                const enabled = this._isLanguageEnabled(document) && this._isEditorInlineSuggestEnabled(document)
                    && (this._ghostConfig.enabled || this._nesConfig.enabled);
                return this._setInlineSuggestionsEnabled(!enabled);
            }),
            vscode.commands.registerCommand('localalot.changeCompletionModels', () => this._showModelPicker()),
            vscode.commands.registerCommand('localalot.openSettings', () =>
                vscode.commands.executeCommand('workbench.action.openSettings', '@ext:young-triangle.localalot')),
            vscode.commands.registerCommand('localalot.clearCache', () => {
                this._clearCaches();
            }),
            vscode.commands.registerCommand('localalot.trigger', () =>
                vscode.commands.executeCommand('editor.action.inlineSuggest.trigger')),
        ];

        const ghostChange = this._ghostConfig.onDidChangeEnabled(() => this._updateStatusBar());
        const nesChange = this._nesConfig.onDidChangeEnabled(() => this._updateStatusBar());
        const editorChange = vscode.window.onDidChangeActiveTextEditor(() => this._updateStatusBar());
        const selectionChange = vscode.window.onDidChangeTextEditorSelection(() => this._updateStatusBar());
        const pendingEditChange = onDidChangePendingNextEdit(() => this._updateStatusBar());
        const configChange = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('localalot.enable')
                || event.affectsConfiguration('cc-completion.enable')
                || event.affectsConfiguration('localalot.nextEditSuggestions.enabled')
                || event.affectsConfiguration('cc-completion.nextEditSuggestions.enabled')
                || event.affectsConfiguration('localalot.nextEditSuggestions.extendedRange')
                || event.affectsConfiguration('cc-completion.nextEditSuggestions.extendedRange')
                || event.affectsConfiguration('localalot.nextEditSuggestions.eagerness')
                || event.affectsConfiguration('cc-completion.nextEditSuggestions.eagerness')
                || event.affectsConfiguration('localalot.exclude')
                || event.affectsConfiguration('cc-completion.exclude')
                || event.affectsConfiguration('localalot.ghost.baseUrl')
                || event.affectsConfiguration('cc-completion.ghost.baseUrl')
                || event.affectsConfiguration('localalot.nes.baseUrl')
                || event.affectsConfiguration('cc-completion.nes.baseUrl')
                || event.affectsConfiguration('localalot.nes.promptingStrategy')
                || event.affectsConfiguration('cc-completion.nes.promptingStrategy')
                || event.affectsConfiguration('localalot.nes.endpoint')
                || event.affectsConfiguration('cc-completion.nes.endpoint')
                || event.affectsConfiguration('editor.inlineSuggest.enabled')) {
                this._updateStatusBar();
            }
        });

        return {
            dispose: () => {
                this._statusBarItem.dispose();
                commandDisposable.dispose();
                for (const disposable of commandDisposables) disposable.dispose();
                ghostChange.dispose();
                nesChange.dispose();
                editorChange.dispose();
                selectionChange.dispose();
                pendingEditChange.dispose();
                configChange.dispose();
            },
        };
    }

    private _updateStatusBar(): void {
        const ghostOn = this._ghostConfig.enabled;
        const document = vscode.window.activeTextEditor?.document;
        const nesOn = this._isNextEditEnabled(document);
        const unified = this._nesConfig.enabled && (this._nesHandlesCompletions?.() ?? false);
        const ncpOn = nesOn && this._isNextCursorPredictionEnabled(document);
        const editorInlineOn = !document || this._isEditorInlineSuggestEnabled(document);
        if (!editorInlineOn) {
            this._statusBarItem.text = '$(copilot-not-connected) Completions';
            this._statusBarItem.tooltip = 'VS Code inline suggestions are disabled';
            return;
        }
        const languageOn = !document || this._isLanguageEnabled(document);
        if (!languageOn) {
            this._statusBarItem.text = '$(copilot-not-connected) Completions';
            this._statusBarItem.tooltip = `Inline suggestions disabled for ${document?.languageId ?? 'this language'}`;
            return;
        }
        if (document && !isEligibleForInlineCompletion(document)) {
            this._statusBarItem.text = '$(copilot-not-connected) Completions';
            this._statusBarItem.tooltip = isSourceDocumentUri(document.uri)
                ? 'Inline suggestions are excluded for this file. Open Completion Settings to review excluded files.'
                : 'Inline suggestions are unavailable in this editor.';
            return;
        }
        const unconfigured = [
            ghostOn && !unified && this._ghostConfig.endpointConfigured === false && 'ghost.baseUrl',
            nesOn && this._nesConfig.endpointConfigured === false && 'nes.baseUrl',
        ].filter((value): value is string => typeof value === 'string');
        if (unconfigured.length > 0) {
            this._statusBarItem.text = '$(copilot-warning) Completions';
            this._statusBarItem.tooltip = `Configure ${unconfigured.join(' and ')} to enable completion requests`;
            return;
        }
        const requestIssue = this._requestStatuses()[0];
        if (requestIssue) {
            this._statusBarItem.text = '$(copilot-warning) Completions';
            this._statusBarItem.tooltip = `${requestIssue.component === 'ghost' ? 'Inline completion' : 'Next edit'}: ${requestIssue.message}\nClick for actions.`;
            return;
        }
        const nextEditAction = nesOn && document ? getPendingNextEditAction(document) : undefined;
        if (nextEditAction) {
            this._statusBarItem.text = '$(copilot) Next Edit';
            this._statusBarItem.tooltip = `${nextEditAction.tooltip ?? nextEditAction.title}\nTab accepts when no Ghost or IntelliSense suggestion is visible. Click for actions.`;
            return;
        }
        const active = [ghostOn && 'G', nesOn && 'N', ncpOn && 'C'].filter(Boolean).join('/');
        if (active) {
            this._statusBarItem.text = '$(copilot) Completions';
            this._statusBarItem.tooltip = [
                unified ? ' ✅ Inline Suggestion via NES Unified Model '
                    : ` ${ghostOn ? '✅' : '❌'} Ghost Inline Suggestion `,
                ` ${nesOn ? '✅' : '❌'} Next Edit Suggestion `,
                ` ${ncpOn ? '✅' : '❌'} Next Cursor Prediction `,
            ].join('\n');
        } else {
            this._statusBarItem.text = '$(copilot-blocked) Completions';
            this._statusBarItem.tooltip = 'Localalot disabled';
        }
    }

    private async _showQuickPick(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        const languageEnabled = editor ? this._isLanguageEnabled(editor.document) : true;
        const editorInlineOn = editor ? this._isEditorInlineSuggestEnabled(editor.document) : true;
        const language = editor?.document.languageId ?? 'current file';
        const enabledConfig = editor
            ? getLocalConfiguration('localalot', editor.document.uri)
                .get<Record<string, boolean> | boolean>('enable', { '*': true })
            : { '*': true };
        const hasLanguageOverride = typeof enabledConfig !== 'boolean'
            && Object.prototype.hasOwnProperty.call(enabledConfig, language);
        const fileUnavailable = !!editor && isUnavailableForInlineCompletion(editor.document);
        const sourceEditor = !!editor && isSourceDocumentUri(editor.document.uri);
        const nextEditEnabled = this._isNextEditEnabled(editor?.document);
        const unified = this._nesConfig.enabled && (this._nesHandlesCompletions?.() ?? false);
        const suggestionsEnabled = languageEnabled && editorInlineOn && !fileUnavailable
            && (this._ghostConfig.enabled || nextEditEnabled || unified);
        const needsSetup = (this._ghostConfig.enabled && !unified && this._ghostConfig.endpointConfigured === false)
            || (nextEditEnabled && this._nesConfig.endpointConfigured === false);
        const requestIssue = this._requestStatuses()[0];
        const statusText = !editorInlineOn || !languageEnabled || fileUnavailable || !suggestionsEnabled
            ? 'Disabled'
            : needsSetup ? 'Setup required' : requestIssue ? 'Request failed' : 'Ready';
        const status: vscode.QuickPickItem = {
            label: `${this._statusBarItem.text.split(' ')[0]} Status: ${statusText}`,
            description: requestIssue ? (requestIssue.component === 'ghost' ? 'Inline completion' : 'Next edit') : 'Open Logs',
            detail: requestIssue?.message,
        };
        const separator = (): vscode.QuickPickItem => ({ label: '', kind: vscode.QuickPickItemKind.Separator });
        const toggleLanguage: vscode.QuickPickItem = {
            label: suggestionsEnabled ? '$(circle-slash) Disable Inline Suggestions' : '$(check) Enable Inline Suggestions',
            description: editor ? (hasLanguageOverride ? `For ${language}` : 'For languages without overrides') : 'No active editor',
        };
        const unavailableFile: vscode.QuickPickItem = {
            label: sourceEditor
                ? '$(settings-gear) Review Excluded Files'
                : '$(circle-slash) Inline Suggestions Unavailable Here',
            description: sourceEditor
                ? 'Open Completion Settings'
                : 'This editor does not support inline suggestions',
        };
        const toggleGhost: vscode.QuickPickItem = {
            label: this._ghostConfig.enabled ? '$(circle-slash) Disable GHOST' : '$(check) Enable GHOST',
            description: unified ? 'Separate Ghost provider is paused by the unified NES model' : undefined,
        };
        const toggleNes: vscode.QuickPickItem = {
            label: this._nesConfig.enabled ? '$(circle-slash) Disable NES' : '$(check) Enable NES',
        };
        const toggleNesLanguage: vscode.QuickPickItem = {
            label: nextEditEnabled ? `$(circle-slash) Disable Next Edits for ${language}`
                : `$(check) Enable Next Edits for ${language}`,
            description: 'Current language',
        };
        const toggleNcp: vscode.QuickPickItem = {
            label: this._isNextCursorPredictionEnabled(editor?.document) ? '$(circle-slash) Disable Next Cursor Prediction' : '$(check) Enable Next Cursor Prediction',
            description: this._nesConfig.enabled ? undefined : 'Enable NES first',
        };
        const changeModel: vscode.QuickPickItem = {
            label: '$(symbol-color) Change Completion Models...',
            description: `Inline: ${this._ghostConfig.model} · Next edit: ${this._nesConfig.model}`,
        };
        const eagerness: vscode.QuickPickItem = {
            label: '$(dashboard) Next Edit Eagerness...',
            description: getLocalConfiguration('localalot.nextEditSuggestions').get<string>('eagerness', 'auto'),
        };
        const configureEndpoints: vscode.QuickPickItem = {
            label: '$(settings-gear) Configure Completion Endpoints...',
            description: 'Set the API base URL for enabled completion models',
        };
        const clearCache: vscode.QuickPickItem = { label: '$(clear-all) Clear Completion Cache' };
        const trigger: vscode.QuickPickItem = { label: '$(play) Trigger Inline Completion' };
        const nextEditAction = editor ? getPendingNextEditAction(editor.document) : undefined;
        const applyNextEdit: vscode.QuickPickItem = {
            label: '$(edit) Apply Suggested Next Edit',
            description: nextEditAction ? `Tab · ${nextEditAction.title.replace(/^Localalot: /, '')}` : undefined,
        };
        const keyboard: vscode.QuickPickItem = { label: '$(keyboard) Edit Keyboard Shortcuts...' };
        const settings: vscode.QuickPickItem = { label: '$(settings-gear) Open Completion Settings' };
        const logs: vscode.QuickPickItem = { label: '$(output) Open Logs...' };
        const picks = await vscode.window.showQuickPick(
            [status, separator(), ...(editor ? [fileUnavailable ? unavailableFile : toggleLanguage] : []),
                toggleGhost, toggleNes,
                ...(editor && this._nesConfig.enabled ? [toggleNesLanguage] : []),
                ...(this._nesConfig.enabled ? [toggleNcp] : []), separator(),
                ...(needsSetup ? [configureEndpoints] : []), changeModel,
                ...(this._nesConfig.enabled ? [eagerness] : []), trigger,
                ...(nextEditAction ? [applyNextEdit] : []), clearCache, separator(), keyboard, settings, logs],
            { placeHolder: 'Select an option', title: 'Configure Inline Suggestions' },
        );
        if (!picks) return;
        if (picks === unavailableFile) {
            if (sourceEditor) {
                await vscode.commands.executeCommand('localalot.openSettings');
            }
        } else if (picks === toggleLanguage) {
            await this._setInlineSuggestionsEnabled(!suggestionsEnabled);
        } else if (picks === toggleGhost) this._ghostConfig.enabled = !this._ghostConfig.enabled;
        else if (picks === toggleNes) this._nesConfig.enabled = !this._nesConfig.enabled;
        else if (picks === toggleNesLanguage) await this._setNextEditEnabledForLanguage(!nextEditEnabled);
        else if (picks === toggleNcp && this._nesConfig.enabled) {
            await this._setNextCursorPredictionEnabledForLanguage(!this._isNextCursorPredictionEnabled(editor?.document));
        }
        else if (picks === changeModel) await this._showModelPicker();
        else if (picks === eagerness) await this._showEagernessPicker();
        else if (picks === configureEndpoints) {
            await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:young-triangle.localalot baseUrl');
        }
        else if (picks === clearCache) {
            this._clearCaches();
        } else if (picks === trigger) {
            await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
        } else if (picks === applyNextEdit && nextEditAction) {
            await vscode.commands.executeCommand(nextEditAction.command, ...(nextEditAction.arguments ?? []));
        } else if (picks === settings) {
            await vscode.commands.executeCommand('localalot.openSettings');
        } else if (picks === keyboard) {
            await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'localalot');
        } else if (picks === logs || picks === status) {
            this._log.show();
        }
        this._updateStatusBar();
    }

    private async _showModelPicker(): Promise<void> {
        const inline: vscode.QuickPickItem = {
            label: '$(sparkle) Inline Completions',
            description: this._ghostConfig.model,
        };
        const nextEdit: vscode.QuickPickItem = {
            label: '$(edit) Next Edit and Cursor Prediction',
            description: this._nesConfig.model,
        };
        const selected = await vscode.window.showQuickPick([inline, nextEdit], {
            title: 'Change Completion Models',
            placeHolder: 'Choose which model to change',
        });
        if (!selected) return;
        await this._editModel(selected === inline ? 'ghost' : 'nes');
    }

    private async _showEagernessPicker(): Promise<void> {
        const config = getLocalConfiguration('localalot.nextEditSuggestions');
        const current = config.get<string>('eagerness', 'auto');
        const choices = [
            { id: 'auto', label: 'Automatic' },
            { id: 'low', label: 'Low' },
            { id: 'medium', label: 'Medium' },
            { id: 'high', label: 'High' },
        ];
        const selected = await vscode.window.showQuickPick(choices.map(choice => ({
            label: `${current === choice.id ? '$(check) ' : ''}${choice.label}`,
            description: choice.id,
        })), { title: 'Next Edit Eagerness', placeHolder: 'Choose how eagerly to suggest edits' });
        if (!selected || selected.description === current) return;
        const target = modelSettingScope(config.inspect<string>('eagerness'));
        await config.update('eagerness', selected.description, target);
        this._nesConfig.setEagernessSelection?.(selected.description!);
    }

    private async _editModel(kind: 'ghost' | 'nes'): Promise<void> {
        const currentModel = kind === 'ghost' ? this._ghostConfig.model : this._nesConfig.model;
        const title = kind === 'ghost' ? 'Inline Completion Model' : 'Next Edit Model';
        const baseUrl = kind === 'ghost' ? this._ghostConfig.baseUrl : this._nesConfig.baseUrl;
        const apiKey = kind === 'ghost' ? this._ghostConfig.apiKey : this._nesConfig.apiKey;
        const modelIds = await listLocalModelIds(baseUrl, apiKey);
        let newModel: string | undefined;
        if (modelIds.length > 0) {
            const custom: vscode.QuickPickItem = { label: '$(edit) Enter another model ID...' };
            const items = modelIds.map(id => ({ label: id, description: id === currentModel ? 'Current' : undefined }));
            if (!modelIds.includes(currentModel)) items.unshift({ label: currentModel, description: 'Current' });
            const selected = await vscode.window.showQuickPick([...items, custom], {
                title, placeHolder: 'Select a model from the local endpoint',
            });
            if (!selected) return;
            if (selected !== custom) newModel = selected.label;
        }
        newModel ??= await vscode.window.showInputBox({
            title, prompt: 'Enter the model ID accepted by the configured endpoint',
            value: currentModel,
            validateInput: value => value.trim() ? undefined : 'Enter a model ID',
        });
        const normalized = newModel?.trim();
        if (!normalized || normalized === currentModel) return;
        try {
            await this._updateModel(kind, normalized);
        } catch (error) {
            this._log.error(`Failed to change completion model: ${error}`);
            await vscode.window.showErrorMessage('Could not change the completion model. Check your workspace settings.');
        }
    }

    private async _updateModel(kind: 'ghost' | 'nes', model: string): Promise<void> {
        const config = getLocalConfiguration(kind === 'ghost' ? 'localalot.ghost' : 'localalot.nes');
        const target = modelSettingScope(config.inspect<string>('model'));
        await config.update('model', model, target);
    }

    private _clearCaches(): void {
        this._invalidateGhost?.();
        this._invalidateNes?.();
        this._log.info('Completion caches and pending requests cleared');
    }

    private _isLanguageEnabled(document: vscode.TextDocument): boolean {
        const configured = getLocalConfiguration('localalot', document.uri)
            .get<Record<string, boolean> | boolean>('enable', { '*': true });
        return typeof configured === 'boolean'
            ? configured
            : (configured[document.languageId] ?? configured['*'] ?? true);
    }

    private _isEditorInlineSuggestEnabled(document: vscode.TextDocument): boolean {
        return vscode.workspace.getConfiguration('editor.inlineSuggest', { uri: document.uri, languageId: document.languageId }).get<boolean>('enabled', true) !== false;
    }

    private async _enableEditorInlineSuggestions(): Promise<void> {
        const document = vscode.window.activeTextEditor?.document;
        if (!document) return;
        const config = vscode.workspace.getConfiguration('editor.inlineSuggest', { uri: document.uri, languageId: document.languageId });
        const inspected = config.inspect<boolean>('enabled');
        for (const override of disabledInlineSuggestOverrides(inspected)) {
            if (this._isEditorInlineSuggestEnabled(document)) break;
            await config.update('enabled', true, override.target, override.languageOverride);
        }
        if (!this._isEditorInlineSuggestEnabled(document)) {
            await config.update('enabled', true, vscode.ConfigurationTarget.Global);
        }
    }

    private async _toggleLanguage(): Promise<void> {
        const document = vscode.window.activeTextEditor?.document;
        if (!document) return;
        await this._setLanguageEnabled(!this._isLanguageEnabled(document));
    }

    private _isNextEditEnabled(document?: vscode.TextDocument): boolean {
        if (!this._nesConfig.enabled) return false;
        if (!document) return true;
        return getLocalConfiguration('localalot.nextEditSuggestions', {
            uri: document.uri, languageId: document.languageId,
        }).get<boolean>('enabled', true);
    }

    private _isNextCursorPredictionEnabled(document?: vscode.TextDocument): boolean {
        if (!this._nesConfig.enabled) return false;
        if (!document) return this._nesConfig.nextCursorPredictionEnabled;
        const config = getLocalConfiguration('localalot.nextEditSuggestions', {
            uri: document.uri, languageId: document.languageId,
        });
        const inspected = config.inspect<boolean>('extendedRange');
        const hasLanguageOverride = inspected?.workspaceFolderLanguageValue !== undefined
            || inspected?.workspaceLanguageValue !== undefined
            || inspected?.globalLanguageValue !== undefined;
        return hasLanguageOverride ? config.get<boolean>('extendedRange', true) : this._nesConfig.nextCursorPredictionEnabled;
    }

    private async _setNextEditEnabledForLanguage(enabled: boolean): Promise<void> {
        const document = vscode.window.activeTextEditor?.document;
        if (!document) return;
        const config = getLocalConfiguration('localalot.nextEditSuggestions', {
            uri: document.uri, languageId: document.languageId,
        });
        const inspected = config.inspect<boolean>('enabled');
        const target = inspected?.workspaceFolderLanguageValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
            : inspected?.workspaceLanguageValue !== undefined ? vscode.ConfigurationTarget.Workspace
            : inspected?.globalLanguageValue !== undefined ? vscode.ConfigurationTarget.Global
            : vscode.workspace.getWorkspaceFolder(document.uri) ? vscode.ConfigurationTarget.WorkspaceFolder
            : vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
        await config.update('enabled', enabled, target, true);
    }

    private async _setNextCursorPredictionEnabledForLanguage(enabled: boolean): Promise<void> {
        const document = vscode.window.activeTextEditor?.document;
        if (!document) {
            this._nesConfig.nextCursorPredictionEnabled = enabled;
            return;
        }
        const config = getLocalConfiguration('localalot.nextEditSuggestions', {
            uri: document.uri, languageId: document.languageId,
        });
        const inspected = config.inspect<boolean>('extendedRange');
        const hasLanguageOverride = inspected?.workspaceFolderLanguageValue !== undefined
            || inspected?.workspaceLanguageValue !== undefined
            || inspected?.globalLanguageValue !== undefined;
        if (!hasLanguageOverride) {
            this._nesConfig.nextCursorPredictionEnabled = enabled;
            return;
        }
        const target = inspected?.workspaceFolderLanguageValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
            : inspected?.workspaceLanguageValue !== undefined ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
        await config.update('extendedRange', enabled, target, true);
    }

    private async _setInlineSuggestionsEnabled(enabled: boolean): Promise<void> {
        if (!vscode.window.activeTextEditor) return;
        if (enabled) await this._enableEditorInlineSuggestions();
        await this._setMenuInlineSuggestionsEnabled(enabled);
        if (enabled && !this._ghostConfig.enabled && !this._nesConfig.enabled) this._ghostConfig.enabled = true;
        this._updateStatusBar();
    }

    private async _setMenuInlineSuggestionsEnabled(enabled: boolean): Promise<void> {
        const document = vscode.window.activeTextEditor?.document;
        if (!document) return;
        const config = getLocalConfiguration('localalot', document.uri);
        const current = config.get<Record<string, boolean> | boolean>('enable', { '*': true });
        await this._writeEnabledConfig(enabledConfigAfterMenuToggle(current, document.languageId, enabled), config);
    }

    private async _setLanguageEnabled(enabled: boolean): Promise<void> {
        const document = vscode.window.activeTextEditor?.document;
        if (!document) return;
        const config = getLocalConfiguration('localalot', document.uri);
        const current = config.get<Record<string, boolean> | boolean>('enable', { '*': true });
        const currentObject: Record<string, boolean> = typeof current === 'boolean' ? { '*': current } : { ...current };
        currentObject[document.languageId] = enabled;
        await this._writeEnabledConfig(currentObject, config);
    }

    private async _writeEnabledConfig(currentObject: Record<string, boolean>, config: vscode.WorkspaceConfiguration): Promise<void> {
        const document = vscode.window.activeTextEditor?.document;
        if (!document) return;
        const inspected = config.inspect<Record<string, boolean> | boolean>('enable');
        const target = inspected?.workspaceFolderValue !== undefined
            ? vscode.ConfigurationTarget.WorkspaceFolder
            : inspected?.workspaceValue !== undefined
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;
        await config.update('enable', currentObject, target);
        const effective = currentObject[document.languageId] ?? currentObject['*'] ?? true;
        this._log.info(`Inline suggestions for ${document.languageId}: ${effective ? 'enabled' : 'disabled'}`);
    }
}
