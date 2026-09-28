import * as vscode from 'vscode';
import { INesConfigProvider } from '../../../config/nesConfig';
import {RecentFileClippingStrategy} from '../stubs/types';
import { PromptingStrategy, PromptOptions, IncludeLineNumbersOption, AggressivenessLevel, LintOptionWarning, LintOptionShowCode, DocumentId, StatelessNextEditDocument } from '../stubs/types';
import { IXtabHistoryEntry } from '../stubs/types';
import { constructTaggedFile, getUserPrompt, PromptPieces, N_LINES_AS_CONTEXT } from '../promptCrafting';
import { LintErrors } from '../lintErrors';
import { CurrentDocument } from '../xtabCurrentDocument';
import { StringText } from '../stubs/abstractText';
import { Position } from '../stubs/position';
import { OffsetRange } from '../stubs/offsetRange';
import { EditWindowResolver } from './editWindowResolver';
import { INeighborFileSnippet } from '../similarFilesContextService';
import { cachedLexicalLines, lexicalFocus, selectLexicalWindow } from '../../ghost/lexicalContext';
import { selectNeighborDocuments } from '../../ghost/neighborFileAccess';
import { detectLanguage } from '../../shared/languageDetection';
import { countPromptTokens } from './promptTokenizer';
import { renderCompletionPrompt } from '../promptCraftingUtils';
import { effectiveNesOutputTokens } from './nesModelBudget';

export interface PromptAssembly {
    promptPieces: PromptPieces;
    userPrompt: string;
    systemPrompt: string;
    editWindowLines: string[];
    editWindowRange: OffsetRange;
}

export class PromptAssembler {
    private _aggressivenessLevel: AggressivenessLevel = AggressivenessLevel.Medium;

    constructor(
        @INesConfigProvider private readonly _config: INesConfigProvider,
        private readonly _editWindowResolver: EditWindowResolver,
    ) {}

    setAggressiveness(level: AggressivenessLevel): void {
        this._aggressivenessLevel = level;
    }

    assemble(
        document: vscode.TextDocument,
        position: vscode.Position,
        lintEnable: boolean,
        xtabHistory?: readonly IXtabHistoryEntry[],
        semanticSnippets?: readonly INeighborFileSnippet[],
        rejectedEdits?: readonly string[],
        expandedEditWindowLinesBelow?: number,
    ): PromptAssembly {
        return this._assembleWithBudget(document, position, lintEnable, xtabHistory, semanticSnippets, rejectedEdits, expandedEditWindowLinesBelow, {
            recent: 2000, diff: 2000, neighbor: 1500, current: 4000,
            contextLines: N_LINES_AS_CONTEXT, attempt: 0,
        });
    }

    private _assembleWithBudget(
        document: vscode.TextDocument,
        position: vscode.Position,
        lintEnable: boolean,
        xtabHistory: readonly IXtabHistoryEntry[] | undefined,
        semanticSnippets: readonly INeighborFileSnippet[] | undefined,
        rejectedEdits: readonly string[] | undefined,
        expandedEditWindowLinesBelow: number | undefined,
        budget: PromptBudgetState,
    ): PromptAssembly {
        const normalizedText = document.getText().replace(/\r\n/g, '\n');
        const effectivePosition = position;
        const cursorPos = new Position(effectivePosition.line + 1, effectivePosition.character + 1);
        const currentDocument = new CurrentDocument(new StringText(normalizedText), cursorPos);

        // Resolve edit window range
        const normalizedLines = normalizedText.split('\n');
        const ewRange = this._editWindowResolver.resolve(
            { lineCount: normalizedLines.length, lineText: (i: number) => normalizedLines[i] },
            effectivePosition.line,
            expandedEditWindowLinesBelow,
        );

        // Area around edit window range — use effectivePosition so NCP retry centers on the predicted position
        const aaStart = Math.min(ewRange.start, Math.max(0, effectivePosition.line - budget.contextLines));
        const aaEndExcl = Math.max(ewRange.endExclusive,
            Math.min(document.lineCount, effectivePosition.line + budget.contextLines + 1));
        const areaAroundEditWindowLinesRange = new OffsetRange(aaStart, aaEndExcl);

        const computeTokens = (text: string) => countPromptTokens(text, this._config.family);
        const promptOptions: PromptOptions = {
            promptingStrategy: PromptingStrategy.Xtab275,
            includePostScript: true,
            includeEditCode: true,
            recentlyViewedDocuments: { maxTokens: budget.recent, nDocuments: 10, includeViewedFiles: true, clippingStrategy: RecentFileClippingStrategy.AroundEditRange, includeLineNumbers: IncludeLineNumbersOption.None },
            currentFile: { includeCursorTag: true, includeLineNumbers: IncludeLineNumbersOption.None, maxTokens: budget.current, prioritizeAboveCursor: true, includeTags: false },
            languageContext: { maxTokens: 2000, traitPosition: 'before' },
            lintOptions: { enable: lintEnable, tagName: 'diagnostics', warnings: LintOptionWarning.NO, showCode: LintOptionShowCode.NO, maxLints: 10, maxLineDistance: 50, nRecentFiles: 3 },
            neighborFiles: { enabled: true, maxTokens: budget.neighbor },
            pagedClipping: { pageSize: 50 },
            diffHistory: { onlyForDocsInPrompt: true, maxTokens: budget.diff, nEntries: 10, useRelativePaths: true },
        };

        const taggedR = constructTaggedFile(currentDocument, ewRange, areaAroundEditWindowLinesRange, promptOptions, computeTokens, {
            includeLineNumbers: { areaAroundCodeToEdit: IncludeLineNumbersOption.None, currentFileContent: IncludeLineNumbersOption.None },
        });
        if (taggedR.isError()) {
            if (budget.contextLines > 0 && budget.attempt < 12) {
                return this._assembleWithBudget(document, position, lintEnable, xtabHistory, semanticSnippets, rejectedEdits, expandedEditWindowLinesBelow, {
                    ...budget, contextLines: budget.contextLines > 8 ? 8 : budget.contextLines > 3 ? 3 : 0,
                    attempt: budget.attempt + 1,
                });
            }
            throw new Error('Prompt too large');
        }
        const { clippedTaggedCurrentDoc, areaAroundCodeToEdit } = taggedR.val;

        const activeDoc: StatelessNextEditDocument = {
            id: DocumentId.create(document.uri.toString()),
            workspaceRoot: vscode.workspace.getWorkspaceFolder(document.uri)
                ? { path: vscode.workspace.getWorkspaceFolder(document.uri)!.uri.path }
                : undefined,
            documentAfterEditsLines: normalizedLines,
            languageId: detectLanguage(document).languageId,
        };
        const lintErrors = new LintErrors(document.uri, currentDocument, xtabHistory);

        const lexicalSnippets = this._getNeighborSnippets(document, normalizedLines, effectivePosition.line);
        const neighborSnippets = [...(semanticSnippets ?? []), ...lexicalSnippets]
            // Source slices already present in the clipped current-file body
            // consume budget without adding information. Hover/signature facts
            // remain useful because they are not literal source lines.
            .filter(snippet => snippet.uri !== document.uri.toString()
                || snippet.kind === 'facts'
                || snippet.lineRange.startLine < clippedTaggedCurrentDoc.keptRange.start
                || snippet.lineRange.endLineExclusive > clippedTaggedCurrentDoc.keptRange.endExclusive)
            .sort((a, b) => b.score - a.score)
            // Hover/signature facts and source definitions can share a line.
            // Remove repeated content, not every snippet from that line.
            .filter((snippet, index, all) => all.findIndex(other => other.uri === snippet.uri
                && other.kind === snippet.kind
                && other.snippet.trim() === snippet.snippet.trim()) === index)
            .slice(0, 6)
            .reduce<INeighborFileSnippet[]>((selected, snippet) => {
                const usedChars = selected.reduce((sum, item) => sum + item.snippet.length, 0);
                if (usedChars >= 7_000) return selected;
                const remaining = 7_000 - usedChars;
                selected.push({ ...snippet, snippet: snippet.snippet.slice(0, remaining) });
                return selected;
            }, []);
        const promptPieces = new PromptPieces(
            currentDocument, ewRange, areaAroundEditWindowLinesRange,
            activeDoc, xtabHistory ?? [], clippedTaggedCurrentDoc.lines, areaAroundCodeToEdit,
            undefined, this._aggressivenessLevel, lintErrors, computeTokens, promptOptions,
            neighborSnippets,
        );

        const { prompt: baseUserPrompt, sectionTokens } = getUserPrompt(promptPieces);

        const editWindowLines = normalizedLines.slice(ewRange.start, ewRange.endExclusive);
        const systemPrompt = 'Predict the developer\'s next code edit. Rewrite the complete code_to_edit section, preserving unchanged lines and the file\'s indentation. Output only the revised code between the requested boundary markers, with no Markdown or explanation. If no useful edit is needed, return the unchanged section.';
        const rejectedSection = rejectedEdits && rejectedEdits.length > 0
            ? `\n\nRecent suggestions rejected by the developer; avoid repeating these exact edits:\n${rejectedEdits.map(edit => `- ${edit}`).join('\n')}`
            : '';
        const userPrompt = `${baseUserPrompt}${rejectedSection}\n\nFile language: ${detectLanguage(document).languageId}. Return the complete revised code_to_edit section, including unchanged lines. Put ###remain edit start boundary line### on its own line before the code and ###remain edit end boundary line### on its own line after it. Do not include the code_to_edit tags, line numbers, Markdown fences, or text outside the boundary markers.`;

        const contextWindow = this._config.capabilities?.limits?.max_context_window_tokens ?? 128_000;
        const maxInputTokens = contextWindow
            - effectiveNesOutputTokens(contextWindow, this._config.maxOutputTokens) - 128;
        const requestText = this._config.endpoint === 'completions'
            ? renderCompletionPrompt(this._config.promptTemplate, systemPrompt, userPrompt)
            : `${systemPrompt}\n${userPrompt}`;
        const usedTokens = computeTokens(requestText) + (this._config.endpoint === 'completions' ? 0 : 32);
        if (usedTokens > maxInputTokens) {
            if (budget.attempt >= 12 || maxInputTokens <= 0) {
                throw new Error(`Prompt exceeds model context window (${usedTokens}/${maxInputTokens} tokens; ${JSON.stringify(budget)})`);
            }
            const excess = usedTokens - maxInputTokens;
            const next = { ...budget, attempt: budget.attempt + 1 };
            for (const part of ['recent', 'diff', 'neighbor'] as const) {
                if (next[part] <= 0 || sectionTokens[part] <= 0) continue;
                next[part] = Math.max(0, Math.min(next[part] - 1, sectionTokens[part] - excess - 32));
                return this._assembleWithBudget(document, position, lintEnable, xtabHistory, semanticSnippets, rejectedEdits, expandedEditWindowLinesBelow, next);
            }
            const mandatoryCurrent = computeTokens(normalizedLines.slice(aaStart, aaEndExcl).join('\n')) + 64;
            if (next.current > mandatoryCurrent) {
                const reduced = Math.min(next.current - excess - 64, Math.floor(next.current * 0.7));
                next.current = Math.max(mandatoryCurrent, reduced);
                if (reduced <= mandatoryCurrent && next.contextLines > 0) {
                    next.contextLines = next.contextLines > 8 ? 8 : next.contextLines > 3 ? 3 : 0;
                }
            } else if (next.contextLines > 0) {
                next.contextLines = next.contextLines > 8 ? 8 : next.contextLines > 3 ? 3 : 0;
            } else {
                throw new Error('Prompt exceeds model context window');
            }
            return this._assembleWithBudget(document, position, lintEnable, xtabHistory, semanticSnippets, rejectedEdits, expandedEditWindowLinesBelow, next);
        }

        return { promptPieces, userPrompt, systemPrompt, editWindowLines, editWindowRange: ewRange };
    }

    private _getNeighborSnippets(document: vscode.TextDocument, currentLines: string[], cursorLine: number): INeighborFileSnippet[] {
        const focus = lexicalFocus(currentLines.slice(Math.max(0, cursorLine - 12), cursorLine + 2).join('\n'));
        if (focus.length === 0) return [];
        const candidates: INeighborFileSnippet[] = [];
        for (const other of selectNeighborDocuments(document, [...vscode.workspace.textDocuments].reverse())) {
            const selected = selectLexicalWindow(cachedLexicalLines(other), focus);
            if (!selected) continue;
            candidates.push({
                uri: other.uri.toString(),
                relativePath: vscode.workspace.asRelativePath(other.uri),
                snippet: selected.snippet,
                lineRange: {
                    startLine: selected.startLine,
                    endLineExclusive: selected.startLine + selected.snippet.split('\n').length,
                },
                // Language-server definitions and references have higher scores.
                score: Math.min(2, selected.score / 6),
            });
        }
        return candidates.sort((a, b) => b.score - a.score).slice(0, 3);
    }
}

interface PromptBudgetState {
    recent: number;
    diff: number;
    neighbor: number;
    current: number;
    contextLines: number;
    attempt: number;
}
