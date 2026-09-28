import * as assert from 'assert';
import { GhostPromptFactory } from '../../completions/ghost/promptFactory';
import { DiagnosticSummary } from '../../completions/ghost/types';

suite('GhostPromptFactory', () => {
    test('keeps replacement-like source characters and literal placeholders intact', () => {
        const prefix = 'const value = "$& $` $\' {suffix}";';
        const suffix = 'const tail = "$& {prefix}";';
        const result = new GhostPromptFactory().createPrompt({
            template: '<p>{prefix}</p><s>{suffix}</s>',
            prefix, suffix, languageId: 'typescript', diagnostics: [], recentEdits: [],
            includeContext: false,
        });
        assert.strictEqual(result, `<p>${prefix}</p><s>${suffix}</s>`);
    });

    test('renders bounded language-safe context for FIM prefixes', () => {
        const context = new GhostPromptFactory().createContext({
            languageId: 'yaml',
            diagnostics: [{ line: 3, severity: 'error', message: 'missing value' }],
            recentEdits: ['services:'],
            relatedFiles: [{ path: 'compose.yaml', snippet: 'services:\n  api:' }],
            maxContextChars: 500,
        });
        assert.ok(context.startsWith('# <copilot-context>'));
        assert.ok(context.includes('# language: yaml'));
        assert.ok(context.includes('# diagnostics: [Line 3] error: missing value'));
        assert.ok(context.includes('# </copilot-context>'));
        assert.ok(!context.includes('<|fim_prefix|>'));
    });

    test('keeps recent edits and related source ahead of verbose diagnostics under a tight budget', () => {
        const context = new GhostPromptFactory().createContext({
            languageId: 'typescript',
            diagnostics: [{ line: 8, severity: 'warning', message: 'diagnostic-' + 'x'.repeat(350) }],
            recentEdits: ['+ export const currentValue = helper();'],
            relatedFiles: [{ path: 'helper.ts', snippet: 'export function helper() {\n  return 42;\n}' }],
            maxContextChars: 400,
        });
        assert.ok(context.includes('currentValue = helper()'));
        assert.ok(context.includes('related file: helper.ts'));
        assert.ok(context.includes('export function helper()'));
        assert.ok(!context.includes('diagnostic-'));
        assert.ok(context.indexOf('related file: helper.ts') < context.indexOf('currentValue = helper()'));
        assert.ok(context.length <= 400);
    });
    test('should replace {prefix} and {suffix} placeholders', () => {
        const factory = new GhostPromptFactory();
        const template = '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>';
        const result = factory.createPrompt({
            template,
            prefix: 'function hello() {',
            suffix: '}',
            languageId: 'javascript',
            diagnostics: [],
            recentEdits: [],
        });
        assert.ok(result.includes('<|fim_prefix|>'));
        assert.ok(result.includes('// language: javascript'));
        assert.ok(result.includes('// </copilot-context>\n\nfunction hello() {'));
        assert.ok(result.includes('<|fim_suffix|>'));
        assert.ok(result.includes('<|fim_suffix|>}<|fim_middle|>'));
        assert.ok(result.includes('<|fim_middle|>'));
    });

    test('should prepend language ID context', () => {
        const factory = new GhostPromptFactory();
        const result = factory.createPrompt({
            template: '{prefix}',
            prefix: 'code',
            suffix: '',
            languageId: 'typescript',
            diagnostics: [],
            recentEdits: [],
        });
        assert.ok(result.includes('// language: typescript'));
    });

    test('should use # for Python/Ruby/Shell languages', () => {
        const factory = new GhostPromptFactory();
        const result = factory.createPrompt({
            template: '{prefix}',
            prefix: 'code',
            suffix: '',
            languageId: 'python',
            diagnostics: [],
            recentEdits: [],
        });
        assert.ok(result.includes('# language: python'));
    });

    test('uses language-valid context wrappers for SQL, HTML, and CSS', () => {
        const factory = new GhostPromptFactory();
        assert.ok(factory.createContext({ languageId: 'sql', diagnostics: [], recentEdits: [] })
            .includes('-- language: sql'));
        const html = factory.createContext({ languageId: 'html', diagnostics: [], recentEdits: [] });
        assert.ok(html.startsWith('<!-- <copilot-context>'));
        assert.ok(html.includes('</copilot-context> -->'));
        assert.strictEqual((html.match(/<!--/g) ?? []).length, 1);
        const markdown = factory.createContext({ languageId: 'markdown', diagnostics: [], recentEdits: [] });
        assert.ok(markdown.startsWith('<!-- <copilot-context>'));
        const css = factory.createContext({ languageId: 'css', diagnostics: [], recentEdits: [] });
        assert.ok(css.startsWith('/* <copilot-context>'));
        assert.ok(css.includes(' */'));
    });

    test('escapes embedded block comment terminators without exceeding the context budget', () => {
        const factory = new GhostPromptFactory();
        const html = factory.createContext({
            languageId: 'html', diagnostics: [], recentEdits: ['<!-- old -->'], maxContextChars: 260,
        });
        assert.ok(html.includes('<!- - old - ->'));
        assert.strictEqual((html.match(/-->/g) ?? []).length, 1);
        assert.ok(html.length <= 260);
        const css = factory.createContext({
            languageId: 'css', diagnostics: [], recentEdits: ['/* old */'], maxContextChars: 260,
        });
        assert.ok(css.includes('* /'));
        assert.strictEqual((css.match(/\*\//g) ?? []).length, 1);
        assert.ok(css.length <= 260);
    });

    test('should prepend diagnostics summary', () => {
        const factory = new GhostPromptFactory();
        const diagnostics: DiagnosticSummary[] = [
            { line: 3, severity: 'error', message: 'Cannot find name "foo"' },
        ];
        const result = factory.createPrompt({
            template: '{prefix}',
            prefix: 'code',
            suffix: '',
            languageId: 'python',
            diagnostics,
            recentEdits: [],
        });
        assert.ok(result.includes('# diagnostics: [Line 3] error: Cannot find name "foo"'));
    });

    test('includes diagnostic coordinates and compiler code', () => {
        const context = new GhostPromptFactory().createContext({
            languageId: 'typescript', recentEdits: [],
            diagnostics: [{ line: 4, column: 8, severity: 'error', source: 'ts', code: '2304', message: 'Unknown name' }],
        });
        assert.ok(context.includes('// diagnostics: [Line 4, Col 8] error TS2304: Unknown name'));
    });

    test('keeps every line of a diagnostic inside the language comment', () => {
        const context = new GhostPromptFactory().createContext({
            languageId: 'yaml',
            diagnostics: [{ line: 4, severity: 'warning', message: 'invalid mapping\nexpected an indented value' }],
            recentEdits: [],
        });
        assert.ok(context.includes('# diagnostics: [Line 4] warning: invalid mapping\n#   expected an indented value'));
        assert.ok(!context.includes('\nexpected an indented value'));
    });

    test('should prepend recent edits', () => {
        const factory = new GhostPromptFactory();
        const result = factory.createPrompt({
            template: '{prefix}',
            prefix: 'code',
            suffix: '',
            languageId: 'go',
            diagnostics: [],
            recentEdits: ['+  func Add(a, b int) int {', '+    return a + b', '+  }'],
        });
        assert.ok(result.includes('// recent edits:'));
        assert.ok(result.includes('Do not suggest code that has been deleted.'));
        assert.ok(result.includes('+  func Add(a, b int) int {'));
    });

    test('keeps the newest recent edit nearest the current code', () => {
        const factory = new GhostPromptFactory();
        const context = factory.createContext({
            languageId: 'typescript', diagnostics: [],
            recentEdits: ['older edit', 'newer edit'],
        });
        assert.ok(context.indexOf('older edit') < context.indexOf('newer edit'));
        assert.ok(context.indexOf('newer edit') < context.indexOf('</copilot-context>'));
        const newestOnly = factory.createContext({
            languageId: 'typescript', diagnostics: [], recentEdits: ['newer edit'],
        });
        const tight = factory.createContext({
            languageId: 'typescript', diagnostics: [],
            recentEdits: ['older edit that uses extra context', 'newer edit'],
            maxContextChars: newestOnly.length,
        });
        assert.ok(tight.includes('newer edit'));
        assert.ok(!tight.includes('older edit'));
    });

    test('comments every line of a recent diff and keeps it within the context budget', () => {
        const factory = new GhostPromptFactory();
        const edit = '@@ helper.ts:2 @@\n- const value = 1;\n+ const value = 2;';
        const context = factory.createContext({
            languageId: 'typescript', diagnostics: [], recentEdits: [edit], maxContextChars: 320,
        });
        assert.ok(context.includes('// @@ helper.ts:2 @@\n// - const value = 1;\n// + const value = 2;'));
        assert.ok(context.length <= 320);
        const tiny = factory.createContext({
            languageId: 'typescript', diagnostics: [], recentEdits: [edit], maxContextChars: 95,
        });
        assert.ok(!tiny.includes('@@ helper.ts'));
        assert.ok(!tiny.includes('- const value'));
        assert.ok(!tiny.includes('recent edits:'));
    });

    test('does not include a related-file label without source content', () => {
        const context = new GhostPromptFactory().createContext({
            languageId: 'typescript', diagnostics: [], recentEdits: [], maxContextChars: 120,
            relatedFiles: [{ path: 'helper.ts', snippet: 'export const value = ' + 'x'.repeat(200) }],
        });
        assert.ok(!context.includes('related file: helper.ts'));
        assert.ok(context.length <= 120);
    });

    test('can leave source prefix raw when context is sent separately', () => {
        const result = new GhostPromptFactory().createPrompt({
            template: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
            prefix: 'services:\n  web:',
            suffix: '',
            languageId: 'yaml',
            diagnostics: [{ line: 2, severity: 'error', message: 'missing value' }],
            recentEdits: ['services:'],
            includeContext: false,
        });
        assert.strictEqual(result, '<|fim_prefix|>services:\n  web:<|fim_suffix|><|fim_middle|>');
    });

    test('includes related file context in an FIM prefix', () => {
        const factory = new GhostPromptFactory();
        const result = factory.createPrompt({
            template: '{prefix}', prefix: 'callHelper(', suffix: '', languageId: 'typescript',
            diagnostics: [], recentEdits: [],
            relatedFiles: [{ path: 'src/helper.ts', snippet: 'export function helper() {}' }],
        });
        assert.ok(result.includes('related file: src/helper.ts'));
        assert.ok(result.includes('export function helper() {}'));
        assert.ok(result.endsWith('callHelper('));
    });

    test('should not include empty sections', () => {
        const factory = new GhostPromptFactory();
        const result = factory.createPrompt({
            template: '{prefix}',
            prefix: 'code',
            suffix: '',
            languageId: 'javascript',
            diagnostics: [],
            recentEdits: [],
        });
        assert.ok(!result.includes('diagnostics'));
        assert.ok(!result.includes('recent edits'));
    });

    test('should cap diagnostics at 5 entries', () => {
        const factory = new GhostPromptFactory();
        const diagnostics: DiagnosticSummary[] = [
            { line: 1, severity: 'error', message: 'err1' },
            { line: 2, severity: 'error', message: 'err2' },
            { line: 3, severity: 'error', message: 'err3' },
            { line: 4, severity: 'error', message: 'err4' },
            { line: 5, severity: 'error', message: 'err5' },
            { line: 6, severity: 'error', message: 'err6' },
        ];
        const result = factory.createPrompt({
            template: '{prefix}',
            prefix: 'code',
            suffix: '',
            languageId: 'javascript',
            diagnostics,
            recentEdits: [],
        });
        // Only 5 diagnostics should appear
        const matches = result.match(/diagnostics:/g);
        assert.strictEqual(matches?.length, 5);
    });
});
