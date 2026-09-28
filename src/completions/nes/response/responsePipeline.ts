import { PromptTags } from '../tags';

export interface IResponseStage {
    readonly name: string;
    process(lines: string[], context: ResponsePipelineContext): string[];
}

export interface ResponsePipelineContext {
    /** Whether the original edit window contained the cursor tag */
    readonly editWindowHadCursorTag: boolean;
    readonly languageId?: string;
    readonly originalEditWindowLines?: readonly string[];
}

/** Remove a Markdown wrapper emitted by a general-purpose code model. */
export class CodeFenceParser implements IResponseStage {
    readonly name = 'CodeFenceParser';

    process(lines: string[], context: ResponsePipelineContext): string[] {
        if (context.languageId === 'markdown' || context.languageId === 'mdx') return lines;
        const first = lines.findIndex(line => line.trim() !== '');
        let last = lines.length - 1;
        while (last >= 0 && lines[last].trim() === '') last--;
        if (first < 0) return lines;
        const original = context.originalEditWindowLines;
        if (original?.some(line => /^(?:`{3,}|~{3,})/.test(line.trim()))) return lines;
        const opening = lines[first].trim().match(/^(`{3,}|~{3,})[ \t]*[\w+.#-]*$/)?.[1];
        const closing = lines[last].trim().match(/^(`{3,}|~{3,})$/)?.[1];
        if (!opening && !closing) return lines;
        if (!opening || !closing || opening[0] !== closing[0] || closing.length < opening.length) return [];
        return lines.slice(first + 1, last);
    }
}

/**
 * Extracts lines between ###remain edit start boundary line### and
 * ###remain edit end boundary line### markers.
 */
export class BoundaryMarkerParser implements IResponseStage {
    readonly name = 'BoundaryMarkerParser';

    process(lines: string[], _context: ResponsePipelineContext): string[] {
        const startMarker = '###remain edit start boundary line###';
        const endMarker = '###remain edit end boundary line###';

        const startIdx = lines.findIndex(l => l.trim() === startMarker);
        const endIdx = lines.findIndex((line, index) => index > startIdx && line.trim() === endMarker);

        if (startIdx === -1 && endIdx === -1) {
            // Older/local models do not emit boundary markers.  Preserve the
            // complete response in that format instead of dropping the edit.
            return lines;
        }

        if (startIdx < 0 || endIdx <= startIdx) return [];
        return lines.slice(startIdx + 1, endIdx);
    }
}

/**
 * Removes cursor tags from response lines when the original
 * edit window did not contain the cursor tag.
 */
export class CursorTagStripper implements IResponseStage {
    readonly name = 'CursorTagStripper';

    process(lines: string[], context: ResponsePipelineContext): string[] {
        if (context.editWindowHadCursorTag) {
            return lines;
        }
        return lines.map(l => l.replaceAll(PromptTags.CURSOR, ''));
    }
}

export class ResponsePipeline {
    private readonly _stages: IResponseStage[];

    constructor(stages?: IResponseStage[]) {
        this._stages = stages ?? [
            new BoundaryMarkerParser(),
            new CodeFenceParser(),
            new CursorTagStripper(),
        ];
    }

    get stages(): readonly IResponseStage[] {
        return this._stages;
    }

    hasCompleteMarkedWindow(rawText: string): boolean {
        const lines = rawText.split(/\r?\n/);
        const startIdx = lines.findIndex(line => line.trim() === '###remain edit start boundary line###');
        return startIdx >= 0 && lines.some((line, index) => index > startIdx
            && line.trim() === '###remain edit end boundary line###');
    }

    /** A zero-line replacement has adjacent markers; a blank source line is content. */
    isExplicitDeletion(rawText: string): boolean {
        const lines = rawText.split(/\r?\n/);
        const startIdx = lines.findIndex(line => line.trim() === '###remain edit start boundary line###');
        if (startIdx < 0 || lines[startIdx + 1]?.trim() !== '###remain edit end boundary line###') return false;
        // A complete thinking block or Markdown fence around the markers is
        // response formatting, not replacement text. Still reject arbitrary
        // prose outside the markers so an explanatory answer cannot delete code.
        const outside = [
            lines.slice(0, startIdx).join('\n'),
            lines.slice(startIdx + 2).join('\n'),
        ].map(part => part.replace(/<think>[\s\S]*?<\/think>/g, '').trim());
        if (outside[0] === '' && outside[1] === '') return true;
        const opening = outside[0].match(/^(`{3,}|~{3,})[ \t]*[\w+.#-]*$/)?.[1];
        const closing = outside[1].match(/^(`{3,}|~{3,})$/)?.[1];
        return !!opening && !!closing && opening[0] === closing[0] && closing.length >= opening.length;
    }

    /** Returns only complete model lines from an open, marked edit window. */
    processCompletedMarkedPrefix(rawText: string, context: ResponsePipelineContext): string[] | undefined {
        const lastNewline = rawText.lastIndexOf('\n');
        if (lastNewline < 0) return undefined;
        // The final completed CRLF line ends with a CR after slicing off LF.
        // Normalize it before diffing, just as the full-response path does.
        const completedLines = rawText.slice(0, lastNewline).replace(/\r$/, '').split(/\r?\n/);
        const startIdx = completedLines.findIndex(line => line.trim() === '###remain edit start boundary line###');
        if (startIdx < 0) return undefined;
        const content = completedLines.slice(startIdx + 1);
        if (content.some(line => line.trim() === '###remain edit end boundary line###')) return undefined;
        // A model-generated Markdown wrapper must be complete before it can
        // be stripped. The full-response pipeline handles that case.
        if (/^(?:`{3,}|~{3,})/.test(content.find(line => line.trim() !== '')?.trim() ?? '')) return undefined;
        return new CursorTagStripper().process(content, context);
    }

    process(rawText: string, context: ResponsePipelineContext): string[] {
        let lines = rawText.split(/\r?\n/);
        const hasCompleteWindow = this.hasCompleteMarkedWindow(rawText);
        for (const stage of this._stages) {
            lines = stage.process(lines, context);
        }
        // Markers delimit the exact replacement. Blank lines before the end
        // marker are source content, not response padding.
        if (!hasCompleteWindow) {
            while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
                lines.pop();
            }
        }
        return lines;
    }
}
