import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { BlockPositionType, getBlockPositionType, TerseBlockTrimmer, VerboseBlockTrimmer, trimCompletion } from '../../completions/ghost/blockTrimmer';
import { setWasmDirPath } from '../../completions/ghost/multiline/treeSitter/fileLoader';

suite('BlockTrimmer', () => {
    setup(() => setWasmDirPath(path.resolve(__dirname, '../../..')));

    test('TerseBlockTrimmer should stop at blank line', () => {
        const trimmer = new TerseBlockTrimmer();
        const input = 'line1\n\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11';
        const result = trimmer.trim(input);
        assert.ok(!result.includes('line3'));
    });

    test('TerseBlockTrimmer should allow text shorter than max', () => {
        const trimmer = new TerseBlockTrimmer();
        const result = trimmer.trim('line1\nline2');
        assert.strictEqual(result, 'line1\nline2');
    });

    test('VerboseBlockTrimmer should allow more lines', () => {
        const trimmer = new VerboseBlockTrimmer();
        const lines = Array.from({ length: 50 }, (_, i) => `line${i}`);
        const result = trimmer.trim(lines.join('\n'));
        assert.ok(result.split('\n').length <= 40);
    });

    test('server-mode YAML keeps a long generated mapping without a fixed line cap', async () => {
        const content = 'services:\n  web:';
        const document = await vscode.workspace.openTextDocument({ language: 'yaml', content });
        const position = new vscode.Position(1, 6);
        const fields = Array.from({ length: 45 }, (_, index) => `    field${index}: value${index}`).join('\n');
        const completion = `\n${fields}`;
        assert.strictEqual(await trimCompletion(document, position, content, completion, true), completion);
    });

    test('single-line response keeps only the first generated line', async () => {
        const content = 'const total = ';
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content });
        const position = new vscode.Position(0, content.length);
        assert.strictEqual(await trimCompletion(document, position, content, '42;\nconsole.log(total);', false), '42;');
        assert.strictEqual(await trimCompletion(document, position, content, '\n    calculateTotal(order);\nignored();', false),
            '\n    calculateTotal(order);');
        assert.strictEqual(await trimCompletion(document, position, content, '\r\n    calculateTotal(order);\nignored();', false),
            '\r\n    calculateTotal(order);');
        assert.strictEqual(await trimCompletion(document, position, content, '\r\n    calculateTotal(order);\r\nignored();', false),
            '\r\n    calculateTotal(order);');
    });

    test('multiline completion stops after the current TypeScript block', async () => {
        const content = 'function first() {\n    \n}\nfunction later() {}';
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content });
        const position = new vscode.Position(1, 4);
        const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
        const completion = 'const value = 1;\n}\nfunction unrelated() {\n    return 2;\n}';
        const result = await trimCompletion(document, position, prefix, completion, true);
        assert.ok(result.startsWith('const value = 1;'));
        assert.ok(!result.includes('function unrelated'));
    });

    test('CRLF document trims a TypeScript block using the normalized prefix offset', async () => {
        const header = Array.from({ length: 20 }, (_, index) => `// context ${index}`).join('\r\n');
        const content = `${header}\r\nfunction first() {\r\n    `;
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content });
        const position = new vscode.Position(21, 4);
        const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position))
            .replace(/\r\n|\r/g, '\n');
        const completion = 'const value = 1;\n}\nfunction unrelated() {\n    return 2;\n}';
        assert.strictEqual(await trimCompletion(document, position, prefix, completion, true),
            'const value = 1;\n}');
    });

    test('Unicode context keeps TypeScript block boundaries at the cursor', async () => {
        const content = '// 中文 😀\nfunction first() {\n    ';
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content });
        const position = new vscode.Position(2, 4);
        const completion = 'const value = 1;\n}\nfunction unrelated() {\n    return 2;\n}';
        assert.strictEqual(await trimCompletion(document, position, content, completion, true),
            'const value = 1;\n}');
    });

    test('C++ completion keeps nested braces and stops after its containing block', async () => {
        const content = 'void render() {\n    ';
        const document = await vscode.workspace.openTextDocument({ language: 'cpp', content });
        const position = new vscode.Position(1, 4);
        const completion = 'if (ready) {\n        draw();\n    }\n    done();\n}\nvoid unrelated() {}';
        assert.strictEqual(await trimCompletion(document, position, content, completion, true),
            'if (ready) {\n        draw();\n    }\n    done();\n}');
    });

    test('Java, C# and PHP retain the current method after nested blocks', async () => {
        for (const [language, prefix, completion, expected] of [
            [
                'java',
                'class App {\n  void run() {\n    ',
                'if (ready) {\n      work();\n    }\n    done();\n  }\n  void other() {}\n}',
                'if (ready) {\n      work();\n    }\n    done();\n  }',
            ],
            [
                'csharp',
                'class App {\n  void Run() {\n    ',
                'if (ready) {\n      Work();\n    }\n    Done();\n  }\n  void Other() {}\n}',
                'if (ready) {\n      Work();\n    }\n    Done();\n  }',
            ],
            [
                'php',
                '<?php\nfunction run() {\n    ',
                'if ($ready) {\n        work();\n    }\n    done();\n}\nfunction other() {}',
                'if ($ready) {\n        work();\n    }\n    done();\n}',
            ],
        ] as const) {
            const document = await vscode.workspace.openTextDocument({ language, content: prefix });
            const position = document.positionAt(prefix.length);
            assert.strictEqual(await trimCompletion(document, position, prefix, completion, true), expected, language);
        }
    });

    test('server-mode CSS ignores braces in comments and strings', async () => {
        const content = 'body {\n  ';
        const document = await vscode.workspace.openTextDocument({ language: 'css', content });
        const position = new vscode.Position(1, 2);
        const completion = 'content: "}";\n  /* } */\n  color: red;\n}\nh1 { color: blue; }';
        assert.strictEqual(await trimCompletion(document, position, content, completion, true),
            'content: "}";\n  /* } */\n  color: red;\n}');
    });

    test('server-mode completion without an open brace keeps top-level declarations', async () => {
        const content = '/* styles */\n';
        const document = await vscode.workspace.openTextDocument({ language: 'css', content });
        const position = new vscode.Position(1, 0);
        const completion = 'body { color: red; }\nh1 { color: blue; }';
        assert.strictEqual(await trimCompletion(document, position, content, completion, true), completion);
    });

    test('YAML multiline completion stops at the next same-level key', async () => {
        const content = 'services:\n  web:';
        const document = await vscode.workspace.openTextDocument({ language: 'yaml', content });
        const position = new vscode.Position(1, 7);
        const prefix = content;
        const completion = '\n    image: nginx\n    ports:\n      - "80:80"\n  worker:\n    image: worker';
        const result = await trimCompletion(document, position, prefix, completion, true);
        assert.ok(result.includes('ports:'));
        assert.ok(!result.includes('worker:'));
    });

    test('YAML indented blank line keeps sibling fields inside the current mapping', async () => {
        const content = 'services:\n  web:\n    ';
        const document = await vscode.workspace.openTextDocument({ language: 'yaml', content });
        const position = new vscode.Position(2, 4);
        const completion = 'image: nginx\n    ports:\n      - "80:80"\n  worker:\n    image: worker';
        const result = await trimCompletion(document, position, content, completion, true);
        assert.ok(result.includes('ports:'));
        assert.ok(result.includes('80:80'));
        assert.ok(!result.includes('worker:'));
    });

    test('YAML dedented sibling keeps its nested fields', async () => {
        const content = 'services:\n  web:\n    image: nginx';
        const document = await vscode.workspace.openTextDocument({ language: 'yaml', content });
        const position = new vscode.Position(2, document.lineAt(2).text.length);
        const completion = '\n  worker:\n    image: redis\n  database:\n    image: postgres';
        assert.strictEqual(await trimCompletion(document, position, content, completion, true),
            '\n  worker:\n    image: redis');
    });
    test('YAML root-level continuation stops after the first new mapping node', async () => {
        const content = 'name: demo';
        const document = await vscode.workspace.openTextDocument({ language: 'yaml', content });
        const position = new vscode.Position(0, content.length);
        const completion = '\nservices:\n  web:\n    image: nginx\nversion: 1';
        assert.strictEqual(await trimCompletion(document, position, content, completion, true),
            '\nservices:\n  web:\n    image: nginx');
        const withLeadingComment = '\n# generated configuration\nservices:\n  web:\n    image: nginx\nversion: 1';
        assert.strictEqual(await trimCompletion(document, position, content, withLeadingComment, true),
            '\n# generated configuration\nservices:\n  web:\n    image: nginx');
    });
    test('accepted YAML follow-up keeps sibling keys within the short line limit', async () => {
        const content = 'name: demo';
        const document = await vscode.workspace.openTextDocument({ language: 'yaml', content });
        const position = new vscode.Position(0, content.length);
        const completion = '\nservices:\nversion: 1';
        assert.strictEqual(await trimCompletion(document, position, content, completion, true), '\nservices:');
        assert.strictEqual(await trimCompletion(document, position, content, completion, true, 3), completion);
    });
    test('YAML completed field keeps later fields in the same mapping', async () => {
        const content = 'services:\n  web:\n    image: nginx';
        const document = await vscode.workspace.openTextDocument({ language: 'yaml', content });
        const position = new vscode.Position(2, document.lineAt(2).text.length);
        const completion = '\n    ports:\n      - "80:80"\n    environment:\n      MODE: production\n  worker:\n    image: worker';
        assert.strictEqual(await trimCompletion(document, position, content, completion, true),
            '\n    ports:\n      - "80:80"\n    environment:\n      MODE: production');
    });

    test('YAML completed list item keeps its fields but stops before the next item', async () => {
        const content = 'services:\n  - name: web';
        const document = await vscode.workspace.openTextDocument({ language: 'yaml', content });
        const completion = '\n    image: nginx\n    ports:\n      - "80:80"\n  - name: worker\n    image: worker';
        assert.strictEqual(await trimCompletion(document,
            document.lineAt(1).range.end, content, completion, true),
            '\n    image: nginx\n    ports:\n      - "80:80"');
    });

    test('YAML block scalar treats indented hash lines as content', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'yaml', content: 'script: |',
        });
        const completion = '\n  #!/bin/sh\n  echo ready\nnext: value';
        assert.strictEqual(await trimCompletion(document, new vscode.Position(0, 9),
            document.getText(), completion, true), '\n  #!/bin/sh\n  echo ready');
    });

    test('YAML list block scalar stops before the next list item', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'yaml', content: 'steps:\n  - |',
        });
        const completion = '\n      # heading\n      content\n  - next';
        assert.strictEqual(await trimCompletion(document, new vscode.Position(1, 5),
            document.getText(), completion, true), '\n      # heading\n      content');
    });

    test('JSON scalar multiline result is limited to the value line', async () => {
        const content = '{\n  "name":';
        const document = await vscode.workspace.openTextDocument({ language: 'json', content });
        const position = new vscode.Position(1, 9);
        const result = await trimCompletion(document, position, content, ' "demo"\n}', true);
        assert.strictEqual(result, ' "demo"');
        assert.strictEqual(await trimCompletion(document, position, content, ' "demo"\n}', true, 3),
            ' "demo"\n}');
    });
    test('JSON property value keeps following properties in the same object', async () => {
        const content = '{\n  "name":';
        const document = await vscode.workspace.openTextDocument({ language: 'json', content });
        const position = new vscode.Position(1, 9);
        const completion = ' "demo",\n  "enabled": true\n}\n{"unrelated": true}';
        assert.strictEqual(await trimCompletion(document, position, content, completion, true),
            ' "demo",\n  "enabled": true\n}');
    });

    test('JSON nested value stops at its own closing bracket without a comma', async () => {
        const content = '{\n  "web":';
        const document = await vscode.workspace.openTextDocument({ language: 'json', content });
        const position = document.lineAt(1).range.end;
        assert.strictEqual(await trimCompletion(document, position, content,
            ' {\n    "image": "nginx"\n  }\n}\n{"unrelated": true}', true),
            ' {\n    "image": "nginx"\n  }');
        assert.strictEqual(await trimCompletion(document, position, content,
            ' [\n    "nginx"\n  ]\n}', true),
            ' [\n    "nginx"\n  ]');
    });

    test('JSON nested value with a comma keeps following properties', async () => {
        const content = '{\n  "web":';
        const document = await vscode.workspace.openTextDocument({ language: 'json', content });
        const completion = ' { "image": "nginx" },\n  "enabled": true\n}\n{"unrelated": true}';
        assert.strictEqual(await trimCompletion(document, document.lineAt(1).range.end,
            content, completion, true),
            ' { "image": "nginx" },\n  "enabled": true\n}');
    });

    test('JSONC nested value keeps siblings after comment trivia and a comma', async () => {
        const content = '{\n  "web":';
        const document = await vscode.workspace.openTextDocument({ language: 'jsonc', content });
        const completion = ' { "image": "nginx" } /* note */\n  , "enabled": true\n}\nnext';
        assert.strictEqual(await trimCompletion(document, document.lineAt(1).range.end,
            content, completion, true),
            ' { "image": "nginx" } /* note */\n  , "enabled": true\n}');
    });

    test('JSON property value keeps a continuation comma on the following line', async () => {
        const content = '{\n  "name":';
        const document = await vscode.workspace.openTextDocument({ language: 'json', content });
        const position = new vscode.Position(1, 9);
        const completion = ' "demo"\n  , "enabled": true\n}\n{"unrelated": true}';
        assert.strictEqual(await trimCompletion(document, position, content, completion, true),
            ' "demo"\n  , "enabled": true\n}');
    });

    test('JSONC property value keeps a comma followed by a block comment', async () => {
        const content = '{\n  "name":';
        const document = await vscode.workspace.openTextDocument({ language: 'jsonc', content });
        const position = new vscode.Position(1, 9);
        const completion = ' "demo", /* model note */\n  "enabled": true\n}\n{"unrelated": true}';
        assert.strictEqual(await trimCompletion(document, position, content, completion, true),
            ' "demo", /* model note */\n  "enabled": true\n}');
    });

    test('JSON multiline result keeps properties through the current object close', async () => {
        const content = '{\n  ';
        const document = await vscode.workspace.openTextDocument({ language: 'json', content });
        const position = new vscode.Position(1, 2);
        const completion = '"name": "a}b",\n  "nested": { "enabled": true },\n  "count": 2\n}\n{"unrelated": true}';
        const result = await trimCompletion(document, position, content, completion, true);
        assert.ok(result.includes('"count": 2'));
        assert.ok(result.endsWith('\n}'));
        assert.ok(!result.includes('unrelated'));
    });

    test('JSONC comments with braces do not close a generated object', async () => {
        const content = '{\n  ';
        const document = await vscode.workspace.openTextDocument({ language: 'jsonc', content });
        const position = new vscode.Position(1, 2);
        const completion = '// }\n  "first": 1,\n  /* } */ "second": 2\n}\nnext';
        const result = await trimCompletion(document, position, content, completion, true);
        assert.ok(result.includes('"second": 2'));
        assert.ok(!result.includes('next'));
    });

    test('JSON string braces at the cursor do not end a multiline object', async () => {
        const content = '{\n  "message": "contains ';
        const document = await vscode.workspace.openTextDocument({ language: 'json', content });
        const position = new vscode.Position(1, document.lineAt(1).text.length);
        const completion = '} literally",\n  "enabled": true\n}\n{"unrelated": true}';
        assert.strictEqual(await trimCompletion(document, position, content, completion, true),
            '} literally",\n  "enabled": true\n}');
    });

    test('JSONC line comment at the cursor ignores generated braces until newline', async () => {
        const content = '{\n  // note: ';
        const document = await vscode.workspace.openTextDocument({ language: 'jsonc', content });
        const position = new vscode.Position(1, document.lineAt(1).text.length);
        const completion = '} is just a comment\n  "enabled": true\n}\n{"unrelated": true}';
        assert.strictEqual(await trimCompletion(document, position, content, completion, true),
            '} is just a comment\n  "enabled": true\n}');
    });

    test('accepted completion is bounded to the native short follow-up block', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const value = 1;' });
        const position = new vscode.Position(0, document.lineAt(0).text.length);
        const result = await trimCompletion(
            document,
            position,
            document.getText(),
            'a\nb\nc\nd\ne',
            true,
            3,
        );
        assert.strictEqual(result, 'a\nb\nc');
    });

    test('classifies cursor position inside a parsed TypeScript block', async () => {
        const empty = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'function f() {\n    \n}' });
        assert.strictEqual(await getBlockPositionType(empty, new vscode.Position(1, 4)), BlockPositionType.EmptyBlock);

        const blockEnd = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'function f() {\n    return 1;\n    \n}' });
        assert.strictEqual(await getBlockPositionType(blockEnd, new vscode.Position(2, 4)), BlockPositionType.BlockEnd);

        const midBlock = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'function f() {\n    const a = 1;\n    \n    return a;\n}' });
        assert.strictEqual(await getBlockPositionType(midBlock, new vscode.Position(2, 4)), BlockPositionType.MidBlock);
    });

    test('classifies a Python cursor before the next statement as mid-block', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'python', content: 'def f():\n    \n    return 1' });
        assert.strictEqual(await getBlockPositionType(document, new vscode.Position(1, 4)), BlockPositionType.MidBlock);
    });
});
