import * as vscode from 'vscode';
import { ImportChanges } from '../vendor/copilot/src/platform/inlineEdits/common/dataTypes/importFilteringOptions';
import { LINT_OPTIONS_VALIDATOR } from '../vendor/copilot/src/platform/inlineEdits/common/dataTypes/xtabPromptOptions';

let nextCursorEnabled: (() => boolean) | undefined;

/** Supplies Localalot's workspace-state toggle to the original cursor predictor. */
export function configureLocalNesSettings(readNextCursorEnabled?: () => boolean): () => void {
    const previous = nextCursorEnabled;
    nextCursorEnabled = readNextCursorEnabled;
    return () => { nextCursorEnabled = previous; };
}

export function localNextCursorPredictionEnabled(): boolean {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const config = vscode.workspace.getConfiguration('localalot.nextEditSuggestions', {
            uri: editor.document.uri, languageId: editor.document.languageId,
        });
        const inspected = config.inspect<boolean>('extendedRange');
        const hasLanguageOverride = inspected?.workspaceFolderLanguageValue !== undefined
            || inspected?.workspaceLanguageValue !== undefined
            || inspected?.globalLanguageValue !== undefined;
        if (hasLanguageOverride) return config.get<boolean>('extendedRange', true);
    }
    return nextCursorEnabled?.()
        ?? vscode.workspace.getConfiguration('localalot.nes').get<boolean>('nextCursorPredictionEnabled', true);
}

export function localNextCursorPredictionModel(): string {
    const config = vscode.workspace.getConfiguration('localalot.nes');
    return config.get<string>('nextCursorPrediction.model', '').trim()
        || config.get<string>('model', 'gpt-4o');
}

export function localNesSemanticContextEnabled(): boolean {
    return vscode.workspace.getConfiguration('localalot.nes').get<boolean>('semanticContextEnabled', true);
}

export function localNesNeighborFilesEnabled(): boolean {
    return vscode.workspace.getConfiguration('localalot.nes').get<boolean>('neighborFilesEnabled', true);
}

export function localNesDiagnosticFixesEnabled(): boolean {
    return vscode.workspace.getConfiguration('localalot.nes').get<boolean>('diagnosticFixesEnabled', true);
}

/** The original timeout provider supplies nearby diagnostics when lint prompt context is unused. */
export function localNesDiagnosticContextEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('localalot.nes');
    const lintOptions = config.get<unknown>('lintOptions', {});
    const usesLintPrompt = lintOptions !== null && typeof lintOptions === 'object'
        && Object.keys(lintOptions).length > 0
        && !LINT_OPTIONS_VALIDATOR.validate(lintOptions).error;
    return config.get<boolean>('diagnosticContextEnabled', true)
        && !usesLintPrompt;
}

export function localNesAllowWhitespaceOnlyChanges(uri: string): boolean {
    const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri);
    const scope = document ?? vscode.Uri.parse(uri);
    return vscode.workspace.getConfiguration('localalot.nes', scope)
        .get<boolean>('allowWhitespaceOnlyChanges', true);
}

export function localNesImportChanges(uri: string): ImportChanges {
    const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri);
    const scope = document ?? vscode.Uri.parse(uri);
    return vscode.workspace.getConfiguration('localalot.nes', scope)
        .get<boolean>('allowImportChanges', true) ? ImportChanges.All : ImportChanges.None;
}

/** The upstream context deadline can reach zero after its edit debounce has elapsed. */
export function localNesContextBudgetMs(upstreamRemainingMs: number): number {
    return Math.max(upstreamRemainingMs, 750);
}
