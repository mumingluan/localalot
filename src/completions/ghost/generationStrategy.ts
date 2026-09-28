import { BlockPositionType } from './blockTrimmer';
import { nativeBlockMode } from './multiline/nativeBlockMode';

export interface GhostGenerationOptions {
    maxTokens: number;
    stop: string[];
}

/** A forced post-accept follow-up uses the native short line budget. */
export function shouldTrimByIndentation(languageId: string, forcedFollowUp = false): boolean {
    const mode = nativeBlockMode(languageId);
    return (mode === 'parsingAndServer' || mode === 'server') && !forcedFollowUp;
}

/** Native cache/async reuse keeps the first generated line in single-line mode. */
export function choiceTextForLineMode(text: string, multiline: boolean): string {
    if (multiline) return text;
    const initialLineBreak = text.match(/^\r?\n/);
    return initialLineBreak
        ? initialLineBreak[0] + text.slice(initialLineBreak[0].length).split(/\r?\n/, 1)[0]
        : text.split(/\r?\n/, 1)[0];
}

/** A streamed single-line choice is complete only after its display line ends. */
export function completedSingleLineText(text: string): string | undefined {
    const firstBreak = text.indexOf('\n');
    if (firstBreak < 0) return undefined;
    const startsWithBreak = firstBreak === 0 || (firstBreak === 1 && text[0] === '\r');
    const end = startsWithBreak ? text.indexOf('\n', firstBreak + 1) : firstBreak;
    if (end < 0) return undefined;
    return text.slice(0, end).replace(/\r$/, '');
}

export function getGhostGenerationOptions(
    multiline: boolean,
    configuredMaxTokens: number,
    configuredStops: readonly string[],
    afterAccept = false,
    multilineAfterAcceptLines = 1,
    _blockPosition?: BlockPositionType,
    languageId?: string,
): GhostGenerationOptions {
    const maxTokens = Math.max(1, Math.floor(configuredMaxTokens));
    // Native MoreMultiline clips its first display line locally. Parser-mode
    // single-line requests use a wire stop; server-mode structured data stays
    // multiline so its leading newline can start a child node.
    const multilineStops = configuredStops.filter(stop => stop !== '\n' && stop !== '\r\n');
    if (afterAccept) {
        return {
            maxTokens: Math.min(maxTokens, 20 * Math.max(1, multilineAfterAcceptLines)),
            stop: ['\n\n', ...(configuredStops.length > 0 ? multilineStops : [])],
        };
    }
    const mode = languageId ? nativeBlockMode(languageId) : 'server';
    const singleLineServerStop = !multiline && configuredStops.length === 0
        && (mode === 'parsing' || mode === 'parsingAndServer');
    return {
        maxTokens,
        stop: singleLineServerStop ? ['\n'] : [...new Set(multiline || (languageId !== undefined && mode === 'server') ? multilineStops : configuredStops)],
    };
}
