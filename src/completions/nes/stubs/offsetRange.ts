export class OffsetRange {
    constructor(
        public readonly start: number,
        public readonly endExclusive: number,
    ) { }

    get length(): number {
        return this.endExclusive - this.start;
    }

    deltaStart(delta: number): OffsetRange {
        return new OffsetRange(this.start + delta, this.endExclusive);
    }

    deltaEnd(delta: number): OffsetRange {
        return new OffsetRange(this.start, this.endExclusive + delta);
    }

    contains(value: number): boolean {
        return value >= this.start && value < this.endExclusive;
    }

    intersect(other: OffsetRange): OffsetRange | undefined {
        const start = Math.max(this.start, other.start);
        const end = Math.min(this.endExclusive, other.endExclusive);
        if (start >= end) {
            return undefined;
        }
        return new OffsetRange(start, end);
    }
}
