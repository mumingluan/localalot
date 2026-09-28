import * as assert from 'assert';
import {
    BoundaryMarkerParser,
    CodeFenceParser,
    CursorTagStripper,
    ResponsePipeline,
    ResponsePipelineContext,
} from '../../../completions/nes/response/responsePipeline';
import { ResponseDiffer } from '../../../completions/nes/response/responseDiffer';

function makeContext(overrides?: Partial<ResponsePipelineContext>): ResponsePipelineContext {
    return {
        editWindowHadCursorTag: false,
        ...overrides,
    };
}

suite('BoundaryMarkerParser', () => {
    test('extracts lines between boundary markers', () => {
        const parser = new BoundaryMarkerParser();
        const input = [
            'some prefix',
            '###remain edit start boundary line###',
            'line1',
            'line2',
            '###remain edit end boundary line###',
            'some suffix',
        ];
        const result = parser.process(input, makeContext());
        assert.deepStrictEqual(result, ['line1', 'line2']);
    });

    test('preserves internal blank lines when no markers are present', () => {
        const parser = new BoundaryMarkerParser();
        const input = ['line1', 'line2', '', 'line3'];
        const result = parser.process(input, makeContext());
        assert.deepStrictEqual(result, input);
    });

    test('rejects a response with only an end marker', () => {
        const parser = new BoundaryMarkerParser();
        const input = [
            'line1',
            '###remain edit end boundary line###',
            'line2',
        ];
        const result = parser.process(input, makeContext());
        assert.deepStrictEqual(result, []);
    });

    test('rejects a response with only a start marker', () => {
        const parser = new BoundaryMarkerParser();
        const input = [
            '###remain edit start boundary line###',
            'line1',
            'line2',
        ];
        const result = parser.process(input, makeContext());
        assert.deepStrictEqual(result, []);
    });

    test('marker matching trims whitespace', () => {
        const parser = new BoundaryMarkerParser();
        const input = [
            '  ###remain edit start boundary line###  ',
            'line1',
            '  ###remain edit end boundary line###  ',
        ];
        const result = parser.process(input, makeContext());
        assert.deepStrictEqual(result, ['line1']);
    });
    test('pairs a start marker with the following end marker', () => {
        const parser = new BoundaryMarkerParser();
        assert.deepStrictEqual(parser.process([
            '###remain edit end boundary line###',
            '###remain edit start boundary line###',
            'updated();',
            '###remain edit end boundary line###',
        ], makeContext()), ['updated();']);
    });
});

suite('CursorTagStripper', () => {
    test('removes cursor tags when edit window had no tag', () => {
        const stripper = new CursorTagStripper();
        const input = ['  line<|cursor|>here', '<|cursor|>start'];
        const result = stripper.process(input, makeContext({ editWindowHadCursorTag: false }));
        assert.deepStrictEqual(result, ['  linehere', 'start']);
    });

    test('preserves cursor tags when edit window had tag', () => {
        const stripper = new CursorTagStripper();
        const input = ['  line<|cursor|>here'];
        const result = stripper.process(input, makeContext({ editWindowHadCursorTag: true }));
        assert.deepStrictEqual(result, ['  line<|cursor|>here']);
    });
});

suite('CodeFenceParser', () => {
    test('removes an outer TypeScript fence and keeps blank lines inside', () => {
        const parser = new CodeFenceParser();
        assert.deepStrictEqual(parser.process([
            '```ts', 'const one = 1;', '', 'const two = 2;', '```',
        ], makeContext({ languageId: 'typescript', originalEditWindowLines: ['const one = 0;'] })), [
            'const one = 1;', '', 'const two = 2;',
        ]);
        assert.deepStrictEqual(parser.process([
            '``` ts', 'const value = 2;', '```',
        ], makeContext({ languageId: 'typescript', originalEditWindowLines: ['const value = 1;'] })), [
            'const value = 2;',
        ]);
    });

    test('removes a complete tilde fence but waits for its closing marker in a stream', () => {
        const parser = new CodeFenceParser();
        const lines = ['~~~ts', 'const value = 2;', '~~~'];
        assert.deepStrictEqual(parser.process(lines, makeContext({
            languageId: 'typescript', originalEditWindowLines: ['const value = 1;'],
        })), ['const value = 2;']);
        const pipeline = new ResponsePipeline();
        assert.strictEqual(pipeline.processCompletedMarkedPrefix(
            '###remain edit start boundary line###\n~~~ts\nconst value = 2;\n',
            makeContext({ languageId: 'typescript' }),
        ), undefined);
    });

    test('preserves fences in Markdown and existing fenced source', () => {
        const parser = new CodeFenceParser();
        const lines = ['```ts', 'const value = 1;', '```'];
        assert.deepStrictEqual(parser.process(lines, makeContext({ languageId: 'markdown' })), lines);
        assert.deepStrictEqual(parser.process(lines, makeContext({
            languageId: 'typescript', originalEditWindowLines: ['```ts', 'old', '```'],
        })), lines);
    });

    test('does not remove a fence that is not an outer wrapper', () => {
        const parser = new CodeFenceParser();
        const lines = ['const text = `', '```ts', 'example', '```', '`;'];
        assert.deepStrictEqual(parser.process(lines, makeContext({ languageId: 'typescript' })), lines);
    });

    test('rejects an incomplete outer code fence', () => {
        const parser = new CodeFenceParser();
        assert.deepStrictEqual(parser.process(['```ts', 'const value = 2;'], makeContext({
            languageId: 'typescript', originalEditWindowLines: ['const value = 1;'],
        })), []);
    });
});

suite('ResponsePipeline', () => {
    test('exposes only newline-terminated lines inside an open marked response', () => {
        const pipeline = new ResponsePipeline();
        const context = makeContext();
        const start = '###remain edit start boundary line###\n';
        assert.deepStrictEqual(pipeline.processCompletedMarkedPrefix(
            start + 'old();\nanchor();\nunfinished', context,
        ), ['old();', 'anchor();']);
        assert.deepStrictEqual(pipeline.processCompletedMarkedPrefix(
            '###remain edit start boundary line###\r\nold();\r\nanchor();\r\nunfinished', context,
        ), ['old();', 'anchor();']);
        assert.strictEqual(pipeline.processCompletedMarkedPrefix(
            'old();\nanchor();\n', context,
        ), undefined);
        assert.strictEqual(pipeline.processCompletedMarkedPrefix(
            start + '```ts\nold();\n', context,
        ), undefined);
    });

    test('recognizes only a complete empty marked window as a deletion', () => {
        const pipeline = new ResponsePipeline();
        const start = '###remain edit start boundary line###';
        const end = '###remain edit end boundary line###';
        assert.strictEqual(pipeline.isExplicitDeletion(`${start}\n${end}`), true);
        assert.strictEqual(pipeline.isExplicitDeletion(`\n${start}\r\n${end}\n`), true);
        assert.strictEqual(pipeline.isExplicitDeletion(`<think>remove the obsolete line</think>\n${start}\n${end}`), true);
        assert.strictEqual(pipeline.isExplicitDeletion(`\`\`\`ts\n${start}\n${end}\n\`\`\``), true);
        assert.strictEqual(pipeline.isExplicitDeletion(`~~~ts\n${start}\n${end}\n~~~`), true);
        for (const response of [
            `${start}\n`,
            `${start}\n\n${end}`,
            `${start}\n  \n${end}`,
            `${start}\n###remain edit end boundary`,
            `${start}\ncode\n${end}`,
            `explanation\n${start}\n${end}`,
            `${start}\n${end}\nextra`,
            `<think>unfinished\n${start}\n${end}`,
            `\`\`\`ts\n${start}\n${end}\n~~~`,
            `${start}\n<think>uncertain</think>\n${end}`,
            '',
        ]) {
            assert.strictEqual(pipeline.isExplicitDeletion(response), false, response);
        }
    });

    test('full pipeline: boundary parse → cursor strip', () => {
        const pipeline = new ResponsePipeline();
        const raw = [
            'prefix',
            '###remain edit start boundary line###',
            '  const<|cursor|> x = 1;',
            '  suffix A',
            '###remain edit end boundary line###',
            'extra',
        ].join('\n');

        const ctx = makeContext({ editWindowHadCursorTag: false });
        const result = pipeline.process(raw, ctx);
        // Cursor tag stripped: '  const x = 1;', '  suffix A'
        assert.deepStrictEqual(result, ['  const x = 1;', '  suffix A']);
    });

    test('trailing blank lines are trimmed', () => {
        const pipeline = new ResponsePipeline();
        const raw = [
            '###remain edit start boundary line###',
            'line',
            '###remain edit end boundary line###',
            '',
            '',
        ].join('\n');

        const result = pipeline.process(raw, makeContext());
        assert.deepStrictEqual(result, ['line']);
    });

    test('keeps a blank line inside a complete marked edit window', () => {
        const pipeline = new ResponsePipeline();
        const response = [
            '###remain edit start boundary line###',
            'const value = 2;',
            '',
            '###remain edit end boundary line###',
        ].join('\n');
        const lines = pipeline.process(response, makeContext());
        assert.deepStrictEqual(lines, ['const value = 2;', '']);
        assert.deepStrictEqual(new ResponseDiffer().compute(['const value = 2;', ''], lines), []);
        assert.deepStrictEqual(pipeline.process('const value = 2;\n\n', makeContext()), ['const value = 2;']);
    });

    test('normalizes CRLF responses before diffing edit lines', () => {
        const pipeline = new ResponsePipeline();
        const result = pipeline.process(
            '###remain edit start boundary line###\r\nconst value = 2;\r\n###remain edit end boundary line###',
            makeContext(),
        );
        assert.deepStrictEqual(result, ['const value = 2;']);
    });

    test('keeps an internal blank line in an unmarked full edit response', () => {
        const pipeline = new ResponsePipeline();
        const result = pipeline.process('function one() {}\n\nfunction two() {}\n', makeContext());
        assert.deepStrictEqual(result, ['function one() {}', '', 'function two() {}']);
        assert.deepStrictEqual(new ResponseDiffer().compute(
            ['function one() {}', '', 'function two() {}'], result,
        ), []);
    });

    test('extracts a complete fenced edit before diffing', () => {
        const pipeline = new ResponsePipeline();
        const result = pipeline.process('```ts\nconst value = 2;\n```', makeContext({
            languageId: 'typescript', originalEditWindowLines: ['const value = 1;'],
        }));
        assert.deepStrictEqual(result, ['const value = 2;']);
    });

    test('custom stages can be injected', () => {
        let processed = false;
        const customStage = {
            name: 'test',
            process(lines: string[]) { processed = true; return lines; },
        };
        const pipeline = new ResponsePipeline([customStage as any]);
        pipeline.process('hello', makeContext());
        assert.strictEqual(processed, true);
    });
});
