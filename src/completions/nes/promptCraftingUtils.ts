import { DocumentId } from './stubs/types';
import { Schemas } from './stubs/network';

export function toUniquePath(documentId: DocumentId, workspaceRootPath: string | undefined): string {
    const filePath = documentId.path;
    const workspaceRootPathWithSlash = workspaceRootPath === undefined ? undefined : (workspaceRootPath.endsWith('/') ? workspaceRootPath : workspaceRootPath + '/');

    const normalizeDrive = (value: string) => process.platform === 'win32' && /^\/[a-zA-Z]:/.test(value)
        ? `/${value[1].toLowerCase()}${value.substring(2)}`
        : value;
    const updatedFilePath = workspaceRootPathWithSlash !== undefined
        && normalizeDrive(filePath).startsWith(normalizeDrive(workspaceRootPathWithSlash))
        ? filePath.substring(workspaceRootPathWithSlash.length)
        : filePath;

    return documentId.toUri().scheme === Schemas.vscodeNotebookCell ? `${updatedFilePath}#${documentId.fragment}` : updatedFilePath;
}

export function countTokensForLines(page: string[], computeTokens: (s: string) => number): number {
    return page.reduce((sum, line) => sum + computeTokens(line) + 1 /* \n */, 0);
}

/** 将 system + user 消息通过模板渲染为纯文本 prompt。 */
export function renderCompletionPrompt(
    template: string,
    system: string,
    user: string,
): string {
    return template.replace(/\{system\}|\{user\}/g, placeholder =>
        placeholder === '{system}' ? system : user);
}
