/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { knownLanguages } from './generatedLanguages';
import { knownFileExtensions, knownTemplateLanguageExtensions, templateLanguageLimitations } from './languages';

export interface DetectedLanguage {
    languageId: string;
    isGuess: boolean;
    fileExtension: string;
}

const neighborLanguageAliases: Record<string, string> = {
    javascriptreact: 'javascript',
    jsx: 'javascript',
    typescriptreact: 'typescript',
    jade: 'pug',
    cshtml: 'razor',
    c: 'cpp',
};

/** Language aliases that native Copilot treats as the same prompt language. */
export function normalizeNeighborLanguageId(languageId: string): string {
    const normalized = languageId.toLowerCase();
    return neighborLanguageAliases[normalized] ?? normalized;
}

const knownExtensions = new Map<string, string[]>();
const knownFilenames = new Map<string, string[]>();
for (const [languageId, { extensions, filenames }] of Object.entries(knownLanguages)) {
    for (const extension of extensions) {
        knownExtensions.set(extension, [...(knownExtensions.get(extension) ?? []), languageId]);
    }
    for (const filename of filenames ?? []) {
        knownFilenames.set(filename, [...(knownFilenames.get(filename) ?? []), languageId]);
    }
}

function extensionOf(filename: string): string {
    const dot = filename.lastIndexOf('.');
    return dot > 0 ? filename.slice(dot).toLowerCase() : '';
}

/** Mirrors the filename and template-extension detection used by native Copilot. */
export function detectLanguage(document: Pick<vscode.TextDocument, 'uri' | 'languageId'>): DetectedLanguage {
    if (document.uri.scheme === 'untitled' || document.uri.scheme === 'vscode-notebook-cell') {
        return {
            languageId: document.languageId === 'c' ? 'cpp' : document.languageId,
            isGuess: true,
            fileExtension: '',
        };
    }

    const path = document.uri.path;
    const filename = path.slice(path.lastIndexOf('/') + 1);
    const extension = extensionOf(filename);
    let sourceExtension = extension;
    if (knownTemplateLanguageExtensions.includes(extension)) {
        const base = filename.slice(0, filename.length - extension.length);
        const templateSourceExtension = extensionOf(base);
        const limitation = templateLanguageLimitations[extension];
        if (templateSourceExtension && knownFileExtensions.includes(templateSourceExtension)
            && (!limitation || limitation.includes(templateSourceExtension))) {
            sourceExtension = templateSourceExtension;
        }
    }

    let candidates = knownFilenames.get(filename);
    if (!candidates) candidates = knownExtensions.get(sourceExtension);
    if (!candidates) {
        let basename = filename;
        while (basename.includes('.')) {
            basename = basename.replace(/\.[^.]*$/, '');
            candidates = knownFilenames.get(basename);
            if (candidates) break;
        }
    }
    const detected = candidates?.[0] ?? document.languageId;
    return {
        languageId: detected === 'c' || detected === 'cpp' ? 'cpp' : detected,
        isGuess: !candidates || candidates.length > 1,
        fileExtension: sourceExtension === extension ? extension : sourceExtension + extension,
    };
}
