export class LRUCacheMap<K, V> {
    private readonly _map = new Map<K, V>();
    private readonly _maxSize: number;

    constructor(maxSize: number) {
        this._maxSize = maxSize;
    }

    get(key: K): V | undefined {
        const value = this._map.get(key);
        if (value !== undefined) {
            // Move to end (most recently used)
            this._map.delete(key);
            this._map.set(key, value);
        }
        return value;
    }

    set(key: K, value: V): void {
        if (this._map.has(key)) {
            this._map.delete(key);
        } else if (this._map.size >= this._maxSize) {
            // Delete least recently used (first entry)
            const firstKey = this._map.keys().next().value;
            if (firstKey !== undefined) {
                this._map.delete(firstKey);
            }
        }
        this._map.set(key, value);
    }

    delete(key: K): boolean {
        return this._map.delete(key);
    }

    clear(): void {
        this._map.clear();
    }

    get size(): number {
        return this._map.size;
    }

    [Symbol.iterator](): IterableIterator<[K, V]> {
        return this._map[Symbol.iterator]();
    }
}
