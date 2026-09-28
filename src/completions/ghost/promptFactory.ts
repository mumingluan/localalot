import { createServiceIdentifier } from '../../di/services';
import { DiagnosticSummary } from './types';

export const IGhostPromptFactory = createServiceIdentifier<IGhostPromptFactory>('IGhostPromptFactory');

export interface GhostPromptContextParams {
    languageId: string;
    diagnostics: DiagnosticSummary[];
    recentEdits: string[];
    relatedFiles?: Array<{ path: string; snippet: string }>;
    maxContextChars?: number;
}

export interface IGhostPromptFactory {
    readonly _serviceBrand: undefined;
    /** Render context without adding a FIM template or code prefix/suffix. */
    createContext(params: GhostPromptContextParams): string;
    createPrompt(params: {
        template: string;
        prefix: string;
        suffix: string;
        languageId: string;
        diagnostics: DiagnosticSummary[];
        recentEdits: string[];
        relatedFiles?: Array<{ path: string; snippet: string }>;
        maxContextChars?: number;
        includeContext?: boolean;
    }): string;
}

export class GhostPromptFactory implements IGhostPromptFactory {
    readonly _serviceBrand: undefined;

    createContext(params: GhostPromptContextParams): string {
        const contextLines: string[] = [];
        const diagnosticLines: string[] = [];
        const relatedLines: string[] = [];
        const recentLines: string[] = [];
        let contextChars = 0;
        const maxContextChars = params.maxContextChars ?? Number.POSITIVE_INFINITY;
        const syntax = this._getCommentSyntax(params.languageId);
        const commentPrefix = syntax.linePrefix;
        const opening = syntax.opening;
        const closing = syntax.closing;
        const escapeCommentContent = syntax.escapeContent;
        // Reserve the closing marker, its separator, and the two trailing
        // newlines before admitting any context lines.
        const contentLimit = Number.isFinite(maxContextChars)
            ? Math.max(0, maxContextChars - closing.length - 3)
            : maxContextChars;
        const appendContextLine = (line: string, escape = true, target = contextLines): boolean => {
            const safeLine = escape && escapeCommentContent ? escapeCommentContent(line) : line;
            const cost = safeLine.length + (contextLines.length > 0 ? 1 : 0);
            if (contextChars + cost > contentLimit) return false;
            target.push(safeLine);
            contextChars += cost;
            return true;
        };
        const contextBlockCost = (lines: readonly string[]): number => {
            const safeLines = lines.map(line => escapeCommentContent ? escapeCommentContent(line) : line);
            return safeLines.reduce((sum, line, index) =>
                sum + line.length + (contextLines.length > 0 || index > 0 ? 1 : 0), 0);
        };
        const appendContextBlock = (lines: readonly string[], target = contextLines): boolean => {
            const cost = contextBlockCost(lines);
            if (contextChars + cost > contentLimit) return false;
            const safeLines = lines.map(line => escapeCommentContent ? escapeCommentContent(line) : line);
            target.push(...safeLines);
            contextChars += cost;
            return true;
        };

        if (!appendContextLine(opening, false)) return '';
        appendContextLine(`${commentPrefix} language: ${params.languageId}`);

        // Select context by native priority: recent edits, related source,
        // then diagnostics. Render it below in source-friendly order.
        if (params.recentEdits.length > 0) {
            const selected: string[][] = [];
            const introduction = [
                `${commentPrefix} recent edits:`,
                `${commentPrefix} These are recently edited files. Do not suggest code that has been deleted.`,
            ];
            const ending = `${commentPrefix} End of recent edits`;
            for (const edit of params.recentEdits.slice(-8).reverse()) {
                const lines = edit.split(/\r?\n/).map(line => `${commentPrefix} ${line}`);
                const block = [...introduction, ...lines, ...selected.flat(), ending];
                if (contextChars + contextBlockCost(block) <= contentLimit) selected.unshift(lines);
            }
            if (selected.length > 0) appendContextBlock([...introduction, ...selected.flat(), ending], recentLines);
        }

        for (const file of params.relatedFiles ?? []) {
            const snippetLines = file.snippet.split(/\r\n|\r|\n/);
            if (!file.snippet.trim()) continue;
            const header = `${commentPrefix} related file: ${file.path.replace(/[\r\n]/g, ' ')}`;
            const initialLines = snippetLines.slice(0, Math.min(2, snippetLines.length))
                .map(line => `${commentPrefix} ${line}`);
            if (!appendContextBlock([header, ...initialLines], relatedLines)) continue;
            for (const line of snippetLines.slice(initialLines.length)) {
                if (!appendContextLine(`${commentPrefix} ${line}`, true, relatedLines)) break;
            }
            if (contextChars >= maxContextChars) break;
        }

        if (params.diagnostics.length > 0) {
            for (const d of params.diagnostics.slice(0, 5)) {
                const messageLines = d.message.split(/\r\n|\r|\n/);
                const location = `[Line ${d.line}${d.column ? `, Col ${d.column}` : ''}]`;
                const code = d.code ? ` ${d.source?.toUpperCase() ?? ''}${d.code}` : '';
                if (!appendContextLine(`${commentPrefix} diagnostics: ${location} ${d.severity}${code}: ${messageLines[0]}`,
                    true, diagnosticLines)) break;
                for (const line of messageLines.slice(1)) {
                    if (!appendContextLine(`${commentPrefix}   ${line}`, true, diagnosticLines)) break;
                }
            }
        }

        if (contextLines.length === 1) return '';
        contextLines.push(...diagnosticLines, ...relatedLines, ...recentLines);
        contextLines.push(closing);
        return contextLines.join('\n') + '\n\n';
    }

    createPrompt(params: {
        template: string;
        prefix: string;
        suffix: string;
        languageId: string;
        diagnostics: DiagnosticSummary[];
        recentEdits: string[];
        relatedFiles?: Array<{ path: string; snippet: string }>;
        maxContextChars?: number;
        includeContext?: boolean;
    }): string {
        const context = params.includeContext === false ? '' : this.createContext(params);
        const prefix = context ? `\n${context}${params.prefix}` : params.prefix;
        return params.template
            .replace(/\{prefix\}|\{suffix\}/g, placeholder =>
                placeholder === '{prefix}' ? prefix : params.suffix);
    }

    private _getCommentSyntax(languageId: string): {
        linePrefix: string;
        opening: string;
        closing: string;
        escapeContent?: (line: string) => string;
    } {
        const hashLanguages = new Set([
            'python', 'ruby', 'shellscript', 'shell', 'bash', 'zsh', 'fish',
            'yaml', 'toml', 'perl', 'r', 'julia', 'dockerfile', 'powershell',
            'make', 'cmake', 'hcl', 'terraform', 'elixir', 'crystal',
        ]);
        if (hashLanguages.has(languageId)) {
            return { linePrefix: '#', opening: '# <copilot-context>', closing: '# </copilot-context>' };
        }
        const dashLanguages = new Set(['sql', 'lua', 'plsql', 'ada']);
        if (dashLanguages.has(languageId)) {
            return { linePrefix: '--', opening: '-- <copilot-context>', closing: '-- </copilot-context>' };
        }
        if (['html', 'xml', 'xsl', 'vue', 'svelte', 'razor', 'markdown'].includes(languageId)) {
            return {
                linePrefix: '', opening: '<!-- <copilot-context>', closing: '</copilot-context> -->',
                escapeContent: line => line.replace(/--/g, '- -'),
            };
        }
        if (['css', 'scss', 'less'].includes(languageId)) {
            return {
                linePrefix: ' *', opening: '/* <copilot-context>', closing: ' */',
                escapeContent: line => line.replace(/\*\//g, '* /'),
            };
        }
        return { linePrefix: '//', opening: '// <copilot-context>', closing: '// </copilot-context>' };
    }
}
