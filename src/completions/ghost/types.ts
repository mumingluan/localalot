import * as vscode from 'vscode';

export interface GhostCompletion {
    completionIndex: number;
    completionText: string;
    /** Server termination reason used to decide whether exact typing is complete. */
    finishReason?: string;
    displayText: string;
    displayNeedsWsOffset: boolean;
    isMiddleOfTheLine: boolean;
    /** Number of existing same-line suffix characters safely covered by text. */
    suffixCoverage?: number;
}

/** Keeps the editor's inline suggestion stable while the next request is in flight. */
export class GhostCompletionList extends vscode.InlineCompletionList {
    public enableForwardStability = true;
}

export interface DiagnosticSummary {
    line: number;
    column?: number;
    severity: 'error' | 'warning';
    code?: string;
    source?: string;
    message: string;
}

export enum ResultType {
    Network = 0,
    Cache = 1,
    TypingAsSuggested = 2,
    Cycling = 3,
    Async = 4,
}
