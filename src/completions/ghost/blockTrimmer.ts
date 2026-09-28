import * as vscode from 'vscode';
import { StatementTree } from './multiline/treeSitter/statementTree';
import { nativeBlockMode } from './multiline/nativeBlockMode';

export interface BlockTrimmerConfig {
    maxLines: number;
    stopAtBlankLine: boolean;
}

export class BlockTrimmer {
    static isSupported(languageId: string): boolean {
        return isSupportedLanguageId(languageId);
    }

    constructor(private readonly config: BlockTrimmerConfig) {}

    trim(text: string): string {
        const lines = text.split('\n');
        if (lines.length <= this.config.maxLines) return text;

        let result = lines.slice(0, this.config.maxLines);
        if (this.config.stopAtBlankLine) {
            const blankIdx = result.findIndex(l => l.trim() === '');
            if (blankIdx > 0) {
                result = result.slice(0, blankIdx);
            }
        }
        return result.join('\n');
    }
}

export class TerseBlockTrimmer extends BlockTrimmer {
    constructor() {
        super({ maxLines: 10, stopAtBlankLine: true });
    }
}

export class VerboseBlockTrimmer extends BlockTrimmer {
    constructor() {
        super({ maxLines: 40, stopAtBlankLine: false });
    }
}

export enum BlockPositionType {
    NonBlock = 'non-block',
    EmptyBlock = 'empty-block',
    BlockEnd = 'block-end',
    MidBlock = 'mid-block',
}

/** Classify the cursor within the parsed statement tree like native Ghost Text. */
export async function getBlockPositionType(
    document: vscode.TextDocument,
    position: vscode.Position,
    languageId = document.languageId,
): Promise<BlockPositionType> {
    if (nativeBlockMode(languageId) === 'server'
        || !StatementTree.isSupported(languageId)) return BlockPositionType.NonBlock;
    const text = document.getText();
    const offset = document.offsetAt(position);
    const tree = StatementTree.create(languageId, text, 0, text.length);
    try {
        await tree.build();
        const statement = tree.statementAt(offset);
        if (!statement) return BlockPositionType.NonBlock;
        if (!statement.isCompoundStatementType && statement.children.length === 0) {
            if (statement.parent && !statement.nextSibling && statement.node.endPosition.row <= position.line) {
                return BlockPositionType.BlockEnd;
            }
            if (statement.parent) return BlockPositionType.MidBlock;
            return BlockPositionType.NonBlock;
        }
        if (statement.children.length === 0) return BlockPositionType.EmptyBlock;
        const lastChild = statement.children[statement.children.length - 1];
        return offset < lastChild.node.startIndex ? BlockPositionType.MidBlock : BlockPositionType.BlockEnd;
    } catch {
        return BlockPositionType.NonBlock;
    } finally {
        tree[Symbol.dispose]();
    }
}

/** Applies the language parser's block boundary before the conservative line cap. */
export async function trimCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    prefix: string,
    completion: string,
    multiline: boolean,
    maxLines?: number,
    languageId = document.languageId,
    skipBlockTrim = false,
): Promise<string> {
    let text = completion;
    // Forced follow-ups in non-client modes use a short line limit. Their
    // natural block detector did not find a block at this position, so a
    // structural trim would discard the continuation before that limit.
    const boundedFollowUp = skipBlockTrim || (maxLines !== undefined && nativeBlockMode(languageId) !== 'client');
    if (multiline && !boundedFollowUp && (languageId === 'yaml' || languageId === 'json'
        || languageId === 'jsonc' || languageId === 'json5')) {
        text = trimStructuredDataCompletion(document, position, prefix, text, languageId);
    }
    let parserTrimmed = false;
    if (multiline && !boundedFollowUp && nativeBlockMode(languageId) !== 'server'
        && isSupportedLanguageId(languageId)) {
        try {
            const offset = await isBlockBodyFinished(
                languageId,
                prefix,
                text,
                // The parser reads `prefix + text`. The prefix can have LF line
                // endings even when the backing document uses CRLF.
                prefix.length,
            );
            if (offset !== undefined && offset > 0 && offset < text.length) {
                text = text.slice(0, offset);
                parserTrimmed = true;
            }
        } catch {
            // Parser failures should not suppress a usable completion.
        }
    }
    // The bundled parser does not find every C-family boundary that the
    // native parser handles. Retain the brace scan when it has no boundary.
    if (multiline && !boundedFollowUp && !parserTrimmed && serverBraceLanguages.has(languageId)) {
        text = trimServerBraceBlock(prefix, text);
    }

    // The native server block mode has no fixed client-side line cap. The
    // request token budget and structural boundaries above decide its size.
    // A single-line request still permits a model to generate a newline.
    // Clip locally, keeping an initial newline as the lead-in to the first
    // generated line, as native cache reuse does.
    const initialLineBreak = !multiline ? text.match(/^\r?\n/) : undefined;
    const result = multiline ? text : initialLineBreak
        ? initialLineBreak[0] + text.slice(initialLineBreak[0].length).split(/\r?\n/, 1)[0]
        : text.split(/\r?\n/, 1)[0];
    return maxLines === undefined ? result : trimToLineLimit(result, maxLines);
}

const serverBraceLanguages = new Set(['c', 'cpp', 'csharp', 'java', 'php', 'css', 'scss', 'less']);

/** Bound a generated block when a generic gateway ignores trim_by_indentation. */
function trimServerBraceBlock(prefix: string, completion: string): string {
    let depth = 0;
    let quote = '';
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    const scan = (text: string, onClose?: (offset: number, depth: number) => void): void => {
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            const next = text[i + 1];
            if (lineComment) {
                if (ch === '\n') lineComment = false;
                continue;
            }
            if (blockComment) {
                if (ch === '*' && next === '/') { blockComment = false; i++; }
                continue;
            }
            if (quote) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === quote) quote = '';
                continue;
            }
            if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
            if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
            if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
            if (ch === '{') depth++;
            else if (ch === '}') { depth = Math.max(0, depth - 1); onClose?.(i, depth); }
        }
    };
    scan(prefix);
    if (depth === 0 || quote || blockComment) return completion;
    const startDepth = depth;
    let trimAt: number | undefined;
    scan(completion, (offset, currentDepth) => {
        if (trimAt !== undefined || currentDepth >= startDepth) return;
        const lineStart = completion.lastIndexOf('\n', offset - 1) + 1;
        const lineEnd = completion.indexOf('\n', offset);
        const before = completion.slice(lineStart, offset);
        const after = completion.slice(offset + 1, lineEnd < 0 ? undefined : lineEnd);
        if (!before.trim() && /^[\s;]*$/.test(after)) trimAt = offset + 1 + (after.match(/^\s*;/)?.[0].length ?? 0);
    });
    return trimAt === undefined ? completion : completion.slice(0, trimAt);
}

/**
 * The native provider uses a streaming finished callback after an explicit
 * accept. Keep the same bound even when the adapter returns a non-streaming
 * response or a gateway ignores the configured stop sequence.
 */
export function trimToLineLimit(text: string, maxLines: number): string {
    if (maxLines < 1 || !text) return text;
    const lines = text.split('\n');
    if (lines.length <= maxLines) return text;
    return lines.slice(0, maxLines).join('\n');
}

function trimStructuredDataCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    prefix: string,
    completion: string,
    languageId = document.languageId,
): string {
    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    if (languageId === 'yaml') {
        const currentIndent = (linePrefix.match(/^[ \t]*/) ?? [''])[0].length;
        let baseIndent = currentIndent;
        // In a block scalar, indented lines beginning with # are content,
        // including shebangs and Markdown headings. They establish the same
        // indentation boundary as any other scalar content line.
        const blockScalar = /(?:^\s*[^#\n]*?:\s*|^\s*-\s*)(?:[&!][^\s]+\s*)*[|>](?:[+-]?\d?|\d?[+-]?)\s*(?:#.*)?$/.test(linePrefix);
        // A completed scalar belongs to its parent mapping. More fields at
        // the scalar's indentation are still part of the same completion.
        // An open key or block scalar instead starts a child node here.
        const opensNode = /:\s*(?:[&!][^\s]+\s*)*(?:[|>][+-]?\d?)?\s*(?:#.*)?$/.test(linePrefix)
            || /^\s*-\s*(?:[&!][^\s]+\s*)?(?:[|>][+-]?\d?)?\s*(?:#.*)?$/.test(linePrefix);
        if (!opensNode) {
            baseIndent = -1;
            for (let line = position.line - 1; line >= 0; line--) {
                const previous = document.lineAt(line).text;
                if (!previous.trim()) continue;
                const previousIndent = (previous.match(/^[ \t]*/) ?? [''])[0].length;
                if (previousIndent < currentIndent) {
                    baseIndent = previousIndent;
                    break;
                }
            }
            // A completed mapping field can also be the first field on the
            // current list item (`- name: web`). Its next sibling starts at
            // this line's indentation, even if the enclosing list key is less
            // indented.
            if (/^\s*-\s+\S/.test(linePrefix)) {
                baseIndent = Math.max(baseIndent, currentIndent);
            }
        }
        const lines = completion.split(/\r?\n/);
        let sawContent = false;
        let boundaryIndent = baseIndent;
        const startsOnNewLine = lines.length > 1 && lines[0].trim() === '';
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) continue;
            if (!blockScalar && /^\s*#/.test(line)) continue;
            const indent = (line.match(/^[ \t]*/) ?? [''])[0].length;
            // The first generated line may itself dedent to a sibling of the
            // cursor's node. Its children belong to that new node, so use the
            // smaller indent as the boundary for the rest of the completion.
            // A completion that continues the current line has no such node.
            if (!sawContent && startsOnNewLine) {
                // Root-level scalar fields have no less-indented ancestor.
                // Use the first new node as the boundary instead of -1,
                // otherwise later root siblings are never trimmed.
                boundaryIndent = baseIndent < 0 ? indent : Math.min(baseIndent, indent);
            }
            if (sawContent && indent <= boundaryIndent) {
                return lines.slice(0, i).join('\n').replace(/[ \t]+$/, '');
            }
            sawContent = true;
        }
        return completion;
    }

    // A scalar value without a comma ends on its first line. If the model
    // continues with a comma, the following properties belong to the same
    // object and should be kept through its closing delimiter.
    const trimmedLine = linePrefix.trimEnd();
    const firstContent = completion.search(/\S/);
    if (firstContent < 0) return completion;
    const first = completion.slice(firstContent);
    const startsContainer = first[0] === '{' || first[0] === '[';
    const prefixState = scanJsonContainer(prefix);
    const hasOpenContainer = prefixState.depth > 0;
    const firstLine = first.split(/\r?\n/, 1)[0];
    const nextLine = first.slice(firstLine.length).split(/\r?\n/).slice(1).find(line => line.trim()) ?? '';
    const continuesObject = /,\s*(?:(?:\/\/.*)|(?:\/\*.*\*\/\s*))?$/.test(firstLine)
        || /^\s*,/.test(nextLine);
    const afterValueColon = !prefixState.quote && !prefixState.lineComment && !prefixState.blockComment
        && (/[:]\s*$/.test(trimmedLine) || /[:]\s*$/.test(prefix));
    if ((!hasOpenContainer && !startsContainer)
        || (!startsContainer && !continuesObject && afterValueColon)) {
        const newline = completion.indexOf('\n', firstContent);
        return newline < 0 ? completion : completion.slice(0, newline).replace(/[ \t]+$/, '');
    }

    if (afterValueColon && startsContainer) {
        const valueClose = scanJsonContainer(first, undefined, true).closeOffset;
        if (valueClose !== undefined) {
            const absoluteClose = firstContent + valueClose;
            // Without a comma the generated object/array is the value being
            // completed. The enclosing close may already exist in the suffix.
            if (!hasJsonContinuationComma(completion.slice(absoluteClose + 1))) {
                return completion.slice(0, absoluteClose + 1);
            }
        }
    }

    // The cursor may be inside a string or comment. Carry that lexical state
    // into the generated text so braces in content do not close the object.
    const closeOffset = scanJsonContainer(completion, {
        ...prefixState,
        depth: hasOpenContainer ? 1 : 0,
    }, true).closeOffset;
    return closeOffset === undefined ? completion : completion.slice(0, closeOffset + 1);
}

interface JsonScanState {
    depth: number;
    quote?: string;
    escaped: boolean;
    lineComment: boolean;
    blockComment: boolean;
    closeOffset?: number;
}

function hasJsonContinuationComma(text: string): boolean {
    let offset = 0;
    while (offset < text.length) {
        if (/\s/.test(text[offset])) { offset++; continue; }
        if (text.startsWith('/*', offset)) {
            const end = text.indexOf('*/', offset + 2);
            if (end < 0) return false;
            offset = end + 2;
            continue;
        }
        if (text.startsWith('//', offset)) {
            const end = text.indexOf('\n', offset + 2);
            if (end < 0) return false;
            offset = end + 1;
            continue;
        }
        return text[offset] === ',';
    }
    return false;
}

function scanJsonContainer(
    text: string,
    initialState: JsonScanState = { depth: 0, escaped: false, lineComment: false, blockComment: false },
    stopAtClose = false,
): JsonScanState {
    let { depth, quote, escaped, lineComment, blockComment } = initialState;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];
        if (lineComment) {
            if (ch === '\n') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (ch === '*' && next === '/') { blockComment = false; i++; }
            continue;
        }
        if (quote) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === quote) quote = undefined;
            continue;
        }
        if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
        if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
        if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === '{' || ch === '[') {
            depth++;
        } else if (ch === '}' || ch === ']') {
            depth = Math.max(0, depth - 1);
            if (stopAtClose && depth === 0) return { depth, quote, escaped, lineComment, blockComment, closeOffset: i };
        }
    }
    return { depth, quote, escaped, lineComment, blockComment };
}
import { isSupportedLanguageId } from './multiline/treeSitter/parse';
import { isBlockBodyFinished } from './multiline/treeSitter/blockParser';
