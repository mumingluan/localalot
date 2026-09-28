export enum ContextKind {
    Snippet = 'snippet',
    Trait = 'trait',
    File = 'file',
}

interface SnippetContext {
    kind: ContextKind.Snippet;
    value: string;
    uri: { toString(): string };
}

export interface TraitContext {
    kind: ContextKind.Trait;
    name: string;
    value: string;
}

interface LanguageContextItem {
    context: SnippetContext | TraitContext;
    onTimeout: boolean;
}

export interface LanguageContextResponse {
    items: readonly LanguageContextItem[];
}
