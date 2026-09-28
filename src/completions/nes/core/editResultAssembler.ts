import * as vscode from 'vscode';
import { NextEditResult } from '../types';
import { CachedEdit } from '../nextEditCache';
import { ResponseDiffer } from '../response/responseDiffer';
import { LineReplacement } from '../response/lineReplacement';
import { allowImportChanges, allowWhitespaceOnlyChanges, filterLineEdits } from '../response/lineEditFilters';
import { EditWindowResolver, LineSource } from './editWindowResolver';
import { TrimCompletionSuffixOverlap } from '../../../common/suffixOverlapTrim';
import { ILogService } from '../../shared/log/logService';
import { detectLanguage } from '../../shared/languageDetection';

/** Maximum suffix lines to read for optional fuzzy overlap detection. */
const MAX_SUFFIX_LINES_FOR_OVERLAP = 100;

/** Read a slice of lines from a LineSource into an array. */
function readLineSlice(source: LineSource, start: number, endExclusive: number): string[] {
    const lines: string[] = [];
    for (let i = start; i < endExclusive; i++) {
        lines.push(source.lineText(i));
    }
    return lines;
}


export class EditResultAssembler {
    private readonly _responseDiffer = new ResponseDiffer();

    constructor(
        private readonly _editWindowResolver: EditWindowResolver,
    ) {}

    /**
     * Phase 3-6: ResponseProcessor.diff() → post-process → suffix overlap → build result.
     *
     * @param responseLines Clean response lines (after boundary marker parsing + cursor tag stripping)
     * @param document      The VS Code text document
     * @param position      Current cursor position
     * @param cacheEntry    Optional cache entry for the result reference
     * @param overlapThreshold 1 uses native exact duplicate detection; lower values use fuzzy suffix detection
     * @param overlapType      Fuzzy suffix detection type: "low" or "high"
     * @param logger
     * @param options.skipDuplicateAdditions  Preserve a progressively revealed cursor-line edit.
     */
    assemble(
        responseLines: string[],
        document: vscode.TextDocument,
        position: vscode.Position,
        cacheEntry?: CachedEdit,
        overlapThreshold: number = 1,
        overlapType: 'low' | 'high' = 'high',
        logger?: ILogService,
        editWindowRange?: { start: number; endExclusive: number },
        options?: { skipDuplicateAdditions?: boolean },
    ): NextEditResult {
        // Use lightweight LineSource — avoids O(N) document.getText() for large files
        const docSource: LineSource = {
            lineCount: document.lineCount,
            lineText: (i: number) => document.lineAt(i).text,
        };
        const ewRange = editWindowRange ?? this._editWindowResolver.resolve(docSource, position.line);
        const originalLines = readLineSlice(docSource, ewRange.start, ewRange.endExclusive);

        // Phase 3: ResponseProcessor.diff() equivalent — line-level diff
        const lineEdits = filterLineEdits(
            this._responseDiffer.compute(originalLines, responseLines),
            originalLines,
            detectLanguage(document).languageId,
            allowWhitespaceOnlyChanges(document),
            allowImportChanges(document),
        );

        if (lineEdits.length === 0) {
            // No changes — this shouldn't normally happen (filter chain catches it)
            return this._emptyEditResult(document, position, ewRange, originalLines.join('\n'), cacheEntry);
        }

        // Phase 4: Post-process — convert every diff to document-absolute line
        // numbers. VS Code's inline-completion extension-host transport does
        // not serialize additionalTextEdits, so disjoint changes must become
        // one equivalent replacement spanning their unchanged context.
        const edits = lineEdits.map(edit => new LineReplacement({
            startLineNumber: ewRange.start + edit.lineRange.startLineNumber - 1,
            endLineNumberExclusive: ewRange.start + edit.lineRange.endLineNumberExclusive - 1,
        }, edit.newLines));

        // Phase 6: TrimNESResponseSuffixOverlap — trim suffix overlap
        const documentBeforeEdits = originalLines.join('\n');
        const retainedEdits = options?.skipDuplicateAdditions
            ? edits
            : trimLineEditSuffixOverlaps(edits, docSource, overlapThreshold, overlapType, logger);
        if (retainedEdits.length === 0) {
            return this._emptyEditResult(document, position, ewRange, documentBeforeEdits, cacheEntry);
        }
        const firstEdit = retainedEdits[0];

        // Compute precise character edits before combining them for transport.
        const textEdits = retainedEdits
            .map(candidate => {
                const candidateRange = lineReplacementToRange(candidate, document);
                return { range: candidateRange, newText: lineReplacementToText(candidate, candidateRange, document) };
            })
            .filter(candidate => !(candidate.range.isEmpty && candidate.newText === ''));
        if (textEdits.length === 0) {
            return this._emptyEditResult(document, position, ewRange, documentBeforeEdits, cacheEntry);
        }
        const { range, newText: editText } = textEdits.length === 1
            ? textEdits[0]
            : combineDisjointTextEdits(document, textEdits);

        // Cursor placement must follow the actual primary text edit. Using
        // `newLines[newLines.length - 1]` is wrong for partial replacements
        // and insertions between existing lines because the edit text carries
        // a line break that belongs to the surrounding document.
        const cursorAfterEdit = cursorAfterPrimaryEdit(
            range, editText, textEdits.length === 1 && firstEdit.isInsertion, document.lineCount);

        // const displayLabel = `L${range.start.line + 1}-L${range.end.line + 1}`;

        return {
            range,
            edit: editText,
            documentBeforeEdits,
            fullEditText: firstEdit.newLines.join('\n'),
            editWindow: { startLine: ewRange.start, endLineExclusive: ewRange.endExclusive },
            edits: textEdits.map(candidate => ({ replaceRange: candidate.range, newText: candidate.newText })),
            cursorAfterEdit,
            cacheEntry,
            isFromCursorJump: false,
        };
    }

    private _emptyEditResult(
        document: vscode.TextDocument,
        position: vscode.Position,
        _ewRange: { start: number; endExclusive: number },
        documentBeforeEdits: string,
        cacheEntry?: CachedEdit,
    ): NextEditResult {
        const emptyRange = new vscode.Range(position, position);
        return {
            range: emptyRange,
            edit: '',
            documentBeforeEdits,
            fullEditText: '',
            editWindow: { startLine: _ewRange.start, endLineExclusive: _ewRange.endExclusive },
            edits: [],
            cursorAfterEdit: position,
            displayLocation: { range: emptyRange, label: '' },
            cacheEntry,
            isFromCursorJump: false,
        };
    }
}

/** Preserve the exact intervening document text while applying disjoint edits. */
export function combineDisjointTextEdits(
    document: vscode.TextDocument,
    edits: readonly { range: vscode.Range; newText: string }[],
): { range: vscode.Range; newText: string } {
    const ordered = [...edits].sort((left, right) =>
        document.offsetAt(left.range.start) - document.offsetAt(right.range.start));
    const range = new vscode.Range(ordered[0].range.start, ordered[ordered.length - 1].range.end);
    const startOffset = document.offsetAt(range.start);
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    let text = document.getText(range);
    for (const edit of ordered.reverse()) {
        const start = document.offsetAt(edit.range.start) - startOffset;
        const end = document.offsetAt(edit.range.end) - startOffset;
        const replacement = edit.newText.replace(/\r\n|\r|\n/g, eol);
        text = text.slice(0, start) + replacement + text.slice(end);
    }
    return { range, newText: text.replace(/\r\n|\r/g, '\n') };
}

/** Trim each disjoint patch against the original lines following its range. */
export function trimLineEditSuffixOverlaps(
    edits: readonly LineReplacement[],
    docSource: LineSource,
    overlapThreshold: number,
    overlapType: 'low' | 'high',
    logger?: ILogService,
): LineReplacement[] {
    const trimmer = overlapThreshold < 1
        ? new TrimCompletionSuffixOverlap(overlapThreshold, overlapType)
        : undefined;
    const retained: LineReplacement[] = [];
    for (const edit of edits) {
        const suffixStart = edit.lineRange.endLineNumberExclusive;
        // Exact duplicate detection must inspect as many following lines as
        // the model added. A fixed cap can miss a long copied continuation.
        const lookahead = trimmer ? MAX_SUFFIX_LINES_FOR_OVERLAP : edit.newLines.length;
        const suffixEnd = Math.min(suffixStart + lookahead, docSource.lineCount);
        const suffixLines = readLineSlice(docSource, suffixStart, suffixEnd);
        const overlapCount = trimmer?.calculateOverlap(edit.newLines, suffixLines) ?? 0;
        const trimmedLines = trimmer
            ? (overlapCount > 0 ? edit.newLines.slice(0, -overlapCount) : edit.newLines)
            : removeDuplicateAdditionsExact(edit.newLines, suffixLines);
        logger?.info(`duplicate addition lines removed: ${edit.newLines.length - trimmedLines.length}`);
        // Keep the original replacement range even when every generated line
        // overlaps the suffix: in that case the patch is a deletion.
        const trimmed = trimmedLines !== edit.newLines
            ? new LineReplacement(edit.lineRange, trimmedLines)
            : edit;
        if (trimmed.isInsertion && trimmed.newLines.length === 0) {
            continue;
        }
        retained.push(trimmed);
    }
    return retained;
}

/** Match the native patch handler's suffix, prefix, then middle duplicate rules. */
function removeDuplicateAdditionsExact(added: string[], following: string[]): string[] {
    if (added.length === 0 || following.length === 0) {
        return added;
    }
    for (let length = Math.min(added.length, following.length); length >= 1; length--) {
        if (added.slice(-length).every((line, index) => line === following[index])) {
            return added.slice(0, -length);
        }
    }
    const meaningful = (line: string) => line.trim().length > 1;
    if (added[0] === following[0] && meaningful(added[0])) {
        return added.slice(1);
    }
    if (added.length >= 3 && following.length >= 2
        && meaningful(following[0]) && meaningful(following[1])) {
        for (let start = 1; start < added.length - 1; start++) {
            if (added[start] !== following[0] || added[start + 1] !== following[1]) {
                continue;
            }
            let length = 2;
            while (start + length < added.length && length < following.length
                && added[start + length] === following[length]) {
                length++;
            }
            return [...added.slice(0, start), ...added.slice(start + length)];
        }
    }
    return added;
}

function cursorAfterPrimaryEdit(
    range: vscode.Range,
    editText: string,
    isInsertion: boolean,
    originalLineCount: number,
): vscode.Position {
    let text = editText;
    // lineReplacementToText adds a separator after an insertion before an
    // existing line. The cursor remains at the end of generated content,
    // immediately before that separator.
    if (isInsertion && text.endsWith('\n') && range.start.line < originalLineCount) {
        text = text.slice(0, -1);
    }
    const insertedLines = text.replace(/\r\n/g, '\n').split('\n');
    return insertedLines.length === 1
        ? new vscode.Position(range.start.line, range.start.character + insertedLines[0].length)
        : new vscode.Position(range.start.line + insertedLines.length - 1, insertedLines[insertedLines.length - 1].length);
}

function lineReplacementToText(edit: LineReplacement, range: vscode.Range, document: vscode.TextDocument): string {
    if (edit.isInsertion) {
        if (edit.lineRange.startLineNumber >= document.lineCount) {
            // Insert at end of document — prepend newline so lines start on their own line.
            return '\n' + edit.newLines.join('\n');
        }
        // Insert between lines — append newline so following line stays separate.
        return edit.newLines.join('\n') + '\n';
    }
    if (edit.isSingleLineEdit) {
        const originalLine = document.lineAt(edit.lineRange.startLineNumber).text;
        const unchangedTail = originalLine.length - range.end.character;
        return edit.newLines[0].slice(range.start.character, edit.newLines[0].length - unchangedTail);
    }
    return edit.newLines.join('\n');
}

function lineReplacementToRange(edit: LineReplacement, document: vscode.TextDocument): vscode.Range {
    if (edit.isInsertion) {
        const insertLine = edit.lineRange.startLineNumber;
        if (insertLine >= document.lineCount) {
            // Insert at end of document — position after last line
            const lastLine = document.lineCount - 1;
            const lastLineLen = document.lineAt(lastLine).text.length;
            const pos = new vscode.Position(lastLine, lastLineLen);
            return new vscode.Range(pos, pos);
        }
        // Insert between lines — position at start of the line at insertLine
        const pos = new vscode.Position(insertLine, 0);
        return new vscode.Range(pos, pos);
    }
    if (edit.isDeletion) {
        const startLine = Math.max(0, edit.lineRange.startLineNumber);
        const endLine = Math.min(edit.lineRange.endLineNumberExclusive, document.lineCount);
        if (endLine >= document.lineCount) {
            const lastLine = document.lineCount - 1;
            const end = new vscode.Position(lastLine, document.lineAt(lastLine).text.length);
            const start = startLine > 0
                ? new vscode.Position(startLine - 1, document.lineAt(startLine - 1).text.length)
                : new vscode.Position(0, 0);
            return new vscode.Range(start, end);
        }
        return new vscode.Range(
            new vscode.Position(startLine, 0),
            new vscode.Position(endLine, 0),
        );
    }
    // Standard replacement — include character-level precision for single-line edits
    if (edit.isSingleLineEdit) {
        const lineIdx = Math.max(0, edit.lineRange.startLineNumber);
        const origLine = document.lineAt(lineIdx).text;
        const newLine = edit.newLines[0];

        let charHead = 0;
        while (charHead < origLine.length && charHead < newLine.length
            && origLine[charHead] === newLine[charHead]) {
            charHead++;
        }

        let charTail = 0;
        while (charTail < origLine.length - charHead && charTail < newLine.length - charHead
            && origLine[origLine.length - 1 - charTail] === newLine[newLine.length - 1 - charTail]) {
            charTail++;
        }

        return new vscode.Range(
            new vscode.Position(lineIdx, charHead),
            new vscode.Position(lineIdx, origLine.length - charTail),
        );
    }
    // Multi-line replacement — full line range
    const startLine = Math.max(0, edit.lineRange.startLineNumber);
    const endLine = Math.min(edit.lineRange.endLineNumberExclusive - 1, document.lineCount - 1);
    const endLineText = document.lineAt(endLine).text;
    return new vscode.Range(
        new vscode.Position(startLine, 0),
        new vscode.Position(endLine, endLineText.length),
    );
}
