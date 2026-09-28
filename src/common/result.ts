// Simple Result type that supports the patterns used in promptCrafting.ts:
//   if (r.isError()) { return r; }   -- return value from error path
//   const val = r.val;                -- access value after error check

type _ResultDiscriminant = { readonly _isOk: true; readonly _val: unknown } | { readonly _isOk: false; readonly _err: unknown };

export class Result<T, E> {
    static ok<T, E>(val: T): Result<T, E> {
        return new Result<T, E>(true, val as unknown, undefined as unknown as E);
    }
    static error<T, E>(err: E): Result<T, E> {
        return new Result<T, E>(false, undefined as unknown as T, err);
    }

    readonly _isOk: boolean;
    private readonly _val: unknown;
    private readonly _err: unknown;

    private constructor(isOk: boolean, val: unknown, err: unknown) {
        this._isOk = isOk;
        this._val = val;
        this._err = err;
    }

    get val(): T {
        if (!this._isOk) {
            throw new Error('Cannot get value from error result');
        }
        return this._val as T;
    }

    get err(): E {
        if (this._isOk) {
            throw new Error('Cannot get error from ok result');
        }
        return this._err as E;
    }

    isOk(): this is Result<T, never> {
        return this._isOk;
    }

    isError(): this is Result<never, E> {
        return !this._isOk;
    }

    map<U>(fn: (val: T) => U): Result<U, E> {
        if (this._isOk) {
            return Result.ok<U, E>(fn(this._val as T));
        }
        return Result.error<U, E>(this._err as E);
    }
}
