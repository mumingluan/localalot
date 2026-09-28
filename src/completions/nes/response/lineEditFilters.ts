import * as vscode from 'vscode';
import { LineReplacement } from './lineReplacement';

export function allowWhitespaceOnlyChanges(document: vscode.TextDocument): boolean {
    return vscode.workspace.getConfiguration('localalot.nes', {
        uri: document.uri, languageId: document.languageId,
    }).get<boolean>('allowWhitespaceOnlyChanges', true);
}

export function allowImportChanges(document: vscode.TextDocument): boolean {
    return vscode.workspace.getConfiguration('localalot.nes', {
        uri: document.uri, languageId: document.languageId,
    }).get<boolean>('allowImportChanges', true);
}

/** Apply the native NES filters to each diff, preserving unrelated edits. */
export function filterLineEdits(
    edits: readonly LineReplacement[],
    originalLines: readonly string[],
    languageId: string,
    allowWhitespaceOnly = true,
    allowImports = true,
): LineReplacement[] {
    return edits.filter(edit => {
        const oldLines = originalLines.slice(
            edit.lineRange.startLineNumber - 1,
            edit.lineRange.endLineNumberExclusive - 1,
        );
        if (!allowImports && (oldLines.some(line => isImportStatement(line, languageId))
            || edit.newLines.some(line => isImportStatement(line, languageId)))) {
            return false;
        }
        if (edit.newLines.length === 0 && oldLines.every(line => line.trim() === '')) {
            return false;
        }
        if (edit.newLines.length > 0 && edit.newLines.every(line => line.trim() === '')) {
            return false;
        }
        if (oldLines.length === edit.newLines.length
            && oldLines.every((line, index) => line.trim() === edit.newLines[index].trim())) {
            return false;
        }
        if (!allowWhitespaceOnly) {
            const withoutWhitespace = (lines: readonly string[]) => lines.join('').replace(/\s/g, '');
            return withoutWhitespace(oldLines) !== withoutWhitespace(edit.newLines);
        }
        return true;
    });
}

function isImportStatement(line: string, languageId: string): boolean {
    switch (languageId) {
        case 'java':
            return /^\s*import\s/.test(line);
        case 'typescript':
        case 'typescriptreact':
        case 'javascript':
        case 'javascriptreact':
            return /^\s*import[\s{*]/.test(line)
                || /^\s*(?:var|const|let)\s+.+?=\s*require\(/.test(line);
        case 'php':
            return /^\s*use\s/.test(line);
        case 'rust':
            return /^\s*use\s+[\w:{}, ]+\s*(?:as\s+\w+)?;/.test(line);
        case 'python':
            return /^\s*from\s+[\w.]+\s+import\s+/.test(line)
                || /^\s*import\s+[\w., ]+/.test(line);
        default:
            return false;
    }
}
