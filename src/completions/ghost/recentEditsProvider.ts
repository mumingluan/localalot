import * as vscode from 'vscode';
import { createServiceIdentifier } from '../../di/services';
import { ILogService } from '../shared/log/logService';
import { isSourceDocumentUri } from '../shared/documentEligibility';

export const IRecentEditsProvider = createServiceIdentifier<IRecentEditsProvider>('IRecentEditsProvider');

export interface IRecentEditsProvider {
    readonly _serviceBrand: undefined;
    readonly recentEdits: string[];
    getRecentEditsFor?(document: vscode.TextDocument, position: vscode.Position): string[];
    register(): vscode.Disposable;
}

interface RecentEditEntry {
    summary: string;
    uri: string;
    startLine: number;
    endLine: number;
}

export class RecentEditsProvider implements IRecentEditsProvider {
    readonly _serviceBrand: undefined;
    private _recentEdits: RecentEditEntry[] = [];
    private readonly _maxEntries = 8;
    private readonly _debounceMs = 500;
    private _listener: vscode.Disposable | undefined;
    private _openListener: vscode.Disposable | undefined;
    private _closeListener: vscode.Disposable | undefined;
    private readonly _previousContents = new Map<string, string>();
    private readonly _pending = new Map<string, {
        before: string;
        after: string;
        fileName: string;
        startLine: number;
        endLine: number;
        timer: ReturnType<typeof setTimeout>;
    }>();

    constructor(
        @ILogService private readonly _log: ILogService,
    ) {}

    get recentEdits(): string[] {
        return this._recentEdits.map(edit => edit.summary);
    }

    getRecentEditsFor(document: vscode.TextDocument, position: vscode.Position): string[] {
        const uri = document.uri.toString();
        return this._recentEdits
            .filter(edit => edit.uri !== uri
                || (Math.abs(edit.startLine - position.line) > 100
                    && Math.abs(edit.endLine - position.line) > 100))
            .map(edit => edit.summary);
    }

    register(): vscode.Disposable {
        for (const document of vscode.workspace.textDocuments) {
            if (isSourceDocumentUri(document.uri)) {
                this._previousContents.set(document.uri.toString(), document.getText());
            }
        }
        this._openListener ??= vscode.workspace.onDidOpenTextDocument(document => {
            if (isSourceDocumentUri(document.uri)) {
                this._previousContents.set(document.uri.toString(), document.getText());
            }
        });
        this._closeListener ??= vscode.workspace.onDidCloseTextDocument(document => {
            const uri = document.uri.toString();
            this._flush(uri);
            this._previousContents.delete(uri);
        });
        this._listener ??= vscode.workspace.onDidChangeTextDocument(e => {
            if (!isSourceDocumentUri(e.document.uri)) return;
            const uri = e.document.uri.toString();
            const before = this._previousContents.get(uri);
            const after = e.document.getText();
            this._previousContents.set(uri, after);
            if (before === undefined || before === after || e.contentChanges.length === 0) return;
            const startLine = Math.min(...e.contentChanges.map(change => change.range.start.line));
            const endLine = Math.max(...e.contentChanges.map(change => change.range.end.line));
            let pending = this._pending.get(uri);
            if (pending && (startLine > pending.endLine + 1 || endLine < pending.startLine - 1)) {
                this._flush(uri);
                pending = undefined;
            }
            this._rebaseRecentEdits(uri, e.contentChanges);
            if (pending) clearTimeout(pending.timer);
            const folder = vscode.workspace.getWorkspaceFolder(e.document.uri);
            const fileName = folder
                ? vscode.workspace.asRelativePath(e.document.uri, true)
                : e.document.uri.path.split('/').pop() || 'untitled';
            const timer = setTimeout(() => this._flush(uri), this._debounceMs);
            this._pending.set(uri, {
                before: pending?.before ?? before, after, fileName,
                startLine: Math.min(pending?.startLine ?? startLine, startLine),
                endLine: Math.max(pending?.endLine ?? endLine, endLine),
                timer,
            });
        });
        this._log.debug('RecentEdits: tracking workspace text changes');
        return {
            dispose: () => {
                this._listener?.dispose();
                this._openListener?.dispose();
                this._closeListener?.dispose();
                this._listener = undefined;
                this._openListener = undefined;
                this._closeListener = undefined;
                for (const pending of this._pending.values()) clearTimeout(pending.timer);
                this._pending.clear();
                this._previousContents.clear();
            },
        };
    }

    private _flush(uri: string): void {
        const pending = this._pending.get(uri);
        if (!pending) return;
        clearTimeout(pending.timer);
        this._pending.delete(uri);
        const summary = summarizeRecentEdit(pending.fileName, pending.before, pending.after);
        if (summary) this._push({
            summary: summary.text, uri, startLine: summary.startLine, endLine: summary.endLine,
        });
    }

    private _rebaseRecentEdits(uri: string, changes: readonly vscode.TextDocumentContentChangeEvent[]): void {
        const ordered = [...changes].sort((a, b) => b.range.start.line - a.range.start.line
            || b.range.start.character - a.range.start.character);
        for (const change of ordered) {
            const insertedLines = (change.text.match(/\r\n|\r|\n/g) ?? []).length;
            const lineDelta = insertedLines - (change.range.end.line - change.range.start.line);
            this._recentEdits = this._recentEdits.flatMap(edit => {
                if (edit.uri !== uri) return [edit];
                const endsBefore = change.range.end.line < edit.startLine
                    || (change.range.end.line === edit.startLine && change.range.end.character === 0
                        && (change.range.start.line < change.range.end.line
                            || (change.range.isEmpty && insertedLines > 0)));
                if (endsBefore) {
                    if (lineDelta === 0) return [edit];
                    const startLine = edit.startLine + lineDelta;
                    return [{
                        ...edit,
                        startLine,
                        endLine: edit.endLine + lineDelta,
                        summary: edit.summary.replace(/(@@ -)\d+(,\d+ \+)\d+(,\d+ @@)/,
                            (_match, prefix: string, middle: string, suffix: string) =>
                                `${prefix}${startLine + 1}${middle}${startLine + 1}${suffix}`),
                    }];
                }
                if (change.range.start.line > edit.endLine) return [edit];
                // A later edit changed the source represented by this hunk.
                return [];
            });
        }
    }

    private _push(edit: RecentEditEntry): void {
        this._recentEdits.push(edit);
        while (this._recentEdits.length > this._maxEntries) this._recentEdits.shift();
    }
}

/** A bounded diff hunk keeps the changed code and its nearby meaning together. */
function summarizeRecentEdit(fileName: string, before: string, after: string): {
    text: string; startLine: number; endLine: number;
} | undefined {
    const oldLines = before.replace(/\r\n/g, '\n').split('\n');
    const newLines = after.replace(/\r\n/g, '\n').split('\n');
    let start = 0;
    while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
    let oldEnd = oldLines.length;
    let newEnd = newLines.length;
    while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
        oldEnd--;
        newEnd--;
    }
    if (start === oldEnd && start === newEnd) return undefined;
    const removedLines = oldLines.slice(start, oldEnd);
    const addedLines = newLines.slice(start, newEnd);
    // The native recent-edit prompt omits whitespace-only changes and edits
    // whose changed portion is too large to be useful as local context.
    if (removedLines.filter(line => line.trim()).join('').trim()
        === addedLines.filter(line => line.trim()).join('').trim()
        || removedLines.length > 10 || addedLines.length > 10) return undefined;
    const boundedLine = (prefix: string, line: string): string =>
        prefix + (line.length > 150 ? line.slice(0, 149) + '…' : line);
    const contextStart = Math.max(0, start - 3);
    const beforeContext = oldLines.slice(contextStart, start).map(line => boundedLine(' ', line));
    const added = addedLines.map(line => boundedLine('+', line));
    const removed = removedLines.map(line => boundedLine('-', line) + ' --- IGNORE ---');
    const afterContext = newLines.slice(newEnd, Math.min(newLines.length, newEnd + 3))
        .map(line => boundedLine(' ', line));
    const path = fileName.slice(-120);
    const oldLength = beforeContext.length + removed.length + afterContext.length;
    const newLength = beforeContext.length + added.length + afterContext.length;
    const lines = [
        `--- a/${path}`, `+++ b/${path}`,
        `@@ -${contextStart + 1},${oldLength} +${contextStart + 1},${newLength} @@`,
        ...beforeContext, ...added, ...removed, ...afterContext,
    ];
    const text = lines.join('\n');
    if (text.length > 2000) return undefined;
    return { text, startLine: contextStart, endLine: Math.max(contextStart, newEnd - 1) };
}
