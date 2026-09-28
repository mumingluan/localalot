export function range(start: number, endExclusive: number): number[] {
    const result: number[] = [];
    for (let i = start; i < endExclusive; i++) {
        result.push(i);
    }
    return result;
}

export function pushMany<T>(target: T[], source: readonly T[]): void {
    target.push(...source);
}

export function groupAdjacentBy<T>(items: readonly T[], areAdjacent: (left: T, right: T) => boolean): T[][] {
    if (items.length === 0) {
        return [];
    }
    const result: T[][] = [];
    let currentGroup: T[] = [items[0]];
    for (let i = 1; i < items.length; i++) {
        if (areAdjacent(items[i - 1], items[i])) {
            currentGroup.push(items[i]);
        } else {
            result.push(currentGroup);
            currentGroup = [items[i]];
        }
    }
    result.push(currentGroup);
    return result;
}

export function batchArrayElements<T>(arr: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < arr.length; i += batchSize) {
        batches.push(arr.slice(i, i + batchSize));
    }
    return batches;
}
