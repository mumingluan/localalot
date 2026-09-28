import * as assert from 'assert';
import * as vscode from 'vscode';
import { PromptAssembler } from '../../../completions/nes/core/promptAssembler';
import { EditWindowResolver } from '../../../completions/nes/core/editWindowResolver';
import { StringText } from '../../../completions/nes/stubs/abstractText';
import { OffsetRange } from '../../../completions/nes/stubs/offsetRange';
import { StringEdit, StringReplacement } from '../../../completions/nes/stubs/stringEdit';
import { DocumentId } from '../../../completions/nes/stubs/types';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { countPromptTokens, ensurePromptTokenizerLoaded } from '../../../completions/nes/core/promptTokenizer';
import { effectiveNesOutputTokens } from '../../../completions/nes/core/nesModelBudget';
import { renderCompletionPrompt } from '../../../completions/nes/promptCraftingUtils';

suite('NES prompt assembly', () => {
    test('expands only the lower edit window after an accepted edit', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript',
            content: Array.from({ length: 30 }, (_, line) => `const value${line} = ${line};`).join('\n'),
        });
        const assembler = new PromptAssembler({} as never, new EditWindowResolver());
        const regular = assembler.assemble(document, new vscode.Position(12, 0), false, []);
        const expanded = assembler.assemble(document, new vscode.Position(12, 0), false, [], undefined, undefined, 10);
        assert.deepStrictEqual([regular.editWindowRange.start, regular.editWindowRange.endExclusive], [10, 18]);
        assert.deepStrictEqual([expanded.editWindowRange.start, expanded.editWindowRange.endExclusive], [10, 23]);
    });

    test('includes a TSX neighbor definition in the TypeScript edit prompt', async () => {
        const related = await vscode.workspace.openTextDocument({
            language: 'typescriptreact',
            content: 'export function uniqueTsxPromptHelper(invoice: Invoice) { return invoice.total; }',
        });
        const source = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const total = uniqueTsxPromptHelper(invoice);',
        });
        const assembly = new PromptAssembler({} as never, new EditWindowResolver())
            .assemble(source, new vscode.Position(0, 40), false, []);
        assert.ok(assembly.promptPieces.neighborSnippets?.some(item => item.uri === related.uri.toString()
            && item.snippet.includes('uniqueTsxPromptHelper')));
        assert.ok(assembly.userPrompt.includes('export function uniqueTsxPromptHelper'));
    });

    test('uses the detected language for a YAML template file in plaintext mode', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nes-language-'));
        const filePath = path.join(directory, 'docker-compose.yml.njk');
        let document: vscode.TextDocument | undefined;
        try {
            await fs.writeFile(filePath, 'services:\n  web:\n    image: nginx');
            const opened = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            document = await vscode.languages.setTextDocumentLanguage(opened, 'plaintext');
            const assembly = new PromptAssembler({} as never, new EditWindowResolver())
                .assemble(document, new vscode.Position(1, 6), false, []);
            assert.ok(assembly.userPrompt.includes('File language: yaml.'));
            assert.strictEqual(assembly.promptPieces.activeDoc.languageId, 'yaml');
        } finally {
            if (document) {
                await vscode.window.showTextDocument(document);
                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            }
            await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });

    test('reserves input space when output is configured above the model window', async () => {
        assert.strictEqual(effectiveNesOutputTokens(4_096, 9_216), 2_048);
        const document = await vscode.workspace.openTextDocument({
            language: 'yaml', content: 'services:\n  web:\n    image: nginx',
        });
        const config = {
            family: 'standard', endpoint: 'chat/completions', maxOutputTokens: 9_216,
            capabilities: { limits: { max_context_window_tokens: 4_096 } },
        };
        const assembly = new PromptAssembler(config as never, new EditWindowResolver())
            .assemble(document, new vscode.Position(1, 6), false, []);
        const inputTokens = countPromptTokens(`${assembly.systemPrompt}\n${assembly.userPrompt}`, 'standard') + 32;
        assert.ok(inputTokens <= 4_096 - 2_048 - 128);
        assert.ok(assembly.userPrompt.includes('web:<|cursor|>'));
    });

    test('fits a smaller model window while retaining the edit area', async () => {
        assert.strictEqual(await ensurePromptTokenizerLoaded(), true);
        const lines = Array.from({ length: 300 }, (_, index) =>
            `const generatedValue${index} = calculateResult(${index});`);
        lines[150] = 'const targetResult = calculateResult(input);';
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: lines.join('\n') });
        const config = {
            family: 'standard', endpoint: 'chat/completions', maxOutputTokens: 512,
            capabilities: { limits: { max_context_window_tokens: 2_400 } },
        };
        const assembly = new PromptAssembler(config as never, new EditWindowResolver()).assemble(
            document, new vscode.Position(150, 21), false, [], [{
                uri: vscode.Uri.file(path.join(os.tmpdir(), 'nes-window-related.ts')).toString(),
                relativePath: 'nes-window-related.ts',
                snippet: Array(35).fill('export const related = calculateResult(input);').join('\n'),
                lineRange: { startLine: 0, endLineExclusive: 35 }, score: 12,
            }],
        );
        const inputTokens = countPromptTokens(`${assembly.systemPrompt}\n${assembly.userPrompt}`, 'standard') + 32;
        assert.ok(inputTokens <= 2_400 - 512 - 128, `input tokens: ${inputTokens}`);
        assert.ok(assembly.userPrompt.replaceAll('<|cursor|>', '').includes('const targetResult = calculateResult(input);'));
        assert.ok(assembly.userPrompt.includes('<|cursor|>'));
        assert.ok(assembly.userPrompt.includes('<|code_to_edit|>'));
    });

    test('fits recent files and edit history into a small model window', async () => {
        assert.strictEqual(await ensurePromptTokenizerLoaded(), true);
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const target = calculateTotal(order);\nconsole.log(target);',
        });
        const history = Array.from({ length: 4 }, (_, index) => {
            const content = Array.from({ length: 80 }, (__, line) =>
                `export const recent${index}Value${line} = calculateTotal(order, ${line});`).join('\n');
            const docId = DocumentId.create(vscode.Uri.file(path.join(os.tmpdir(), `nes-budget-${index}.ts`)).toString());
            return {
                kind: 'visibleRanges' as const, docId,
                documentContent: new StringText(content),
                visibleRanges: [new OffsetRange(0, content.length)],
            };
        });
        const diffBase = new StringText('const before = calculateTotal(order);');
        const diff = {
            kind: 'edit' as const,
            docId: DocumentId.create(document.uri.toString()),
            edit: {
                base: diffBase,
                edit: StringEdit.single(new StringReplacement(
                    new OffsetRange(0, diffBase.toString().length),
                    'const after = calculateTotal(order);',
                )),
            },
        };
        const config = {
            family: 'standard', endpoint: 'chat/completions', maxOutputTokens: 512,
            capabilities: { limits: { max_context_window_tokens: 2_400 } },
        };
        const assembly = new PromptAssembler(config as never, new EditWindowResolver())
            .assemble(document, new vscode.Position(0, 27), false, [diff, ...history]);
        const inputTokens = countPromptTokens(`${assembly.systemPrompt}\n${assembly.userPrompt}`, 'standard') + 32;
        assert.ok(inputTokens <= 2_400 - 512 - 128, `input tokens: ${inputTokens}`);
        assert.ok(assembly.userPrompt.includes('calculateTotal(order)'));
        assert.ok(assembly.userPrompt.includes('<|cursor|>'));
        assert.ok(assembly.userPrompt.includes('<|code_to_edit|>'));
    });

    test('counts repeated completion-template placeholders in the final wire prompt', async () => {
        assert.strictEqual(await ensurePromptTokenizerLoaded(), true);
        const lines = Array.from({ length: 260 }, (_, index) =>
            `const longContext${index} = calculateResult(${index});`);
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: lines.join('\n') });
        const config = {
            family: 'standard', endpoint: 'completions', maxOutputTokens: 512,
            promptTemplate: 'SYSTEM:{system}\nUSER:{user}\nREPEAT:{user}',
            capabilities: { limits: { max_context_window_tokens: 5_000 } },
        };
        const assembly = new PromptAssembler(config as never, new EditWindowResolver())
            .assemble(document, new vscode.Position(130, 15), false, []);
        const request = renderCompletionPrompt(config.promptTemplate, assembly.systemPrompt, assembly.userPrompt);
        assert.ok(countPromptTokens(request, 'standard') <= 5_000 - 512 - 128);
        assert.ok(assembly.userPrompt.includes('<|cursor|>'));
    });

    test('keeps cursor facts and a distant definition from the same file', async () => {
        const lines = Array.from({ length: 380 }, (_, index) => `const filler${index} = ${index};`);
        lines[350] = 'function deepBillingRule(amount: number) { return amount * 2; }';
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: lines.join('\n') });
        const assembly = new PromptAssembler({} as never, new EditWindowResolver()).assemble(
            document,
            new vscode.Position(0, 10),
            false,
            [],
            [
                {
                    uri: document.uri.toString(), relativePath: document.uri.toString(),
                    snippet: 'hover: amount is a number',
                    lineRange: { startLine: 0, endLineExclusive: 1 }, score: 15, kind: 'facts',
                },
                {
                    uri: document.uri.toString(), relativePath: document.uri.toString(),
                    snippet: 'nearby source already present in the current-file window',
                    lineRange: { startLine: 1, endLineExclusive: 2 }, score: 13,
                },
                {
                    uri: document.uri.toString(), relativePath: document.uri.toString(),
                    snippet: lines[350],
                    lineRange: { startLine: 350, endLineExclusive: 351 }, score: 12,
                },
            ],
        );
        assert.ok(assembly.userPrompt.includes('hover: amount is a number'));
        assert.ok(assembly.userPrompt.includes('function deepBillingRule(amount: number)'));
        assert.ok(!assembly.userPrompt.includes('nearby source already present'));
    });

    test('places the most recently viewed file nearest the current file', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const target = newestHelper();',
        });
        const newer = 'export const newestHelper = () => 2;';
        const older = 'export const olderHelper = () => 1;';
        const recentHistory = [
            { path: 'newer.ts', content: newer },
            { path: 'older.ts', content: older },
        ].map(item => ({
            kind: 'visibleRanges' as const,
            docId: DocumentId.create(vscode.Uri.file(path.join(os.tmpdir(), item.path)).toString()),
            documentContent: new StringText(item.content),
            visibleRanges: [new OffsetRange(0, item.content.length)],
        }));
        const assembly = new PromptAssembler({} as never, new EditWindowResolver())
            .assemble(document, new vscode.Position(0, 26), false, recentHistory);
        const oldIndex = assembly.userPrompt.indexOf(older);
        const newIndex = assembly.userPrompt.indexOf(newer);
        const currentIndex = assembly.userPrompt.indexOf('current_file_path:');
        assert.ok(oldIndex >= 0 && oldIndex < newIndex && newIndex < currentIndex);
    });


    test('keeps distinct semantic definitions from one related file without repeating a slice', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript',
            content: 'const total = calculateTotal(order) + calculateTax(order);',
        });
        const relatedUri = vscode.Uri.file(path.join(os.tmpdir(), 'nes-semantic-related.ts')).toString();
        const assembly = new PromptAssembler({} as never, new EditWindowResolver()).assemble(
            document,
            new vscode.Position(0, 52),
            false,
            [],
            [
                {
                    uri: relatedUri, relativePath: 'nes-semantic-related.ts',
                    snippet: 'export function calculateTotal(order: Order) { return order.total; }',
                    lineRange: { startLine: 20, endLineExclusive: 21 }, score: 15,
                },
                {
                    uri: relatedUri, relativePath: 'nes-semantic-related.ts',
                    snippet: 'export function calculateTax(order: Order) { return order.tax; }',
                    lineRange: { startLine: 320, endLineExclusive: 321 }, score: 14,
                },
                {
                    uri: relatedUri, relativePath: 'nes-semantic-related.ts',
                    snippet: 'export function calculateTotal(order: Order) { return order.total; }',
                    lineRange: { startLine: 420, endLineExclusive: 421 }, score: 13,
                },
            ],
        );

        assert.ok(assembly.userPrompt.includes('export function calculateTotal(order: Order)'));
        assert.ok(assembly.userPrompt.includes('export function calculateTax(order: Order)'));
        assert.strictEqual(assembly.userPrompt.split('export function calculateTotal(order: Order)').length - 1, 1);
        assert.ok(assembly.userPrompt.indexOf('export function calculateTax(order: Order)')
            < assembly.userPrompt.indexOf('export function calculateTotal(order: Order)'));
    });

    test('keeps distinct semantic facts and source from the same line', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const result = calculateTotal(order);',
        });
        const uri = vscode.Uri.file(path.join(os.tmpdir(), 'nes-shared-line.ts')).toString();
        const assembly = new PromptAssembler({} as never, new EditWindowResolver()).assemble(
            document, new vscode.Position(0, 30), false, [], [
                {
                    uri, relativePath: 'nes-shared-line.ts',
                    snippet: 'calculateTotal(order: Order): number',
                    lineRange: { startLine: 8, endLineExclusive: 9 }, score: 15, kind: 'facts',
                },
                {
                    uri, relativePath: 'nes-shared-line.ts',
                    snippet: 'export function calculateTotal(order: Order) { return order.total; }',
                    lineRange: { startLine: 8, endLineExclusive: 9 }, score: 14,
                },
            ],
        );
        assert.ok(assembly.userPrompt.includes('calculateTotal(order: Order): number'));
        assert.ok(assembly.userPrompt.includes('export function calculateTotal(order: Order)'));
    });

    test('keeps a deep definition when the same file is already in recent history', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'typescript',
            content: 'const total = calculateDeepLedgerTotal(order);',
        });
        const relatedUri = vscode.Uri.file(path.join(os.tmpdir(), 'nes-deep-recent.ts')).toString();
        const relatedLines = Array.from({ length: 350 }, (_, index) => `const unrelated${index} = ${index};`);
        relatedLines[320] = 'export function calculateDeepLedgerTotal(order: Order) { return order.total; }';
        const assembly = new PromptAssembler({} as never, new EditWindowResolver()).assemble(
            document,
            new vscode.Position(0, 40),
            false,
            [{
                kind: 'visibleRanges',
                docId: DocumentId.create(relatedUri),
                documentContent: new StringText(relatedLines.join('\n')),
                visibleRanges: [new OffsetRange(0, 20)],
            }],
            [{
                uri: relatedUri, relativePath: 'nes-deep-recent.ts',
                snippet: relatedLines[320],
                lineRange: { startLine: 320, endLineExclusive: 321 }, score: 15,
            }],
        );

        assert.ok(assembly.userPrompt.includes('const unrelated0 = 0;'));
        assert.ok(assembly.userPrompt.includes(relatedLines[320]));
    });

    test('includes a related definition beyond the first 250 lines', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nes-neighbor-'));
        const relatedPath = path.join(tempDir, 'ledger.ts');
        const lines = Array.from({ length: 360 }, (_, index) => `const unrelated${index} = ${index};`);
        lines[321] = 'export function calculateInvoiceTaxFromInternalLedger(invoice: Invoice) {';
        lines[322] = '  return invoice.subtotal * invoice.taxRate;';
        lines[323] = '}';
        try {
            await fs.writeFile(relatedPath, lines.join('\n'));
            const related = await vscode.workspace.openTextDocument(vscode.Uri.file(relatedPath));
            const document = await vscode.workspace.openTextDocument({
                language: 'typescript',
                content: 'const amount = calculateInvoiceTaxFromInternalLedger(invoice);',
            });
            const assembly = new PromptAssembler({} as never, new EditWindowResolver())
                .assemble(document, new vscode.Position(0, 58), false);
            const selected = assembly.promptPieces.neighborSnippets?.find(item => item.uri === related.uri.toString());
            assert.ok(selected);
            assert.ok(selected.lineRange.startLine > 250);
            assert.ok(selected.snippet.includes('export function calculateInvoiceTaxFromInternalLedger'));
            assert.ok(assembly.userPrompt.includes('invoice.subtotal * invoice.taxRate'));
        } finally {
            await fs.unlink(relatedPath).catch(() => undefined);
            await fs.rmdir(tempDir);
        }
    });

    test('asks for a revised window without echoing the unchanged window as the answer', async () => {
        const source = 'const uniqueValue = calculate();\nconsole.log(uniqueValue);';
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: source });
        const assembly = new PromptAssembler({} as never, new EditWindowResolver())
            .assemble(document, new vscode.Position(0, 20), false, [], [], ['do not repeat this edit']);

        assert.ok(assembly.userPrompt.includes('uniqueValue'));
        assert.ok(assembly.userPrompt.includes('###remain edit start boundary line###'));
        assert.ok(assembly.userPrompt.includes('###remain edit end boundary line###'));
        assert.ok(!assembly.userPrompt.includes(`###remain edit start boundary line###\n${source}`));
        assert.ok(assembly.userPrompt.includes('do not repeat this edit\n\nFile language: typescript.'));
        assert.ok(assembly.systemPrompt.includes('preserving unchanged lines'));
        assert.ok(assembly.userPrompt.startsWith('```\n'));
        assert.ok(assembly.userPrompt.includes('\n```\n\nThe developer was working'));
    });
});
