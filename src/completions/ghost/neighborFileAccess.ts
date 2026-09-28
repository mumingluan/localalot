import * as vscode from 'vscode';
import { canUseAsNeighborDocument } from '../shared/documentEligibility';
import { detectLanguage, normalizeNeighborLanguageId } from '../shared/languageDetection';

const accessOrder = new Map<string, number>();
let nextAccess = 0;

function markAccess(uri: vscode.Uri): void {
    const key = uri.toString();
    accessOrder.delete(key);
    accessOrder.set(key, ++nextAccess);
    if (accessOrder.size > 128) {
        accessOrder.delete(accessOrder.keys().next().value!);
    }
}

/** Native open-tab neighbors are ordered by the last focused document. */
export function registerNeighborFileAccessTracking(): vscode.Disposable {
    if (vscode.window.activeTextEditor) {
        markAccess(vscode.window.activeTextEditor.document.uri);
    }
    return vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            markAccess(editor.document.uri);
        }
    });
}

export function sortNeighborFilesByAccess<T extends Pick<vscode.TextDocument, 'uri'>>(documents: readonly T[]): T[] {
    return [...documents].sort((a, b) =>
        (accessOrder.get(b.uri.toString()) ?? 0) - (accessOrder.get(a.uri.toString()) ?? 0));
}

/** Limit eligible neighbors, not all open tabs, as the native collector does. */
export function selectNeighborDocuments<T extends Pick<vscode.TextDocument, 'uri' | 'languageId' | 'getText'>>(
    active: Pick<vscode.TextDocument, 'uri' | 'languageId'>,
    documents: readonly T[],
    maxFiles = 20,
    maxAggregateChars = 200_000,
): T[] {
    if (maxFiles <= 0 || maxAggregateChars <= 0) return [];
    const languageId = normalizeNeighborLanguageId(detectLanguage(active).languageId);
    const selected: T[] = [];
    let aggregateChars = 0;
    for (const other of sortNeighborFilesByAccess(documents)) {
        if (other.uri.toString() === active.uri.toString()
            || !canUseAsNeighborDocument(active.uri, other.uri)
            || normalizeNeighborLanguageId(detectLanguage(other).languageId) !== languageId) continue;
        const length = other.getText().length;
        if (length === 0 || aggregateChars + length > maxAggregateChars) continue;
        selected.push(other);
        aggregateChars += length;
        if (selected.length >= maxFiles) break;
    }
    return selected;
}
