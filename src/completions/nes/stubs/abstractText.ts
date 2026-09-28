import { Position } from './position';
import { PositionOffsetTransformer } from './positionToOffsetImpl';

export class StringText {
    constructor(private readonly text: string) { }

    getLines(): string[] {
        return this.text.split(/\r?\n/);
    }

    getTransformer(): PositionOffsetTransformer {
        return new PositionOffsetTransformer(this.text);
    }

    toString(): string {
        return this.text;
    }

    lineCount(): number {
        return this.getLines().length;
    }
}
