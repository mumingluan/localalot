import * as vscode from 'vscode';

/** Build the same whole-line edit as native Ghost Text for a selected suggest item. */
export function selectedCompletionPreview(
    selected: vscode.SelectedCompletionInfo,
    position: vscode.Position,
    linePrefixBeforeSelection: string,
    continuation: string,
    suffixCoverage = 0,
): { text: string; range: vscode.Range } | undefined {
    if (!selected.range.contains(position) || selected.range.start.line !== position.line
        || selected.range.end.line !== position.line) return undefined;
    const range = new vscode.Range(
        new vscode.Position(position.line, 0),
        selected.range.end.translate(0, Math.max(0, suffixCoverage)),
    );
    return { text: linePrefixBeforeSelection + selected.text + continuation, range };
}
