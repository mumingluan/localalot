import * as vscode from 'vscode';
import { NextEditResult } from './types';

/** Turns an editor quick fix into a single, previewable inline edit. */
export function codeActionToNextEdit(
    action: vscode.CodeAction,
    document: vscode.TextDocument,
): NextEditResult | undefined {
    const edit = action.edit;
    if (!edit) return undefined;
    const entries = edit.entries();
    if (entries.length !== 1 || entries[0][0].toString() !== document.uri.toString()) return undefined;
    const replacements = entries[0][1]
        .filter(replacement => document.getText(replacement.range) !== replacement.newText)
        .sort((a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start));
    if (replacements.length === 0) return undefined;
    const start = replacements.reduce((value, replacement) => Math.min(value, document.offsetAt(replacement.range.start)), Number.MAX_SAFE_INTEGER);
    const end = replacements.reduce((value, replacement) => Math.max(value, document.offsetAt(replacement.range.end)), 0);
    const combinedRange = new vscode.Range(document.positionAt(start), document.positionAt(end));
    let combinedText = document.getText(combinedRange);
    for (const replacement of replacements) {
        const localStart = document.offsetAt(replacement.range.start) - start;
        const localEnd = document.offsetAt(replacement.range.end) - start;
        combinedText = combinedText.slice(0, localStart) + replacement.newText + combinedText.slice(localEnd);
    }
    return {
        range: combinedRange,
        edit: combinedText,
        fullEditText: combinedText,
        documentBeforeEdits: document.getText(combinedRange),
        edits: replacements.map(replacement => ({ replaceRange: replacement.range, newText: replacement.newText })),
        displayLocation: { range: combinedRange, label: action.title },
        action: action.command,
    };
}

/** Only request nearby error fixes; code actions are read without executing their commands. */
export async function resolveDiagnosticEdit(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
): Promise<NextEditResult | undefined> {
    const candidates = vscode.languages.getDiagnostics(document.uri)
        .filter(d => (d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning)
            && Math.abs(d.range.start.line - position.line) <= 20)
        .sort((a, b) => Math.abs(a.range.start.line - position.line) - Math.abs(b.range.start.line - position.line))
        .slice(0, 2);
    if (candidates.length === 0) return undefined;

    const version = document.version;
    for (const diagnostic of candidates) {
        if (token.isCancellationRequested) return undefined;
        let actions: Array<vscode.CodeAction | vscode.Command> | undefined;
        try {
            actions = await vscode.commands.executeCommand<Array<vscode.CodeAction | vscode.Command>>(
                'vscode.executeCodeActionProvider', document.uri, diagnostic.range,
                vscode.CodeActionKind.QuickFix.value, 8,
            );
        } catch {
            continue;
        }
        if (token.isCancellationRequested || document.version !== version) return undefined;
        const quickFixes = (actions ?? [])
            // Commands executed through the extension host can be plain objects
            // rather than `instanceof vscode.CodeAction`; use the structural
            // shape so diagnostics fixes are still previewable in that case.
            .filter((action): action is vscode.CodeAction => !!action && 'edit' in action && typeof (action as { title?: unknown }).title === 'string')
            .sort((a, b) => Number(!!b.isPreferred) - Number(!!a.isPreferred));
        for (const action of quickFixes) {
            const result = codeActionToNextEdit(action, document);
            if (result) return result;
        }
    }
    return undefined;
}
