import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { createServiceIdentifier } from '../../di/services';
import { DocumentId } from './stubs/types';
import type { PromptPieces } from './promptCrafting';
import { canUseAsNeighborDocument, isSourceDocumentUri } from '../shared/documentEligibility';

export const INextEditCache = createServiceIdentifier<INextEditCache>('INextEditCache');

export interface CachedEdit {
    docId: DocumentId;
    documentBeforeEdit: string;
    /** Context from other open documents when this edit was generated. */
    contextStamp?: string;
    editWindow: { startLine: number; endLineExclusive: number };
    /** Source cursor window for an edit found by a same-file cursor jump. */
    originalEditWindow?: { startLine: number; endLineExclusive: number };
    edit: string;
    cacheTime: number;
    /** Cursor line when the suggestion was generated, used for distance gating. */
    cursorLineAtCacheTime?: number;
    /** Positive values identify staged follow-up edits in a consecutive chain. */
    subsequentN?: number;
    /** The document that receives the edit when this is a cross-file entry. */
    targetDocId?: DocumentId;
    /** Target document snapshot used to validate edit coordinates. */
    targetDocumentBeforeEdit?: string;
    targetEditWindow?: { startLine: number; endLineExclusive: number };
    targetPosition?: { line: number; character: number };
    /** Set when this edit was returned as an inline (ghost text) suggestion */
    wasRenderedAsInlineSuggestion?: boolean;
    /** Set after the user rejects this exact cached edit. */
    rejected?: boolean;
    /** Full cached edit text used to compare rebased suggestions after rejection. */
    rejectedEdit?: string;
}

export interface CachedOrRebasedEdit extends CachedEdit {
    rebasedEdit?: string;
    isFromSpeculativeRequest?: boolean;
}

export interface CachedNoEdit {
    docId: DocumentId;
    /** Open source documents that could have supplied semantic or recent-file context. */
    contextStamp?: string;
    editWindow: { startLine: number; endLineExclusive: number };
    cursorLine: number;
    cursorCharacter?: number;
    predictionComplete: boolean;
    promptPieces?: PromptPieces;
    jump?: { uri: string; line: number; character: number; targetDocumentText: string };
}

export interface INextEditCache {
    readonly _serviceBrand: undefined;
    setKthNextEdit(docId: DocumentId, edit: CachedEdit): void;
    /**
     * Look up a cached edit for the given document and cursor position.
     * The position is validated against the cached edit's editWindow
     * to prevent serving edits cached for a different cursor location.
     */
    lookupNextEdit(docId: DocumentId, document: { getText(): string }, position: { line: number }): CachedOrRebasedEdit | undefined;
    setNoNextEdit(docId: DocumentId, documentBeforeEdit: string, editWindow: { startLine: number; endLineExclusive: number }, cursorLine: number, promptPieces?: PromptPieces, cursorCharacter?: number): void;
    getNoNextEdit(docId: DocumentId, document: { getText(): string }, position: { line: number; character?: number }): CachedNoEdit | undefined;
    lookupNoNextEdit(docId: DocumentId, document: { getText(): string }, position: { line: number }): boolean;
    getContextStamp(docId: DocumentId): string;
    markNoNextEditPredictionComplete(docId: DocumentId, documentBeforeEdit: string, cursorLine: number, jump?: CachedNoEdit['jump'], cursorCharacter?: number): void;
    clearNoNextEdit(docId: DocumentId): void;
    clear(docId: DocumentId): void;
    clearAll(): void;
}

export class NextEditCache implements INextEditCache {
    readonly _serviceBrand: undefined;
    private readonly _cache = new Map<string, CachedEdit>();
    private readonly _noEditCache = new Map<string, CachedNoEdit>();
    private readonly _maxEntries = 50;
    private static readonly _documentIdentities = new WeakMap<vscode.TextDocument, number>();
    private static _nextDocumentIdentity = 0;

    // Native NES keeps the cursor-distance experiment off by default. Its
    // exact-snapshot cache remains usable as the cursor moves in the window.
    constructor(private readonly _cursorDistanceCheck = false) {}

    setKthNextEdit(docId: DocumentId, edit: CachedEdit): void {
        const key = this._getKey(docId.uri, edit.documentBeforeEdit);
        edit.contextStamp ??= this._contextStamp(docId);
        this._noEditCache.delete(key);
        const existing = this._cache.get(key);
        if (existing) {
            this._cache.delete(key);
        }
        this._cache.set(key, edit);
        // Enforce max entries: evict first inserted (simple FIFO eviction)
        if (this._cache.size > this._maxEntries) {
            const firstKey = this._cache.keys().next().value;
            if (firstKey !== undefined) {
                this._cache.delete(firstKey);
            }
        }
    }

    setNoNextEdit(docId: DocumentId, documentBeforeEdit: string, editWindow: { startLine: number; endLineExclusive: number }, cursorLine: number, promptPieces?: PromptPieces, cursorCharacter?: number): void {
        // A no-result cache covers less than the requested window, letting a
        // cursor move near either edge trigger a fresh request.
        const reducedWindow = {
            startLine: Math.min(cursorLine, editWindow.startLine + 1),
            endLineExclusive: Math.max(cursorLine + 1, editWindow.endLineExclusive - 1),
        };
        const key = this._getKey(docId.uri, documentBeforeEdit);
        const contextStamp = this._contextStamp(docId);
        const existing = this._noEditCache.get(key);
        if (existing?.predictionComplete && existing.cursorLine === cursorLine
            && existing.contextStamp === contextStamp) return;
        this._noEditCache.delete(key);
        this._noEditCache.set(key, {
            docId, editWindow: reducedWindow, cursorLine, cursorCharacter,
            contextStamp,
            predictionComplete: promptPieces === undefined, promptPieces,
        });
        if (this._noEditCache.size > this._maxEntries) {
            const oldest = this._noEditCache.keys().next().value;
            if (oldest !== undefined) this._noEditCache.delete(oldest);
        }
    }

    lookupNoNextEdit(docId: DocumentId, document: { getText(): string }, position: { line: number }): boolean {
        return this.getNoNextEdit(docId, document, position) !== undefined;
    }

    getContextStamp(docId: DocumentId): string {
        return this._contextStamp(docId);
    }

    getNoNextEdit(docId: DocumentId, document: { getText(): string }, position: { line: number; character?: number }): CachedNoEdit | undefined {
        const key = this._getKey(docId.uri, document.getText());
        const entry = this._noEditCache.get(key);
        if (!entry || position.line < entry.editWindow.startLine || position.line >= entry.editWindow.endLineExclusive) {
            return undefined;
        }
        if (entry.contextStamp !== this._contextStamp(docId)) {
            this._noEditCache.delete(key);
            return undefined;
        }
        if (!entry.predictionComplete && position.line !== entry.cursorLine) return undefined;
        if (!entry.predictionComplete && entry.cursorCharacter !== undefined
            && position.character !== undefined && position.character !== entry.cursorCharacter) return undefined;
        this._noEditCache.delete(key);
        this._noEditCache.set(key, entry);
        return entry;
    }

    markNoNextEditPredictionComplete(docId: DocumentId, documentBeforeEdit: string, cursorLine: number, jump?: CachedNoEdit['jump'], cursorCharacter?: number): void {
        const entry = this._noEditCache.get(this._getKey(docId.uri, documentBeforeEdit));
        if (!entry || entry.cursorLine !== cursorLine) return;
        if (entry.cursorCharacter !== undefined && cursorCharacter !== undefined
            && entry.cursorCharacter !== cursorCharacter) return;
        entry.predictionComplete = true;
        entry.promptPieces = undefined;
        entry.jump = jump;
    }

    clearNoNextEdit(docId: DocumentId): void {
        for (const [key, entry] of this._noEditCache) {
            if (entry.docId === docId) this._noEditCache.delete(key);
        }
    }

    lookupNextEdit(docId: DocumentId, document: { getText(): string }, position: { line: number }): CachedOrRebasedEdit | undefined {
        const docText = document.getText();
        const key = this._getKey(docId.uri, docText);
        const contextStamp = this._contextStamp(docId);
        const cached = this._cache.get(key);
        if (cached) {
            if (cached.contextStamp !== contextStamp) {
                this._cache.delete(key);
                return undefined;
            }
            if (cached.rejected) return undefined;
            // Validate that the cursor is still within the edit window.
            // Without this check a cached edit from line 5 would be
            // incorrectly served when the user moves to line 100 without
            // changing the document text.
            const { startLine, endLineExclusive } = cached.editWindow;
            const originalWindow = cached.originalEditWindow;
            const inOriginalWindow = originalWindow !== undefined
                && position.line >= originalWindow.startLine
                && position.line < originalWindow.endLineExclusive;
            if ((position.line < startLine || position.line >= endLineExclusive) && !inOriginalWindow) {
                return undefined;
            }
            if (!cached.targetDocId && cached.subsequentN !== undefined && cached.subsequentN > 0) {
                return cached;
            }
            if (this._cursorDistanceCheck && !cached.targetDocId && !inOriginalWindow
                && cached.cursorLineAtCacheTime !== undefined) {
                const editStartDistance = Math.abs(cached.cursorLineAtCacheTime - startLine);
                const currentDistance = Math.abs(position.line - startLine);
                if (currentDistance > editStartDistance) {
                    cached.rejected = true;
                    return undefined;
                }
            }
            // The native shared cache is LRU: a hit protects this snapshot
            // from eviction when other documents produce new suggestions.
            this._cache.delete(key);
            this._cache.set(key, cached);
            return cached;
        }

        // A small edit outside the predicted window should not invalidate the
        // prediction. Rebase only when the old window and short surrounding
        // anchors still occur exactly once in the current document.
        const currentLines = normalizeLines(docText);
        const now = Date.now();
        const candidates: CachedOrRebasedEdit[] = [];
        let anchoredEntryCount = 0;
        for (const entry of this._cache.values()) {
            if (entry.contextStamp !== contextStamp) continue;
            // Cross-file entries are anchored to two exact document snapshots.
            // They must never be textually rebased against the owner document.
            if (entry.targetDocId) continue;
            // Rejected entries remain eligible for rebase so a changed
            // document can produce a genuinely different edit. Exact hits
            // are handled above and never resurrect the rejected suggestion.
            if (entry.rejected && !entry.rejectedEdit) continue;
            if (entry.docId !== docId || now - entry.cacheTime > 30_000) continue;
            const oldLines = normalizeLines(entry.documentBeforeEdit);
            const start = entry.editWindow.startLine;
            const end = entry.editWindow.endLineExclusive;
            if (start < 0 || end <= start || end > oldLines.length) continue;
            const window = oldLines.slice(start, end);
            const before = oldLines.slice(Math.max(0, start - 3), start);
            const after = oldLines.slice(end, Math.min(oldLines.length, end + 3));
            const originalWindow = entry.originalEditWindow;
            const sourceWindowUnchanged = originalWindow !== undefined
                && originalWindow.startLine >= 0
                && originalWindow.endLineExclusive <= oldLines.length
                && position.line >= originalWindow.startLine
                && position.line < originalWindow.endLineExclusive
                && sameLines(currentLines, originalWindow.startLine,
                    oldLines.slice(originalWindow.startLine, originalWindow.endLineExclusive));
            const entryCandidates: CachedOrRebasedEdit[] = [];
            let hasAnchorMatch = false;
            for (let candidateStart = 0; candidateStart < currentLines.length; candidateStart++) {
                const beforeStart = candidateStart - before.length;
                if (beforeStart < 0 || !sameLines(currentLines, beforeStart, before)) continue;
                const maxEnd = Math.min(currentLines.length, candidateStart + Math.max(window.length + 4, window.length * 2));
                for (let candidateEnd = candidateStart + 1; candidateEnd <= maxEnd; candidateEnd++) {
                    if (!sameLines(currentLines, candidateEnd, after)) continue;
                    hasAnchorMatch = true;
                    const currentWindow = currentLines.slice(candidateStart, candidateEnd);
                    const rebasedEdit = rebaseTypedThrough(entry, window, currentWindow);
                    const inTargetWindow = position.line >= candidateStart && position.line < candidateEnd;
                    if (!rebasedEdit || (!inTargetWindow && !sourceWindowUnchanged)) continue;
                    if (entry.rejected && rebasedEdit === (entry.rejectedEdit ?? entry.edit)) continue;
                    entryCandidates.push({
                        ...entry,
                        // Keep the original model edit for telemetry and cache
                        // identity. The assembled result consumes rebasedEdit.
                        edit: entry.edit,
                        rebasedEdit,
                        editWindow: { startLine: candidateStart, endLineExclusive: candidateEnd },
                        targetPosition: entry.targetPosition && {
                            ...entry.targetPosition,
                            line: candidateStart + entry.targetPosition.line - start,
                        },
                        isFromSpeculativeRequest: true,
                    });
                    break;
                }
            }
            if (hasAnchorMatch) anchoredEntryCount++;
            // Repeated code blocks are intentionally treated as ambiguous. The
            // native provider would rather request again than apply an edit to a
            // location chosen only by textual coincidence.
            if (entryCandidates.length === 1) candidates.push(entryCandidates[0]);
        }
        if (anchoredEntryCount > 1) return undefined;
        if (candidates.length === 1) return candidates[0];
        return undefined;
    }

    clear(docId: DocumentId): void {
        for (const [key, entry] of this._cache) {
            if (entry.docId === docId || entry.targetDocId === docId) {
                this._cache.delete(key);
            }
        }
        this.clearNoNextEdit(docId);
    }

    clearAll(): void {
        this._cache.clear();
        this._noEditCache.clear();
    }

    private _getKey(docUri: string, content: string): string {
        // The entry already retains the source snapshot. Putting the whole
        // document in the map key kept a second copy for every cached result.
        // Hash UTF-16 code units so even malformed buffer text has a stable,
        // distinct fingerprint without allocating an escaped JSON document.
        const fingerprint = createHash('sha256').update(content, 'utf16le').digest('hex');
        return JSON.stringify([docUri, content.length, fingerprint]);
    }

    private _contextStamp(docId: DocumentId): string {
        const sourceUri = docId.toUri();
        if (!isSourceDocumentUri(sourceUri)) return '';
        return vscode.workspace.textDocuments
            .filter(document => document.uri.toString() !== docId.uri
                && canUseAsNeighborDocument(sourceUri, document.uri))
            .map(document => {
                let identity = NextEditCache._documentIdentities.get(document);
                if (identity === undefined) {
                    identity = ++NextEditCache._nextDocumentIdentity;
                    NextEditCache._documentIdentities.set(document, identity);
                }
                return `${document.uri.toString()}@${identity}:${document.version}`;
            })
            .sort()
            .join('|');
    }
}

/** Accept text the user already typed when it is a strict prefix of the cached target. */
function rebaseTypedThrough(entry: CachedEdit, originalWindow: readonly string[], currentWindow: readonly string[]): string | undefined {
    const targetLines = normalizeLines(entry.edit);
    // An unrelated document change can invalidate the snapshot key while the
    // edit window itself is byte-identical. Reuse the model's entire replacement
    // instead of indexing it by old line positions: that would duplicate or
    // drop lines when the proposed edit inserts or deletes a line.
    if (sameLines(currentWindow, 0, originalWindow) && currentWindow.length === originalWindow.length) {
        return entry.edit;
    }
    // With a changed window and a line-count-changing model edit there is no
    // one-to-one line mapping. A fresh request is safer than replaying a patch
    // at guessed coordinates.
    if (targetLines.length !== originalWindow.length) return undefined;
    if (targetLines.length !== currentWindow.length) {
        if (currentWindow.length < originalWindow.length || currentWindow.length > originalWindow.length + 4) return undefined;
        return rebaseChangedLineCount(originalWindow, targetLines, currentWindow);
    }
    const rebased = [...targetLines];
    for (let index = 0; index < currentWindow.length; index++) {
        const current = currentWindow[index];
        const target = targetLines[index];
        if (current === originalWindow[index]) continue;
        if (current === target) continue;
        if (isTypedPrefix(current, target)) continue;
        if (!sameIgnoringIndent(current, originalWindow[index])) return undefined;
        const originalIndent = leadingWhitespace(originalWindow[index]);
        if (leadingWhitespace(target) !== originalIndent) return undefined;
        rebased[index] = leadingWhitespace(current) + target.slice(originalIndent.length);
    }
    return rebased.join('\n');
}

function rebaseChangedLineCount(original: readonly string[], target: readonly string[], current: readonly string[]): string | undefined {
    let oldIndex = 0;
    let currentIndex = 0;
    let skipped = 0;
    const rebased: string[] = [];
    while (oldIndex < original.length && currentIndex < current.length) {
        const oldLine = original[oldIndex];
        const currentLine = current[currentIndex];
        const targetLine = target[oldIndex];
        if (currentLine === oldLine || currentLine === targetLine || isTypedPrefix(currentLine, targetLine)
            || sameIgnoringIndent(currentLine, oldLine)) {
            if (sameIgnoringIndent(currentLine, oldLine) && currentLine !== oldLine && currentLine !== targetLine
                && !isTypedPrefix(currentLine, targetLine)) {
                const originalIndent = leadingWhitespace(oldLine);
                if (leadingWhitespace(targetLine) !== originalIndent) return undefined;
                rebased.push(leadingWhitespace(currentLine) + targetLine.slice(originalIndent.length));
            } else {
                rebased.push(targetLine);
            }
            oldIndex++;
            currentIndex++;
        } else if (currentLine.trim() === '' && skipped < 4) {
            // A blank line inserted by the user is meaningful layout. Preserve
            // it in the rebased response instead of deleting it on acceptance.
            rebased.push(currentLine);
            currentIndex++;
            skipped++;
        } else {
            return undefined;
        }
    }
    while (oldIndex === original.length && currentIndex < current.length && current[currentIndex].trim() === '' && skipped < 4) {
        rebased.push(current[currentIndex]);
        currentIndex++;
        skipped++;
    }
    if (oldIndex < original.length || currentIndex < current.length) return undefined;
    return rebased.join('\n');
}

function isTypedPrefix(current: string, target: string): boolean {
    return current.length > 0 && target.startsWith(current);
}

function sameIgnoringIndent(left: string, right: string): boolean {
    return left.trim().length > 0 && left.trim() === right.trim();
}

function leadingWhitespace(line: string): string {
    return line.match(/^\s*/)?.[0] ?? '';
}

function normalizeLines(text: string): string[] {
    return text.replace(/\r\n/g, '\n').split('\n');
}

function sameLines(lines: readonly string[], start: number, expected: readonly string[]): boolean {
    if (start < 0 || start + expected.length > lines.length) return false;
    return expected.every((line, index) => lines[start + index] === line);
}
