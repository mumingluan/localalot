import * as vscode from 'vscode';
import type { GhostVirtualCompletion } from './inlineCompletion';

export interface VirtualGhostContext {
    prefix: string;
    suffix: string;
    document: vscode.TextDocument;
    position: vscode.Position;
}

/** A read-only view of the document after the displayed inline edit is applied. */
export function buildVirtualGhostContext(
    document: vscode.TextDocument,
    completion: GhostVirtualCompletion,
): VirtualGhostContext | undefined {
    const source = document.getText();
    const start = document.offsetAt(completion.range.start);
    const end = document.offsetAt(completion.range.end);
    if (start < 0 || end < start || end > source.length) return undefined;

    const text = source.slice(0, start) + completion.text + source.slice(end);
    const caret = start + completion.text.length;
    const lineStarts = [0];
    const lineEnds: number[] = [];
    const breaks = /\r\n|\r|\n/g;
    let match: RegExpExecArray | null;
    while ((match = breaks.exec(text))) {
        lineEnds.push(match.index);
        lineStarts.push(breaks.lastIndex);
    }
    lineEnds.push(text.length);

    const positionAt = (offset: number): vscode.Position => {
        const bounded = Math.max(0, Math.min(offset, text.length));
        let low = 0;
        let high = lineStarts.length - 1;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (lineStarts[middle] <= bounded) low = middle;
            else high = middle - 1;
        }
        return new vscode.Position(low, Math.min(bounded, lineEnds[low]) - lineStarts[low]);
    };
    const offsetAt = (position: vscode.Position): number => {
        const line = Math.max(0, Math.min(position.line, lineStarts.length - 1));
        return Math.min(lineStarts[line] + Math.max(0, position.character), lineEnds[line]);
    };
    const lineAt = (lineOrPosition: number | vscode.Position): vscode.TextLine => {
        const line = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
        if (line < 0 || line >= lineStarts.length) throw new Error(`Invalid line: ${line}`);
        const lineText = text.slice(lineStarts[line], lineEnds[line]);
        const firstNonWhitespace = lineText.search(/\S/);
        return {
            lineNumber: line,
            text: lineText,
            range: new vscode.Range(line, 0, line, lineText.length),
            rangeIncludingLineBreak: new vscode.Range(positionAt(lineStarts[line]), positionAt(lineStarts[line + 1] ?? text.length)),
            firstNonWhitespaceCharacterIndex: firstNonWhitespace < 0 ? lineText.length : firstNonWhitespace,
            isEmptyOrWhitespace: firstNonWhitespace < 0,
        };
    };
    const virtualDocument: vscode.TextDocument = {
        uri: document.uri,
        fileName: document.fileName,
        isUntitled: document.isUntitled,
        languageId: document.languageId,
        version: document.version,
        isDirty: document.isDirty,
        isClosed: document.isClosed,
        eol: document.eol,
        encoding: document.encoding,
        lineCount: lineStarts.length,
        getText: (range?: vscode.Range) => range
            ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text,
        lineAt,
        offsetAt,
        positionAt,
        validatePosition: (position: vscode.Position) => positionAt(offsetAt(position)),
        validateRange: (range: vscode.Range) => new vscode.Range(
            positionAt(offsetAt(range.start)), positionAt(offsetAt(range.end)),
        ),
        getWordRangeAtPosition: (position: vscode.Position, regularExpression?: RegExp) => {
            const line = lineAt(position.line).text;
            const wordPattern = regularExpression ?? /[\p{L}\p{N}_]+/gu;
            const flags = wordPattern.flags.includes('g') ? wordPattern.flags : `${wordPattern.flags}g`;
            const matcher = new RegExp(wordPattern.source, flags);
            let word: RegExpExecArray | null;
            while ((word = matcher.exec(line))) {
                if (word.index <= position.character && position.character <= word.index + word[0].length) {
                    return new vscode.Range(position.line, word.index, position.line, word.index + word[0].length);
                }
                if (!word[0]) matcher.lastIndex++;
            }
            return undefined;
        },
        save: () => document.save(),
    };

    return {
        prefix: text.slice(0, caret).replace(/\r\n|\r/g, '\n'),
        suffix: text.slice(caret).replace(/\r\n|\r/g, '\n'),
        document: virtualDocument,
        position: positionAt(caret),
    };
}

/** Apply the selected IntelliSense item before evaluating the ghost request. */
export function buildSelectedCompletionContext(
    document: vscode.TextDocument,
    position: vscode.Position,
    selected: vscode.SelectedCompletionInfo,
): VirtualGhostContext | undefined {
    if (!selected.text || selected.text.includes(')') || !selected.range.contains(position)) return undefined;
    return buildVirtualGhostContext(document, { range: selected.range, text: selected.text });
}
