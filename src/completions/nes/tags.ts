export namespace PromptTags {
    export const CURSOR = '<|cursor|>';

    type Tag = {
        start: string;
        end: string;
    };

    function createTag(key: string): Tag {
        return {
            start: `<|${key}|>`,
            end: `<|/${key}|>`
        };
    }

    export const EDIT_WINDOW = createTag('code_to_edit');

    export const AREA_AROUND = createTag('area_around_code_to_edit');

    // NOTE - 新增前缀与后缀
    export const AREA_CODE_PREFIX = createTag('area_code_prefix');
    export const AREA_CODE_SUFFIX = createTag('area_code_suffix');

    export const CURRENT_FILE = createTag('current_file_content');

    export const CURSOR_LOCATION = createTag('cursor_location');

    export const EDIT_HISTORY = createTag('edit_diff_history');

    export const RECENT_FILES = createTag('recently_viewed_code_snippets');

    export const RECENT_FILE = createTag('recently_viewed_code_snippet');

    export const LINTER = createTag('linter');

    export function createLintTag(tagName: string): Tag {
        return createTag(tagName);
    }
}
