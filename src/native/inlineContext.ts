import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

/** Stable VS Code registration omits these original Copilot request fields. */
export function withNativeInlineContext(context: vscode.InlineCompletionContext): vscode.InlineCompletionContext {
    const extended = context as vscode.InlineCompletionContext & {
        requestUuid?: string;
        requestIssuedDateTime?: number;
    };
    return {
        ...context,
        requestUuid: extended.requestUuid ?? randomUUID(),
        requestIssuedDateTime: extended.requestIssuedDateTime ?? Date.now(),
    } as vscode.InlineCompletionContext;
}
