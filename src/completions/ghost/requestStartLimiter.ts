/** Serializes request starts without cancelling another caller's wait. */
export class RequestStartLimiter {
    private _tail: Promise<void> = Promise.resolve();
    private _nextStart = 0;

    async wait(delayMs: number, isCancelled: () => boolean): Promise<boolean> {
        let release!: () => void;
        const previous = this._tail;
        this._tail = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try {
            if (isCancelled()) return false;
            const waitMs = Math.max(0, this._nextStart - Date.now());
            if (waitMs > 0) {
                await new Promise<void>(resolve => setTimeout(resolve, waitMs));
            }
            if (isCancelled()) return false;
            this._nextStart = Date.now() + Math.max(0, delayMs);
            return true;
        } finally {
            release();
        }
    }
}
