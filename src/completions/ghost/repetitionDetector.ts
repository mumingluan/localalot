/** Remove a degenerate repeated tail while retaining any useful prefix. */
export function trimRepetitiveTail(text: string): string {
    const clean = text.trimEnd();
    const lines = clean.split(/\r?\n/);
    const normalized = lines.map(line => line.trimEnd());
    for (let patternLength = 1; patternLength <= 3; patternLength++) {
        const minimumRepeats = patternLength === 1 ? 8 : 4;
        if (lines.length < patternLength * minimumRepeats) continue;
        const pattern = normalized.slice(-patternLength);
        if (pattern.every(line => !line.trim())) continue;
        let start = lines.length - patternLength;
        while (start >= patternLength && pattern.every((line, index) =>
            normalized[start - patternLength + index] === line)) {
            start -= patternLength;
        }
        if ((lines.length - start) / patternLength >= minimumRepeats) {
            return lines.slice(0, start).join('\n').trimEnd();
        }
    }
    return text;
}

/** Whether the generated completion ends in a long repeated line pattern. */
export function isRepetitiveCompletion(text: string): boolean {
    return trimRepetitiveTail(text) !== text;
}
