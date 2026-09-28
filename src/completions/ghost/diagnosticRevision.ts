import type * as vscode from 'vscode';
import { diagnosticFingerprint } from '../shared/diagnosticFingerprint';

/** Diagnostics are prompt context even when the document text is unchanged. */
const revisions = new Map<string, { revision: number; fingerprint?: string }>();

export function ghostDiagnosticRevision(uri: string): number {
    return revisions.get(uri)?.revision ?? 0;
}

export function noteGhostDiagnosticsChanged(uri: string, diagnostics?: readonly vscode.Diagnostic[]): boolean {
    // Language servers can republish an identical diagnostic list. Only a
    // changed prompt input should evict an otherwise reusable suggestion.
    const fingerprint = diagnostics && diagnosticFingerprint(diagnostics);
    const previous = revisions.get(uri);
    if (fingerprint !== undefined && previous?.fingerprint === fingerprint) return false;
    revisions.set(uri, { revision: (previous?.revision ?? 0) + 1, fingerprint });
    return true;
}
