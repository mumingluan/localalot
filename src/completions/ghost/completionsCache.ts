import { createServiceIdentifier } from '../../di/services';
import { LRURadixTrie } from './radix';

export const IGhostCompletionsCache = createServiceIdentifier<IGhostCompletionsCache>('IGhostCompletionsCache');

export interface IGhostCompletionsCache {
    readonly _serviceBrand: undefined;
    readonly revision: number;
    findAll(prefix: string, suffix: string, scope?: string): CompletionChoice[];
    append(prefix: string, suffix: string, choice: CompletionChoice, scope?: string): void;
    clear(): void;
}

export interface CompletionChoice {
    text: string;
    finishReason: string;
}

interface CacheContent{
    suffix: string;
    choice: CompletionChoice;
};

interface CacheContents {
    content: CacheContent[];
}

/** Caches recent completions by document prefix using a radix trie for prefix-aware matching. */
export class GhostCompletionsCache implements IGhostCompletionsCache {
    readonly _serviceBrand: undefined;
    private _revision = 0;

    get revision(): number { return this._revision; }

    private cache: LRURadixTrie<CacheContents>;
    private readonly _maxSize: number;

    constructor(maxSize: number = 100) {
        this._maxSize = maxSize;
        this.cache = new LRURadixTrie<CacheContents>(maxSize);
    }

    /** Given a document prefix and suffix, return all of the completions that match. */
    findAll(prefix: string, suffix: string, scope = ''): CompletionChoice[] {
        const seen = new Set<string>();
        return this.cache.findAll(`${scope}\u0000${prefix}`).flatMap(({ remainingKey, value }) =>
            value.content
                .filter((c: CacheContent)  =>
                    c.suffix === suffix &&
                    c.choice.text.startsWith(remainingKey) &&
                    c.choice.text.length > remainingKey.length
                )
                .map((c:CacheContent) => ({
                    ...c.choice,
                    text: c.choice.text.slice(remainingKey.length),
                }))
                .filter(choice => {
                    const key = `${choice.finishReason}\u0000${choice.text}`;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                })
        );
    }

    /** Add cached completions for a given prefix. */
    append(prefix: string, suffix: string, choice: CompletionChoice, scope = ''): void {
        const key = `${scope}\u0000${prefix}`;
        const existing = this.cache.findAll(key);
        // Append to an existing array if there is an exact match.
        if (existing.length > 0 && existing[0].remainingKey === '') {
            const content = existing[0].value.content;
            if (content.some(item => item.suffix === suffix && item.choice.text === choice.text
                && item.choice.finishReason === choice.finishReason)) return;
            this.cache.set(key, { content: [...content, { suffix, choice }] });
        } else {
            // Otherwise, add a new value.
            this.cache.set(key, { content: [{ suffix, choice }] });
        }
    }

    clear(): void {
        this._revision++;
        this.cache = new LRURadixTrie<CacheContents>(this._maxSize);
    }
}
