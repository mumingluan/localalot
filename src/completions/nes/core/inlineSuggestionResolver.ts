import * as vscode from 'vscode';

export interface InlineSuggestionEdit {
    readonly range: vscode.Range;
    readonly newText: string;
}

/**
 * Determines whether an edit can be displayed as an inline (ghost text) suggestion
 * at the cursor position. If so, returns the possibly-adjusted range and text.
 */
export class InlineSuggestionResolver {

    resolve(
        cursorPos: vscode.Position,
        doc: vscode.TextDocument,
        range: vscode.Range,
        newText: string,
    ): InlineSuggestionEdit | undefined {
        // The ordinary same-line path must run first.  In particular, an empty
        // insertion range at the cursor must not absorb the existing suffix of
        // the line while rebasing.
        if (range.start.line === range.end.line && range.start.line === cursorPos.line) {
            const sameLineEdit = this._validateSameLineGhostText(cursorPos, doc, range, newText);
            if (sameLineEdit) return sameLineEdit;
        }

        // Match VS Code's advanced NES path: re-express an edit that touches
        // surrounding lines as a replacement from the cursor to this line's end.
        // This is what lets a multi-line next edit render as normal ghost text.
        const cursorEdit = this._tryRebaseAsCursorEdit(cursorPos, doc, range, newText);
        if (cursorEdit) {
            return cursorEdit;
        }

        // Preserve the fallback for an empty insertion at the start of the
        // next line. With advanced rebasing enabled this is usually subsumed
        // above, but it remains necessary when the line cannot be represented
        // as an equivalent cursor edit.
        const nextLineInsertion = this._tryAdjustNextLineInsertion(cursorPos, doc, range, newText);
        if (nextLineInsertion) {
            return nextLineInsertion;
        }

        return undefined;
    }

    private _tryRebaseAsCursorEdit(
        cursorPos: vscode.Position,
        doc: vscode.TextDocument,
        range: vscode.Range,
        newText: string,
    ): InlineSuggestionEdit | undefined {
        const cursorOffset = doc.offsetAt(cursorPos);
        const lineEnd = doc.lineAt(cursorPos.line).range.end;
        const lineEndOffset = doc.offsetAt(lineEnd);
        const rangeStartOffset = doc.offsetAt(range.start);
        const rangeEndOffset = doc.offsetAt(range.end);
        const affectedStart = doc.positionAt(Math.min(cursorOffset, rangeStartOffset));
        const affectedEnd = doc.positionAt(Math.max(lineEndOffset, rangeEndOffset));

        const editedText = doc.getText(new vscode.Range(affectedStart, range.start))
            + newText
            + doc.getText(new vscode.Range(range.end, affectedEnd));
        const unchangedPrefix = doc.getText(new vscode.Range(affectedStart, cursorPos));
        const unchangedSuffix = doc.getText(new vscode.Range(lineEnd, affectedEnd));
        const cursorEditTextEnd = editedText.length - unchangedSuffix.length;
        if (
            cursorEditTextEnd < unchangedPrefix.length
            || !editedText.startsWith(unchangedPrefix)
            || !editedText.endsWith(unchangedSuffix)
        ) {
            return undefined;
        }

        const cursorEdit = {
            range: new vscode.Range(cursorPos, lineEnd),
            newText: editedText.substring(unchangedPrefix.length, cursorEditTextEnd),
        };
        return this._validateSameLineGhostText(cursorPos, doc, cursorEdit.range, cursorEdit.newText);
    }

    private _tryAdjustNextLineInsertion(
        cursorPos: vscode.Position,
        doc: vscode.TextDocument,
        range: vscode.Range,
        newText: string,
    ): InlineSuggestionEdit | undefined {
        if (!range.isEmpty) return undefined;
        if (cursorPos.line + 1 !== range.start.line || range.start.character !== 0) return undefined;
        if (doc.lineAt(cursorPos.line).text.length !== cursorPos.character) return undefined;

        const lineBreak = doc.getText(new vscode.Range(cursorPos, range.start));
        // Pulling an insertion from the next line back to the cursor is
        // equivalent only when the inserted text ends with the document's
        // actual line break. In particular, LF is not enough for CRLF files.
        if (!newText.endsWith(lineBreak)) return undefined;
        const trimmedNewText = newText.substring(0, newText.length - lineBreak.length);
        return { range: new vscode.Range(cursorPos, cursorPos), newText: lineBreak + trimmedNewText };
    }

    private _validateSameLineGhostText(
        cursorPos: vscode.Position,
        doc: vscode.TextDocument,
        range: vscode.Range,
        newText: string,
    ): InlineSuggestionEdit | undefined {
        const replacedText = doc.getText(range);
        const cursorOffsetInReplacedText = cursorPos.character - range.start.character;
        if (cursorOffsetInReplacedText < 0) return undefined;
        if (
            replacedText.substring(0, cursorOffsetInReplacedText) !==
            newText.substring(0, cursorOffsetInReplacedText)
        ) {
            return undefined;
        }
        if (!InlineSuggestionResolver.isSubword(replacedText, newText)) return undefined;
        return { range, newText };
    }

    static isSubword(a: string, b: string): boolean {
        for (let aIdx = 0, bIdx = 0; aIdx < a.length; bIdx++) {
            if (bIdx >= b.length) return false;
            if (a[aIdx] === b[bIdx]) aIdx++;
        }
        return true;
    }
}
