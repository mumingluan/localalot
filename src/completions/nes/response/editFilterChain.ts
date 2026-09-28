export interface IEditFilter {
    readonly name: string;
    shouldReject(editLines: string[], editWindowLines: string[]): boolean;
}

export class EmptyEditFilter implements IEditFilter {
    readonly name = 'EmptyEditFilter';

    shouldReject(editLines: string[], _editWindowLines: string[]): boolean {
        return editLines.every(l => l.trim() === '');
    }
}

export class NoopEditFilter implements IEditFilter {
    readonly name = 'NoopEditFilter';

    shouldReject(editLines: string[], editWindowLines: string[]): boolean {
        if (editLines.length !== editWindowLines.length) {
            return false;
        }
        return editLines.every((l, i) => l === editWindowLines[i]);
    }
}

export class WhitespaceOnlyFilter implements IEditFilter {
    readonly name = 'WhitespaceOnlyFilter';

    shouldReject(editLines: string[], editWindowLines: string[]): boolean {
        const nonWsEdit = editLines.join('').replace(/\s/g, '');
        const nonWsOrig = editWindowLines.join('').replace(/\s/g, '');
        return nonWsEdit === nonWsOrig;
    }
}

export class EditFilterChain {
    readonly filters: IEditFilter[];

    constructor(filters?: IEditFilter[]) {
        this.filters = filters ?? [
            new EmptyEditFilter(),
            new NoopEditFilter(),
        ];
    }

    /**
     * Returns the filtered edit text, or undefined if any filter rejected it.
     */
    apply(editLines: string[], editWindowLines: string[]): string | undefined {
        for (const filter of this.filters) {
            if (filter.shouldReject(editLines, editWindowLines)) {
                return undefined;
            }
        }
        return editLines.join('\n');
    }
}
