/** Reserve a usable input half when a custom model's output setting exceeds its window. */
export function effectiveNesOutputTokens(contextWindow: number | undefined, configuredOutput: number | undefined): number {
    const window = Number.isFinite(contextWindow) && (contextWindow ?? 0) > 0
        ? Math.floor(contextWindow!) : 128_000;
    const configured = Number.isFinite(configuredOutput) && (configuredOutput ?? 0) > 0
        ? Math.floor(configuredOutput!) : 9_216;
    return Math.max(1, Math.min(configured, Math.floor(window / 2)));
}
