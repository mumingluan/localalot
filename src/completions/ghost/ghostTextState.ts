import * as vscode from 'vscode';
import { GhostCompletion, ResultType } from './types';

export interface CurrentGhostTextState {
    completionText: string;
    uri: vscode.Uri;
    version: number;
}

interface TrackedCompletion {
    completionText: string;
    finishReason?: string;
    isMiddleOfTheLine: boolean;
    displayNeedsWsOffset: boolean;
    suffixCoverage?: number;
    rendered?: { prefix: string; suffix: string; text: string };
    followUp?: boolean;
}

export class CurrentGhostText {
    private _state: CurrentGhostTextState | undefined;
    private _afterExplicitAccept = false;

    /** The document prefix when the completion was shown. */
    private _prefix?: string;

    /** The document suffix when the completion was shown. */
    private _suffix?: string;
    private _scope = '';

    /** The original completions shown to the user. */
    private _choices: TrackedCompletion[] = [];

    /** Completion selected by VS Code after cycling through the list. */
    private _activeCompletionText?: string;

    /** The currently shown completion text. */
    get clientCompletionId(): string | undefined {
        return this._activeCompletionText ?? this._choices[0]?.completionText;
    }

    /** The most recent inline completion request id, excluding speculative requests. */
    currentRequestId: string | undefined;

    /** Start a visible request and invalidate older responses. */
    beginRequest(): string {
        const requestId = `ghost-state-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.currentRequestId = requestId;
        return requestId;
    }

    isCurrentRequest(requestId: string | undefined): boolean {
        return requestId === undefined || this.currentRequestId === requestId;
    }

    setGhostText(prefix: string, suffix: string, completions: GhostCompletion[], resultType: ResultType, finishReason?: string, requestId?: string, scope = ''): void {
        if (!this.isCurrentRequest(requestId)) { return; }
        if (resultType === ResultType.TypingAsSuggested) { return; }
        this._afterExplicitAccept = false;
        this._prefix = normalizeLineEndings(prefix);
        this._suffix = normalizeLineEndings(suffix);
        this._scope = scope;
        this._choices = completions.map(c => ({
            completionText: c.completionText,
            finishReason: c.finishReason ?? finishReason,
            isMiddleOfTheLine: c.isMiddleOfTheLine,
            displayNeedsWsOffset: c.displayNeedsWsOffset,
            suffixCoverage: c.suffixCoverage,
        }));
        this._activeCompletionText = this._choices[0]?.completionText;
    }

    /** Update acceptance bookkeeping to the candidate VS Code actually rendered. */
    setActiveCompletion(completionText: string): void {
        if (this._choices.some(choice => choice.completionText === completionText)) {
            this._activeCompletionText = completionText;
        }
    }

    /** Match follow-up typing against the text VS Code actually inserted. */
    setRenderedCompletion(completionText: string, prefix: string, suffix: string, text: string, followUpChoice?: GhostCompletion): void {
        let choice = this._choices.find(item => item.completionText === completionText);
        // Typing-as-suggested items contain only the remaining text. A cached
        // alternative shown after partial typing may therefore have no match
        // among the original full-length choices. Track what VS Code displayed
        // so subsequent keystrokes continue that selected alternative.
        if (!choice && followUpChoice && this._prefix !== undefined && this._choices.length > 0) {
            this._choices = this._choices.filter(item => !item.followUp);
            choice = {
                completionText,
                finishReason: followUpChoice.finishReason,
                isMiddleOfTheLine: followUpChoice.isMiddleOfTheLine,
                displayNeedsWsOffset: followUpChoice.displayNeedsWsOffset,
                suffixCoverage: followUpChoice.suffixCoverage,
                followUp: true,
            };
            this._choices.push(choice);
        }
        if (!choice) return;
        this._activeCompletionText = completionText;
        choice.rendered = {
            prefix: normalizeLineEndings(prefix),
            suffix: normalizeLineEndings(suffix),
            text: normalizeLineEndings(text),
        };
    }

    getCompletionsForUserTyping(prefix: string, suffix: string, scope = ''): GhostCompletion[] | undefined {
        const active = this._activeChoice();
        const trajectory = this._matchingTrajectory(prefix, suffix, scope, active);
        if (!trajectory) return;
        const activeText = normalizeLineEndings(trajectory.rendered
            ? active?.rendered?.text ?? active?.completionText ?? ''
            : active?.completionText ?? '');
        if (!activeText || !this._startsWithAndExceeds(activeText, trajectory.remainingPrefix)) return;
        const adjusted = this._adjustChoicesStart(trajectory.remainingPrefix, active, trajectory.rendered);
        return adjusted.length > 0 ? adjusted : undefined;
    }

    hasAcceptedCurrentCompletion(prefix: string, suffix: string, scope = ''): boolean {
        const active = this._activeChoice();
        const trajectory = this._matchingTrajectory(prefix, suffix, scope, active);
        if (!trajectory) return false;
        const exactMatch = trajectory.remainingPrefix === normalizeLineEndings(trajectory.rendered
            ? active?.rendered?.text ?? active?.completionText ?? ''
            : active?.completionText ?? '');
        const finishReason = active?.finishReason;
        return exactMatch && finishReason === 'stop';
    }

    // Keep the original URI-based methods for compatibility
    setGhostText_original(uri: vscode.Uri, version: number, completionText: string): void {
        this._state = { completionText, uri, version };
    }

    getCompletionsForUserTyping_original(
        uri: vscode.Uri,
        version: number,
    ): string | undefined {
        if (!this._state) return undefined;
        if (this._state.uri.toString() !== uri.toString()) return undefined;
        if (this._state.version !== version) return undefined;
        return this._state.completionText;
    }

    hasAcceptedCurrentCompletion_original(): boolean {
        return this._afterExplicitAccept;
    }

    markExplicitlyAccepted(): void {
        this._afterExplicitAccept = true;
    }

    /** Reject only the suggestion still tracked as visible; keep a newer request alive. */
    rejectShownCompletion(completionText: string): void {
        if (this.clientCompletionId !== completionText) return;
        const pendingRequestId = this.currentRequestId;
        this.clear();
        this.currentRequestId = pendingRequestId;
    }

    clear(): void {
        this._state = undefined;
        this._prefix = undefined;
        this._suffix = undefined;
        this._scope = '';
        this._choices = [];
        this._activeCompletionText = undefined;
        this._afterExplicitAccept = false;
        this.currentRequestId = undefined;
    }

    private _activeChoice(): TrackedCompletion | undefined {
        return this._choices.find(choice => choice.completionText === this._activeCompletionText)
            ?? this._choices[0];
    }

    private _matchingTrajectory(
        prefix: string, suffix: string, scope: string, active: TrackedCompletion | undefined,
    ): { remainingPrefix: string; rendered: boolean } | undefined {
        if (this._prefix === undefined || this._suffix === undefined || this._choices.length === 0) { return; }
        if (this._scope !== scope) { return; }
        const normalizedPrefix = normalizeLineEndings(prefix);
        const normalizedSuffix = normalizeLineEndings(suffix);
        const rendered = active?.rendered;
        if (rendered && rendered.suffix === normalizedSuffix && normalizedPrefix.startsWith(rendered.prefix)) {
            return { remainingPrefix: normalizedPrefix.substring(rendered.prefix.length), rendered: true };
        }
        // Typing beside a middle-of-line ghost leaves the original suffix in
        // the document. Accepting that ghost consumes its covered suffix.
        if (this._suffix === normalizedSuffix && normalizedPrefix.startsWith(this._prefix)) {
            return { remainingPrefix: normalizedPrefix.substring(this._prefix.length), rendered: false };
        }
        return undefined;
    }

    private _startsWithAndExceeds(text: string, prefix: string): boolean {
        return text.startsWith(prefix) && text.length > prefix.length;
    }

    private _adjustChoicesStart(remainingPrefix: string, active: TrackedCompletion | undefined, useRendered: boolean): GhostCompletion[] {
        const rendered = active?.rendered;
        const rawAlternativesMatch = !rendered || (rendered.prefix === this._prefix
            && rendered.suffix === this._suffix && rendered.text === normalizeLineEndings(active?.completionText ?? ''));
        const activeRawText = normalizeLineEndings(active?.completionText ?? '');
        const rawOffset = rendered && activeRawText ? rendered.text.indexOf(activeRawText) : -1;
        // Inline completion ranges often begin at column zero, so VS Code
        // displays the existing line prefix together with the model's text.
        // Reapply that fixed wrapper to alternatives when the active raw text
        // occurs exactly once and the candidates cover the same suffix.
        const canWrapAlternatives = !active?.followUp && rendered && rawOffset >= 0
            && rendered.text.indexOf(activeRawText, rawOffset + 1) < 0
            && rendered.prefix + rendered.text.slice(0, rawOffset) === this._prefix;
        const leadingText = canWrapAlternatives ? rendered.text.slice(0, rawOffset) : '';
        const trailingText = canWrapAlternatives ? rendered.text.slice(rawOffset + activeRawText.length) : '';
        const choices = active ? [active, ...this._choices.filter(choice => choice !== active)] : this._choices;
        return choices
            .map(choice => {
                const rawText = normalizeLineEndings(choice.completionText);
                if (!useRendered || rawAlternativesMatch) return { choice, text: rawText };
                if (choice.rendered?.prefix === rendered?.prefix && choice.rendered?.suffix === rendered?.suffix) {
                    return { choice, text: choice.rendered!.text };
                }
                if (choice === active) return { choice, text: rendered?.text ?? rawText };
                if (canWrapAlternatives && choice.suffixCoverage === active?.suffixCoverage
                    && choice.isMiddleOfTheLine === active.isMiddleOfTheLine
                    && choice.displayNeedsWsOffset === active.displayNeedsWsOffset) {
                    return { choice, text: leadingText + rawText + trailingText };
                }
                return undefined;
            })
            .filter((value): value is { choice: TrackedCompletion; text: string } =>
                value !== undefined && this._startsWithAndExceeds(value.text, remainingPrefix))
            .map(({ choice: c, text }, i) => ({
                completionIndex: i,
                completionText: text.substring(remainingPrefix.length),
                displayText: text.substring(remainingPrefix.length),
                finishReason: c.finishReason,
                displayNeedsWsOffset: c.displayNeedsWsOffset,
                isMiddleOfTheLine: c.isMiddleOfTheLine,
                suffixCoverage: c.suffixCoverage,
            }));
    }
}

function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n|\r/g, '\n');
}

export class LastGhostText {
    resetState(): void {}
}
