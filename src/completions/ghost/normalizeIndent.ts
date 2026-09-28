/** Editor indentation settings used by VS Code's native ghost-text provider. */
export interface GhostIndentOptions {
    tabSize?: number | string;
    insertSpaces?: boolean | string;
}

export interface NormalizedGhostText {
    completionText: string;
    displayText: string;
}

/**
 * Convert leading indentation to the active editor convention. This mirrors
 * Copilot's normalizeIndentCharacter behavior and leaves non-leading content
 * byte-for-byte unchanged.
 */
export function normalizeGhostIndent(
    completionText: string,
    displayText: string,
    options: GhostIndentOptions | undefined,
    isEmptyLine: boolean,
): NormalizedGhostText {
    if (!options) return { completionText, displayText };
    const tabSize = typeof options.tabSize === 'number' && options.tabSize > 0 ? options.tabSize : 4;

    const replaceLeading = (text: string, unit: ' ' | '\t', replacement: (count: number) => string): string => {
        const expression = new RegExp(`^(${unit === ' ' ? ' ' : '\\t'})+`);
        return text.split('\n').map(line => {
            const leading = line.match(expression)?.[0] ?? '';
            return replacement(leading.length) + line.slice(leading.length);
        }).join('\n');
    };

    let normalizedCompletion = completionText;
    let normalizedDisplay = displayText;
    if (options.insertSpaces === false) {
        const convert = (text: string) => replaceLeading(text, ' ', count => '\t'.repeat(Math.floor(count / tabSize)) + ' '.repeat(count % tabSize));
        normalizedCompletion = convert(normalizedCompletion);
        normalizedDisplay = convert(normalizedDisplay);
    } else if (options.insertSpaces === true) {
        const convert = (text: string) => replaceLeading(text, '\t', count => ' '.repeat(count * tabSize));
        normalizedCompletion = convert(normalizedCompletion);
        normalizedDisplay = convert(normalizedDisplay);
        if (isEmptyLine) {
            const roundIndent = (text: string): string => {
                const firstLine = text.split('\n', 1)[0];
                const spaces = firstLine.length - firstLine.trimStart().length;
                if (spaces === 0 || spaces % tabSize === 0) return text;
                const lines = text.split('\n');
                const levels = [...new Set(lines.map(line => line.match(/^ +/)?.[0].length ?? 0))]
                    .filter(level => level > 0).sort((a, b) => a - b);
                const roundedLevels = new Map<number, number>();
                let previous = 0;
                for (const level of levels) {
                    const nativeRounded = (Math.floor(level / tabSize) + 1) * tabSize;
                    // Distinct YAML/code nesting levels must stay distinct even
                    // if two raw widths round to the same tab stop.
                    const rounded = Math.max(nativeRounded, previous ? previous + tabSize : nativeRounded);
                    roundedLevels.set(level, rounded);
                    previous = rounded;
                }
                return lines.map(candidate => {
                    const leading = candidate.match(/^ +/)?.[0].length ?? 0;
                    return leading === 0
                        ? candidate
                        : ' '.repeat(roundedLevels.get(leading) ?? leading) + candidate.slice(leading);
                }).join('\n');
            };
            normalizedCompletion = roundIndent(normalizedCompletion);
            normalizedDisplay = roundIndent(normalizedDisplay);
        }
    }
    return { completionText: normalizedCompletion, displayText: normalizedDisplay };
}
