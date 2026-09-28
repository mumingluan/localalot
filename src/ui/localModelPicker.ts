/** Read OpenAI-compatible model IDs for the completion menu. */
export async function listLocalModelIds(baseUrl: string, apiKey: string): Promise<string[]> {
    let url: URL;
    try {
        url = new URL(`${baseUrl.trim().replace(/\/+$/, '')}/models`);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return [];
    } catch {
        return [];
    }
    try {
        const response = await fetch(url, {
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
            signal: AbortSignal.timeout(2500),
        });
        if (!response.ok) return [];
        const body = await response.json() as { data?: Array<{ id?: unknown }> };
        if (!Array.isArray(body?.data)) return [];
        return [...new Set(body.data
            .map(item => item?.id)
            .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
            .map(id => id.trim()))].slice(0, 200);
    } catch {
        return [];
    }
}
