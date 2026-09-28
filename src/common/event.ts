// Minimal stub: provides only what the DI code needs

import type { IDisposable, DisposableStore } from './lifecycle';

export interface Event<T> {
	(listener: (e: T) => unknown, thisArgs?: any, disposables?: IDisposable[] | DisposableStore): IDisposable;
}
