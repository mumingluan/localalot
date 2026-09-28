const STOP_WORDS = new Set([
    'const', 'let', 'var', 'function', 'return', 'class', 'interface', 'type', 'import', 'from',
    'export', 'default', 'async', 'await', 'true', 'false', 'null', 'undefined', 'new', 'this',
    'if', 'else', 'for', 'while', 'switch', 'case', 'try', 'catch', 'throw', 'private', 'public',
    'a', 'an', 'the', 'and', 'or', 'to', 'of', 'in', 'on', 'at', 'by', 'with', 'as', 'is',
    'are', 'was', 'were', 'be', 'been', 'it', 'its', 'we', 'our', 'you', 'they', 'them',
    'their', 'that', 'these', 'those', 'do', 'does', 'did', 'can', 'will', 'would',
    'should', 'not', 'no', 'all', 'any', 'each', 'some', 'only', 'same', 'so', 'than',
]);

// Copilot's similar-file matcher includes numeric tokens. Ports, status codes,
// and version numbers often distinguish otherwise similar YAML/JSON blocks.
const IDENTIFIER = /[\p{L}\p{N}_$]+/gu;
const TOKENIZED_LINES = new WeakMap<readonly string[], readonly Set<string>[]>();
const DOCUMENT_LINES = new WeakMap<object, { version: number; lines: string[] }>();
const EMPTY_TOKENS = new Set<string>();

/** Reuse immutable line snapshots until VS Code increments the document version. */
export function cachedLexicalLines(document: { version: number; getText(): string }): readonly string[] {
    const cached = DOCUMENT_LINES.get(document);
    if (cached?.version === document.version) return cached.lines;
    const lines = document.getText().split(/\r?\n/);
    DOCUMENT_LINES.set(document, { version: document.version, lines });
    return lines;
}

function tokensForLines(lines: readonly string[]): readonly Set<string>[] {
    const cached = TOKENIZED_LINES.get(lines);
    if (cached) return cached;
    const tokens = lines.map(line => {
        const matches = line.match(IDENTIFIER);
        return matches?.length
            ? new Set(matches.map(token => token.toLowerCase()).filter(token => !STOP_WORDS.has(token)))
            : EMPTY_TOKENS;
    });
    TOKENIZED_LINES.set(lines, tokens);
    return tokens;
}

/** Keep the identifiers nearest the caret, where they best describe this completion. */
export function lexicalFocus(prefix: string): string[] {
    // Native similar-file matching uses the 60 lines before the cursor. A
    // character-only cutoff loses a relevant key or symbol after a few long
    // lines (common in YAML manifests and generated configuration).
    let start = Math.max(0, prefix.length - 12_000);
    let lineBreaks = 0;
    for (let index = prefix.length - 1; index >= start; index--) {
        if (prefix[index] === '\n' && ++lineBreaks === 60) {
            start = index + 1;
            break;
        }
    }
    const context = prefix.slice(start);
    const tokens = (context.match(IDENTIFIER) ?? []).map(token => token.toLowerCase());
    const result: string[] = [];
    const seen = new Set<string>();
    for (let i = tokens.length - 1; i >= 0 && result.length < 256; i--) {
        const token = tokens[i];
        if (STOP_WORDS.has(token) || seen.has(token)) continue;
        seen.add(token);
        result.push(token);
    }
    return result;
}

export interface LexicalWindow {
    snippet: string;
    startLine: number;
    anchorLine: number;
    score: number;
}

/** Find a relevant code window anywhere in a bounded open document. */
export function selectLexicalWindow(
    lines: readonly string[],
    focus: readonly string[],
    maxChars = 1_200,
): LexicalWindow | undefined {
    if (focus.length === 0 || maxChars <= 0) return undefined;
    const focusWeights = new Map(focus.map((term, index) => [term, index === 0 ? 3 : index < 4 ? 2 : 1]));
    const lineTokens = tokensForLines(lines);
    const lineCount = lineTokens.length;
    const windowLength = Math.min(lineCount, 60);
    const lineScores: number[] = [];
    const windowTokens = new Map<string, number>();
    let intersection = 0;
    let bestStart = -1;
    let bestScore = 0;
    for (let line = 0; line < lineCount; line++) {
        const tokens = lineTokens[line];
        let lineScore = 0;
        for (const token of tokens) {
            lineScore += focusWeights.get(token) ?? 0;
            const previous = windowTokens.get(token) ?? 0;
            windowTokens.set(token, previous + 1);
            if (previous === 0 && focusWeights.has(token)) intersection++;
        }
        lineScores.push(lineScore);
        if (line >= windowLength) {
            for (const token of lineTokens[line - windowLength]) {
                const count = windowTokens.get(token)! - 1;
                if (count === 0) {
                    windowTokens.delete(token);
                    if (focusWeights.has(token)) intersection--;
                }
                else windowTokens.set(token, count);
            }
        }
        if (line + 1 < windowLength) continue;
        if (intersection === 0) continue;
        const union = focusWeights.size + windowTokens.size - intersection;
        // Match the native similar-file ranking: extra unrelated identifiers
        // reduce the value of a window even when it hits several cursor words.
        const score = union > 0 ? intersection / union : 0;
        if (score > bestScore) {
            bestScore = score;
            bestStart = line - windowLength + 1;
        }
    }
    if (bestStart < 0) return undefined;
    let bestLine = bestStart;
    for (let line = bestStart + 1; line < bestStart + windowLength; line++) {
        if (lineScores[line] > lineScores[bestLine]) bestLine = line;
    }
    let start = bestStart;
    while (start < bestLine && lines.slice(start, bestLine).join('\n').length > Math.floor(maxChars / 4)) start++;
    const end = Math.min(lines.length, Math.max(bestStart + windowLength, bestLine + 6));
    const fullSnippet = lines.slice(start, end).join('\n');
    const focusRanks = new Map(focus.map((term, index) => [term, index]));
    let anchorMatch = 0;
    let anchorRank = Number.POSITIVE_INFINITY;
    for (const match of lines[bestLine].matchAll(IDENTIFIER)) {
        const rank = focusRanks.get(match[0].toLowerCase());
        if (rank !== undefined && rank < anchorRank) {
            anchorMatch = match.index;
            anchorRank = rank;
        }
    }
    const anchorOffset = lines.slice(start, bestLine).reduce((length, line) => length + line.length + 1, 0)
        + anchorMatch;
    const clipStart = fullSnippet.length > maxChars && anchorOffset > maxChars * 0.6
        ? Math.max(0, anchorOffset - Math.floor(maxChars / 3))
        : 0;
    const marker = clipStart > 0 ? '…' : '';
    const clippedSnippet = marker + fullSnippet.slice(clipStart, clipStart + maxChars - marker.length);
    const clippedStartLine = start + (fullSnippet.slice(0, clipStart).match(/\n/g)?.length ?? 0);
    return {
        snippet: clippedSnippet,
        startLine: clippedStartLine,
        anchorLine: bestLine,
        score: bestScore,
    };
}
