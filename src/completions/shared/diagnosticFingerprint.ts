import type * as vscode from 'vscode';

/** Only diagnostic fields included in completion context affect reuse. */
export function diagnosticFingerprint(diagnostics: readonly vscode.Diagnostic[]): string {
    return JSON.stringify(diagnostics.map(diagnostic => JSON.stringify([
        diagnostic.range.start.line, diagnostic.range.start.character,
        diagnostic.range.end.line, diagnostic.range.end.character,
        diagnostic.severity, diagnostic.source,
        typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code,
        diagnostic.message,
    ])).sort());
}
