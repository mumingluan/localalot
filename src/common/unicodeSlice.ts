/** Clip a UTF-16 string without creating a lone surrogate at the cut. */
export function sliceCompleteCodePoints(text: string, maxCodeUnits: number, fromEnd = false): string {
    const limit = Math.floor(maxCodeUnits);
    if (limit <= 0) return '';
    if (limit >= text.length) return text;
    const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
    const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;
    if (fromEnd) {
        let start = text.length - limit;
        if (isHigh(text.charCodeAt(start - 1)) && isLow(text.charCodeAt(start))) start++;
        return text.slice(start);
    }
    let end = limit;
    if (isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end))) end--;
    return text.slice(0, end);
}
