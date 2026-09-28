import { Position } from './position';
import { OffsetRange } from './offsetRange';

export class PositionOffsetTransformer {
    private readonly lineOffsets: number[];

    constructor(private readonly text: string) {
        this.lineOffsets = [0];
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '\n') {
                this.lineOffsets.push(i + 1);
            } else if (text[i] === '\r' && i + 1 < text.length && text[i + 1] === '\n') {
                this.lineOffsets.push(i + 2);
                i++; // skip \n
            }
        }
    }

    getOffset(position: Position): number {
        const lineOffset = this.lineOffsets[position.lineNumber - 1];
        if (lineOffset === undefined) {
            return this.text.length;
        }
        return lineOffset + position.column - 1;
    }

    getPosition(offset: number): Position {
        let lineIndex = 0;
        for (let i = this.lineOffsets.length - 1; i >= 0; i--) {
            if (this.lineOffsets[i] <= offset) {
                lineIndex = i;
                break;
            }
        }
        return new Position(lineIndex + 1, offset - this.lineOffsets[lineIndex] + 1);
    }

    getOffsetRange(range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }): OffsetRange {
        const start = this.getOffset(new Position(range.startLineNumber, range.startColumn));
        const end = this.getOffset(new Position(range.endLineNumber, range.endColumn));
        return new OffsetRange(start, end);
    }
}
