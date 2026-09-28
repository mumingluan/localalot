// Minimal stub: provides only what the DI code needs

export interface IDisposable {
	dispose(): void;
}

export function isDisposable<E>(thing: E): thing is E & IDisposable {
	return typeof thing === 'object' && thing !== null && typeof (thing as unknown as IDisposable).dispose === 'function' && (thing as unknown as IDisposable).dispose.length === 0;
}

export function dispose<T extends IDisposable>(disposables: Iterable<T | undefined>): void {
	for (const d of disposables) {
		if (d) {
			d.dispose();
		}
	}
}

export function toDisposable(fn: () => void): IDisposable {
	let disposed = false;
	return {
		dispose() {
			if (!disposed) {
				disposed = true;
				fn();
			}
		}
	};
}

export class DisposableStore implements IDisposable {
	private readonly _toDispose = new Set<IDisposable>();
	private _isDisposed = false;

	dispose(): void {
		if (this._isDisposed) {
			return;
		}
		this._isDisposed = true;
		dispose(this._toDispose);
		this._toDispose.clear();
	}

	get isDisposed(): boolean {
		return this._isDisposed;
	}

	add<T extends IDisposable>(o: T): T {
		if (!o) {
			return o;
		}
		if (this._isDisposed) {
			console.warn('Trying to add a disposable to a DisposableStore that has already been disposed of.');
		} else {
			this._toDispose.add(o);
		}
		return o;
	}
}
