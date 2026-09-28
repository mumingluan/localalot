import * as vscode from 'vscode';

interface RejectedEdit {
    uri: string;
    start: number;
    end: number;
    text: string;
}

/** Tracks rejected replacements across document edits outside their ranges. */
export class RejectedEditHistory {
    private readonly entries: RejectedEdit[] = [];

    constructor(private readonly limit = 20) {}

    reject(document: vscode.TextDocument, range: vscode.Range, text: string): void {
        const entry = {
            uri: document.uri.toString(),
            start: document.offsetAt(range.start),
            end: document.offsetAt(range.end),
            text,
        };
        const old = this.entries.findIndex(item => this.same(item, entry));
        if (old >= 0) this.entries.splice(old, 1);
        this.entries.push(entry);
        if (this.entries.length > this.limit) this.entries.shift();
    }

    isRejected(document: vscode.TextDocument, range: vscode.Range, text: string): boolean {
        const candidate = {
            uri: document.uri.toString(),
            start: document.offsetAt(range.start),
            end: document.offsetAt(range.end),
            text,
        };
        return this.entries.some(entry => this.same(entry, candidate));
    }

    applyChanges(uri: string, changes: readonly vscode.TextDocumentContentChangeEvent[]): void {
        if (changes.length === 0) return;
        const ordered = [...changes].sort((a, b) => a.rangeOffset - b.rangeOffset);
        for (let index = this.entries.length - 1; index >= 0; index--) {
            const entry = this.entries[index];
            if (entry.uri !== uri) continue;
            let shift = 0;
            let invalid = false;
            for (const change of ordered) {
                const changeEnd = change.rangeOffset + change.rangeLength;
                if (changeEnd < entry.start || (changeEnd === entry.start && change.rangeLength > 0)) {
                    shift += change.text.length - change.rangeLength;
                } else if (change.rangeOffset >= entry.end) {
                    continue;
                } else {
                    invalid = true;
                    break;
                }
            }
            if (invalid) {
                this.entries.splice(index, 1);
            } else {
                entry.start += shift;
                entry.end += shift;
            }
        }
    }

    private same(left: RejectedEdit, right: RejectedEdit): boolean {
        return left.uri === right.uri && left.start === right.start
            && left.end === right.end && left.text === right.text;
    }
}
