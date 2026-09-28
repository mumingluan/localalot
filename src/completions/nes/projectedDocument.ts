import * as vscode from 'vscode';
import { buildVirtualGhostContext } from '../ghost/virtualDocument';
import { NesCompletionItem } from './types';

export interface ProjectedNesDocument {
    document: vscode.TextDocument;
    position: vscode.Position;
    sourceText: string;
    expectedText: string;
    /** Exact insertion trajectory where a user can type through the preview. */
    typeThrough?: { before: string; inserted: string; after: string };
}

export function isOnProjectedNesTrajectory(projected: ProjectedNesDocument, actualText: string): boolean {
    if (actualText === projected.sourceText || actualText === projected.expectedText) return true;
    const trajectory = projected.typeThrough;
    if (!trajectory || !actualText.startsWith(trajectory.before) || !actualText.endsWith(trajectory.after)) return false;
    if (actualText.length < trajectory.before.length + trajectory.after.length) return false;
    const typed = actualText.slice(trajectory.before.length, actualText.length - trajectory.after.length);
    return trajectory.inserted.startsWith(typed);
}

/** Build the document VS Code will have after accepting all edits in an item. */
export function projectAcceptedNesItem(
    document: vscode.TextDocument,
    item: NesCompletionItem,
    renderedInsertText?: string,
): ProjectedNesDocument | undefined {
    if (!item.range || typeof item.insertText !== 'string') return undefined;
    const sourceText = document.getText();
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const normalizeEditText = (text: string) => text.replace(/\r\n|\r|\n/g, eol);
    const start = document.offsetAt(item.range.start);
    const end = document.offsetAt(item.range.end);
    if (end < start) return undefined;
    const inserted = normalizeEditText(renderedInsertText || item.insertText);
    const cursorOffset = start + inserted.length;
    const expectedText = sourceText.slice(0, start) + inserted + sourceText.slice(end);
    if (expectedText === sourceText) return undefined;
    const documentEnd = document.lineAt(document.lineCount - 1).range.end;
    const virtual = buildVirtualGhostContext(document, {
        range: new vscode.Range(new vscode.Position(0, 0), documentEnd),
        text: expectedText,
    });
    if (!virtual) return undefined;
    return {
        document: virtual.document,
        position: virtual.document.positionAt(cursorOffset),
        sourceText,
        expectedText,
        typeThrough: { before: sourceText.slice(0, start), inserted, after: sourceText.slice(end) },
    };
}
