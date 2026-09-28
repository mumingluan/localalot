import * as vscode from 'vscode';
import { getLocalConfiguration } from '../../config/compatConfiguration';

/** Native Copilot skips editor surfaces without useful source context. */
const ignoredUriSchemes = new Set([
    'output',
    'search-editor',
    'comment',
    'git',
    'vscode-chat-input',
    'chat-editing-snapshot-text-model',
]);

const sourceUriSchemes = new Set(['file', 'untitled', 'vscode-notebook-cell', 'vscode-remote', 'vscode-vfs']);
let meteredConnectionApiUnavailable = false;

export function isSourceDocumentUri(uri: vscode.Uri): boolean {
    return sourceUriSchemes.has(uri.scheme);
}

/** Preserve explicit invocation when VS Code reports a metered connection. */
export function shouldSkipAutomaticCompletionOnMeteredConnection(triggerKind: vscode.InlineCompletionTriggerKind): boolean {
    if (triggerKind !== vscode.InlineCompletionTriggerKind.Automatic || meteredConnectionApiUnavailable) return false;
    try {
        return (vscode.env as typeof vscode.env & { isMeteredConnection?: boolean }).isMeteredConnection === true;
    } catch {
        // Only extensions granted envIsConnectionMetered may read this API.
        meteredConnectionApiUnavailable = true;
        return false;
    }
}

/** Unsaved buffers can use open source files; saved files stay on their own host. */
export function canUseAsNeighborDocument(activeUri: vscode.Uri, candidateUri: vscode.Uri): boolean {
    if (!isSourceDocumentUri(candidateUri)) return false;
    if (activeUri.scheme === 'untitled' || candidateUri.scheme === 'untitled') return true;
    return activeUri.scheme === candidateUri.scheme && activeUri.authority === candidateUri.authority;
}

/** Matches the editor surfaces where inline code suggestions are meaningful. */
export function isEligibleForInlineCompletion(
    document: vscode.TextDocument,
    ignoreLanguageSetting = false,
): boolean {
    if (isUnavailableForInlineCompletion(document)) return false;

    if (vscode.workspace.getConfiguration('editor.inlineSuggest', {
        uri: document.uri, languageId: document.languageId,
    }).get<boolean>('enabled', true) === false) return false;

    const configuration = getLocalConfiguration('localalot', document.uri);
    const enabled = configuration.get<Record<string, boolean> | boolean>('enable', { '*': true });
    if (!ignoreLanguageSetting
        && (typeof enabled === 'boolean' ? !enabled : !(enabled[document.languageId] ?? enabled['*'] ?? true))) {
        return false;
    }

    return true;
}

/** File exclusions and unsupported editor surfaces, independent of enable switches. */
export function isUnavailableForInlineCompletion(document: vscode.TextDocument): boolean {
    if (ignoredUriSchemes.has(document.uri.scheme)) return true;
    if (!['file', 'vscode-remote', 'vscode-vfs'].includes(document.uri.scheme)) return false;
    return isExcludedByConfiguration(document, getLocalConfiguration('localalot', document.uri));
}

function isExcludedByConfiguration(document: vscode.TextDocument, configuration: vscode.WorkspaceConfiguration): boolean {
    return isUriExcludedByConfiguration(document.uri, configuration);
}

/** Check the same exclusion rules before adding a file to native prompt context. */
export function isUriExcludedByConfiguration(
    uri: vscode.Uri,
    configuration = getLocalConfiguration('localalot', uri),
): boolean {
    // Explorer and Search visibility do not disable native Copilot completions.
    // Only the extension's explicit exclusion setting controls eligibility.
    const patterns = configuration.get<string[]>('exclude', []);
    if (patterns.length === 0) return false;

    const path = uri.fsPath.replace(/\\/g, '/');
    const basename = path.slice(path.lastIndexOf('/') + 1);
    return patterns.some(pattern => globMatches(pattern, path) || globMatches(pattern, basename));
}

function globMatches(pattern: string, value: string): boolean {
    const normalized = pattern.replace(/\\/g, '/');
    let expression = '';
    for (let index = 0; index < normalized.length; index++) {
        const char = normalized[index];
        if (char === '*') {
            if (normalized[index + 1] === '*') {
                index++;
                if (normalized[index + 1] === '/') index++;
                expression += '.*';
            } else {
                expression += '[^/]*';
            }
        } else if (char === '?') {
            expression += '[^/]';
        } else if (char === '{') {
            const close = normalized.indexOf('}', index + 1);
            if (close > index) {
                const alternatives = normalized.slice(index + 1, close).split(',').map(escapeRegExp).join('|');
                expression += `(?:${alternatives})`;
                index = close;
            } else {
                expression += escapeRegExp(char);
            }
        } else {
            expression += escapeRegExp(char);
        }
    }
    try {
        return new RegExp(`(^|/)${expression}($|/)`, 'i').test(value)
            || new RegExp(`^${expression}$`, 'i').test(value);
    } catch {
        return false;
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
