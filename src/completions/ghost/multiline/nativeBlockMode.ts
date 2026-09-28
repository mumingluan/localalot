/** Default block modes used by Copilot Ghost Text without experiment overrides. */
export type NativeBlockMode = 'client' | 'parsing' | 'parsingAndServer' | 'server';

const clientLanguages = new Set([
    'javascript', 'javascriptreact', 'jsx',
    'typescript', 'typescriptreact', 'go',
]);

// The native parser currently disables C/C++, C#, Java and PHP. Those
// languages use server-side multiline trimming even though WASM grammars exist.
const parsingAndServerLanguages = new Set(['python']);

export function nativeBlockMode(languageId: string): NativeBlockMode {
    if (clientLanguages.has(languageId)) return 'client';
    if (languageId === 'ruby') return 'parsing';
    if (parsingAndServerLanguages.has(languageId)) return 'parsingAndServer';
    return 'server';
}
