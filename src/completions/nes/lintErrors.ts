import * as vscode from 'vscode';
import { LintOptions, LintOptionShowCode, LintOptionWarning, IXtabHistoryEntry } from './stubs/types';
import { CurrentDocument } from './xtabCurrentDocument';
import { PromptTags } from './tags';

export class LintErrors {
    constructor(
        private readonly _documentUri: vscode.Uri,
        private readonly _document: CurrentDocument,
        private readonly _xtabHistory?: readonly IXtabHistoryEntry[],
    ) { }

    getFormattedLintErrors(options: LintOptions): string {
        const diagnostics = this._getFilteredDiagnostics(this._documentUri, options, true);
        if (options.nRecentFiles > 0 && this._xtabHistory) {
            const seen = new Set([this._documentUri.toString()]);
            // NesHistoryTracker stores newest entries first. Preserve that
            // order so a limited diagnostics budget favors the latest file.
            for (const entry of this._xtabHistory) {
                const uri = entry.docId.toUri();
                const key = uri.toString();
                if (seen.has(key)) continue;
                seen.add(key);
                diagnostics.push(...this._getFilteredDiagnostics(uri, options, false));
                if (seen.size - 1 >= options.nRecentFiles) break;
            }
        }
        diagnostics.splice(options.maxLints);
        const formatted = diagnostics.map(d => formatSingleDiagnostic(
            d, this._document.lines,
            d.isCurrentFile ? options : { ...options, showCode: LintOptionShowCode.NO },
        )).join('\n');
        const tag = PromptTags.createLintTag(options.tagName);
        return `${tag.start}\n${formatted}\n${tag.end}`;
    }

    getData(): string {
        return '[]';
    }

    /**
     * Collects diagnostics for the current document and filters by distance,
     * severity, and prompt limit.
     */
    private _getFilteredDiagnostics(uri: vscode.Uri, options: LintOptions, isCurrentFile: boolean): DiagnosticInfo[] {
        const allDiagnostics = vscode.languages.getDiagnostics(uri);

        const relevant: DiagnosticInfo[] = [];
        for (const d of allDiagnostics) {
            const startLine = d.range.start.line; // 0-based
            const cursorLine = this._document.cursorPosition.lineNumber - 1; // convert 1-based to 0-based
            const lineDistance = Math.abs(startLine - cursorLine);

            if (isCurrentFile && lineDistance > options.maxLineDistance) {
                continue;
            }

            const severity = d.severity === vscode.DiagnosticSeverity.Error ? 'error' as const : 'warning' as const;

            const code = typeof d.code === 'object' ? d.code.value : d.code;
            relevant.push({
                severity,
                message: d.message,
                line: startLine,
                column: d.range.start.character,
                endLine: d.range.end.line,
                endColumn: d.range.end.character,
                code: code === undefined ? undefined : String(code),
                source: d.source,
                lineDistance,
                columnDistance: Math.abs(d.range.start.character - (this._document.cursorPosition.column - 1)),
                isCurrentFile,
            });
        }

        if (isCurrentFile) {
            relevant.sort((a, b) => a.lineDistance - b.lineDistance || a.columnDistance - b.columnDistance);
        } else {
            relevant.sort((a, b) => a.line - b.line);
        }
        const errors = relevant.filter(d => d.severity === 'error');
        const severityFiltered = options.warnings === LintOptionWarning.NO
            ? errors
            : options.warnings === LintOptionWarning.YES_IF_NO_ERRORS && errors.length > 0
                ? errors
                : relevant;
        return severityFiltered.slice(0, options.maxLints);
    }

}

interface DiagnosticInfo {
    severity: 'error' | 'warning';
    message: string;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    code: string | undefined;
    source: string | undefined;
    lineDistance: number;
    columnDistance: number;
    isCurrentFile: boolean;
}

function formatSingleDiagnostic(
    d: DiagnosticInfo,
    documentLines: readonly string[],
    options: LintOptions,
): string {
    let codeStr = '';
    if (d.code) {
        const src = d.source ? d.source.toUpperCase() : '';
        codeStr = ` ${src}${d.code}`;
    }

    const header = `${d.line}:${d.column} - ${d.severity}${codeStr}: ${d.message}`;

    if (options.showCode === LintOptionShowCode.NO) {
        return header;
    }

    const codeLines: string[] = [];
    const startLine = Math.max(0, d.line);
    const endLine = Math.min(documentLines.length - 1, d.endLine);

    const contextStart = options.showCode === 'YES_WITH_SURROUNDING' ? Math.max(0, startLine - 1) : startLine;
    const contextEnd = options.showCode === 'YES_WITH_SURROUNDING' ? Math.min(documentLines.length - 1, endLine + 1) : endLine;

    for (let i = contextStart; i <= contextEnd; i++) {
        const line = documentLines[i] ?? '';
        codeLines.push(`${i}|${line}`);
    }

    return header + '\n' + codeLines.join('\n');
}
