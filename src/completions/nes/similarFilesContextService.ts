import { LineRange0Based } from './types';

/**
 * A neighbor-file snippet selected via Jaccard similarity, ready to be
 * embedded into the recently_viewed_code_snippets section of the prompt.
 */
export interface INeighborFileSnippet {
    readonly uri: string;
    readonly relativePath: string | undefined;
    readonly snippet: string;
    readonly lineRange: LineRange0Based;
    readonly score: number;
    /** Cursor hover/signature facts are not a slice of the source file. */
    readonly kind?: 'facts';
}
