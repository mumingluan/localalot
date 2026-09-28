import { LRUCacheMap } from '../../common/lruCacheMap';
import { ReplaySubject } from '../../common/subject';
import { Deferred } from '../../common/async';
import { createServiceIdentifier } from '../../di/services';

export const IAsyncCompletionsManager = createServiceIdentifier<IAsyncCompletionsManager>('IAsyncCompletionsManager');

export interface IAsyncCompletionsManager {
    readonly _serviceBrand: undefined;
    shouldWaitForAsyncCompletions(prefix: string, suffix: string, scope?: string): boolean;
    updateCompletion(headerRequestId: string, text: string): void;
    queueCompletionRequest(
        headerRequestId: string,
        prefix: string,
        suffix: string,
        cancellationTokenSource: { cancel(): void },
        resultPromise: Promise<AsyncCompletionResult>,
        scope?: string,
        resourceKey?: string,
    ): Promise<void>;
    getFirstMatchingRequest(
        headerRequestId: string,
        prefix: string,
        suffix: string,
        timeoutMs?: number,
        scope?: string,
        signal?: AbortSignal,
        resourceKey?: string,
        isSpeculative?: boolean,
    ): Promise<AsyncCompletionResult | undefined>;
    hasActiveWaiters(headerRequestId?: string): boolean;
    cancelStaleRequests(headerRequestId: string, resourceKey?: string): void;
    clear(): void;
}

export interface AsyncCompletionResult {
    completionText: string;
    finishReason: string;
}

enum AsyncCompletionRequestState {
    Pending,
    Completed,
}

interface BaseAsyncCompletionRequest {
    cancellationTokenSource: { cancel(): void };
    headerRequestId: string;
    prefix: string;
    suffix: string;
    scope: string;
    resourceKey: string;
    subject: ReplaySubject<AsyncCompletionRequest>;
    partialCompletionText?: string;
}

interface PendingAsyncCompletionRequest extends BaseAsyncCompletionRequest {
    state: AsyncCompletionRequestState.Pending;
}

interface CompletedAsyncCompletionRequest extends BaseAsyncCompletionRequest {
    state: AsyncCompletionRequestState.Completed;
    result: AsyncCompletionResult;
}

type AsyncCompletionRequest = PendingAsyncCompletionRequest | CompletedAsyncCompletionRequest;

export class AsyncCompletionsManager implements IAsyncCompletionsManager {
    readonly _serviceBrand: undefined;

    private readonly _requests = new LRUCacheMap<string, AsyncCompletionRequest>(100);

    /** Only the latest requester for a document can cancel its stale stream. */
    private readonly _mostRecentRequestIds = new Map<string, string>();

    /** Count of active waiters in getFirstMatchingRequest — prevents abort while subscribers exist. */
    private _activeWaiterCount = 0;
    private readonly _waitersByRequest = new Map<string, number>();

    hasActiveWaiters(headerRequestId?: string): boolean {
        return headerRequestId === undefined
            ? this._activeWaiterCount > 0
            : (this._waitersByRequest.get(headerRequestId) ?? 0) > 0;
    }

    shouldWaitForAsyncCompletions(prefix: string, suffix: string, scope = ''): boolean {
        for (const [, request] of this._requests) {
            if (_isCandidate(prefix, suffix, scope, request)) {
                return true;
            }
        }
        return false;
    }

    updateCompletion(headerRequestId: string, text: string): void {
        const request = this._requests.get(headerRequestId);
        if (!request) return;
        request.partialCompletionText = text;
        request.subject.next(request);
    }

    queueCompletionRequest(
        headerRequestId: string,
        prefix: string,
        suffix: string,
        cts: { cancel(): void },
        resultPromise: Promise<AsyncCompletionResult>,
        scope = '',
        resourceKey = scope,
    ): Promise<void> {
        const subject = new ReplaySubject<AsyncCompletionRequest>();
        const pendingRequest: PendingAsyncCompletionRequest = {
            state: AsyncCompletionRequestState.Pending,
            cancellationTokenSource: cts,
            headerRequestId,
            prefix,
            suffix,
            scope,
            resourceKey,
            subject,
        };
        this._requests.set(headerRequestId, pendingRequest);

        return resultPromise
            .then(result => {
                // A stale request may settle after cancellation. It must not
                // resurrect its result in the reusable in-flight cache.
                if (this._requests.get(headerRequestId) !== pendingRequest) {
                    subject.complete();
                    return;
                }
                this._requests.delete(headerRequestId);
                const completed: CompletedAsyncCompletionRequest = {
                    state: AsyncCompletionRequestState.Completed,
                    cancellationTokenSource: cts,
                    headerRequestId,
                    prefix,
                    suffix,
                    scope,
                    resourceKey,
                    subject,
                    result,
                };
                this._requests.set(headerRequestId, completed);
                subject.next(completed);
                subject.complete();
            })
            .catch(() => {
                if (this._requests.get(headerRequestId) === pendingRequest) this._requests.delete(headerRequestId);
                subject.error(new Error('Request failed'));
            });
    }

    async getFirstMatchingRequest(
        headerRequestId: string,
        prefix: string,
        suffix: string,
        timeoutMs = -1,
        scope = '',
        signal?: AbortSignal,
        resourceKey = scope,
        isSpeculative = false,
    ): Promise<AsyncCompletionResult | undefined> {
        if (signal?.aborted) return undefined;
        // Prefetch can reuse a visible stream, but only a visible editor
        // request may supersede and cancel another request for this file.
        if (!isSpeculative) this._mostRecentRequestIds.set(resourceKey, headerRequestId);
        this._activeWaiterCount++;
        let resolved = false;
        const deferred = new Deferred<AsyncCompletionResult | undefined>();
        const subscriptions = new Map<string, () => void>();
        const cancelWait = () => {
            if (!resolved) {
                resolved = true;
                deferred.resolve(undefined);
            }
        };
        signal?.addEventListener('abort', cancelWait, { once: true });
        if (signal?.aborted) cancelWait();

        const finishRequest = (id: string) => () => {
            const subscription = subscriptions.get(id);
            if (subscription === undefined) return;
            subscription();
            subscriptions.delete(id);
            this._removeWaiter(id);
            if (!resolved && subscriptions.size === 0) {
                resolved = true;
                deferred.resolve(undefined);
            }
        };

        const next = (request: AsyncCompletionRequest) => {
            if (_isCandidate(prefix, suffix, scope, request)) {
                if (request.state === AsyncCompletionRequestState.Completed) {
                    const remainingPrefix = prefix.substring(request.prefix.length);
                    let { completionText } = request.result;
                    if (
                        !completionText.startsWith(remainingPrefix) ||
                        completionText.length <= remainingPrefix.length
                    ) {
                        finishRequest(request.headerRequestId)();
                        return;
                    }
                    completionText = completionText.substring(remainingPrefix.length);
                    deferred.resolve({ ...request.result, completionText });
                    resolved = true;
                }
            } else {
                this._cancelStaleRequest(headerRequestId, request, resourceKey);
                finishRequest(request.headerRequestId)();
            }
        };

        for (const [id, request] of this._requests) {
            if (_isCandidate(prefix, suffix, scope, request)) {
                this._waitersByRequest.set(id, (this._waitersByRequest.get(id) ?? 0) + 1);
                subscriptions.set(
                    id,
                    request.subject.subscribe({
                        next,
                        error: finishRequest(id),
                        complete: finishRequest(id),
                    })
                );
            } else {
                this._cancelStaleRequest(headerRequestId, request, resourceKey);
            }
        }

        // A candidate can disappear between the caller's preliminary check
        // and this subscription pass. Do not leave that caller waiting forever.
        if (subscriptions.size === 0 && !resolved) {
            resolved = true;
            deferred.resolve(undefined);
        }

        const timeout = timeoutMs >= 0
            ? setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    deferred.resolve(undefined);
                }
            }, timeoutMs)
            : undefined;

        return deferred.promise.finally(() => {
            signal?.removeEventListener('abort', cancelWait);
            if (timeout !== undefined) clearTimeout(timeout);
            this._activeWaiterCount--;
            for (const [id, dispose] of subscriptions) {
                dispose();
                this._removeWaiter(id);
            }
        });
    }

    private _removeWaiter(id: string): void {
        const count = this._waitersByRequest.get(id) ?? 0;
        if (count <= 1) this._waitersByRequest.delete(id);
        else this._waitersByRequest.set(id, count - 1);
    }

    cancelStaleRequests(headerRequestId: string, resourceKey = this._requests.get(headerRequestId)?.resourceKey): void {
        if (resourceKey === undefined) return;
        this._mostRecentRequestIds.set(resourceKey, headerRequestId);
        for (const [, request] of this._requests) {
            this._cancelStaleRequest(headerRequestId, request, resourceKey);
        }
    }

    clear(): void {
        for (const [, request] of this._requests) {
            if (request.state === AsyncCompletionRequestState.Pending) request.cancellationTokenSource.cancel();
            request.subject.complete();
        }
        this._requests.clear();
        this._mostRecentRequestIds.clear();
    }

    private _cancelStaleRequest(headerRequestId: string, request: AsyncCompletionRequest, resourceKey?: string): void {
        if (resourceKey === undefined || request.resourceKey !== resourceKey) return;
        if (headerRequestId !== this._mostRecentRequestIds.get(resourceKey)) return;
        if (request.state === AsyncCompletionRequestState.Completed) return;
        request.cancellationTokenSource.cancel();
        this._requests.delete(request.headerRequestId);
        request.subject.complete();
    }
}

function _isCandidate(prefix: string, suffix: string, scope: string, request: AsyncCompletionRequest): boolean {
    if (request.scope !== scope) return false;
    if (request.suffix !== suffix) return false;
    if (!prefix.startsWith(request.prefix)) return false;
    const remainingPrefix = prefix.substring(request.prefix.length);
    if (request.state === AsyncCompletionRequestState.Completed) {
        return (
            request.result.completionText.startsWith(remainingPrefix) &&
            request.result.completionText.trimEnd().length > remainingPrefix.length
        );
    }
    if (request.partialCompletionText === undefined) return true;
    // The user can type ahead of a slow stream. The unseen tail is still
    // compatible until the text received so far actually disagrees.
    return request.partialCompletionText.startsWith(remainingPrefix)
        || remainingPrefix.startsWith(request.partialCompletionText);
}
