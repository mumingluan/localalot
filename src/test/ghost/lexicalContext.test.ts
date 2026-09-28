import * as assert from 'assert';
import * as vscode from 'vscode';
import { cachedLexicalLines, lexicalFocus, selectLexicalWindow } from '../../completions/ghost/lexicalContext';
import { registerNeighborFileAccessTracking, selectNeighborDocuments, sortNeighborFilesByAccess } from '../../completions/ghost/neighborFileAccess';
import { GhostTextComputer } from '../../completions/ghost/ghostTextComputer';

suite('Ghost lexical related-file context', () => {
    test('counts matching neighbors after language filtering', () => {
        const active = { uri: vscode.Uri.file('/workspace/active.ts'), languageId: 'typescript' };
        const unrelated = Array.from({ length: 22 }, (_, index) => ({
            uri: vscode.Uri.file(`/workspace/irrelevant-${index}.yaml`), languageId: 'yaml', getText: () => 'key: value',
        }));
        const relevant = {
            uri: vscode.Uri.file('/workspace/relevant.ts'), languageId: 'typescript', getText: () => 'export const value = 1;',
        };
        assert.deepStrictEqual(selectNeighborDocuments(active, [...unrelated, relevant]), [relevant]);
        assert.deepStrictEqual(selectNeighborDocuments(active, [...unrelated, relevant], 0), []);
    });

    test('selects a relevant definition well below the file header', () => {
        const lines = Array.from({ length: 100 }, (_, index) => `const unrelated${index} = ${index};`);
        lines[73] = 'export function calculateInvoiceTax(invoice: Invoice): number {';
        lines[74] = '  return invoice.subtotal * invoice.taxRate;';
        lines[75] = '}';
        const focus = lexicalFocus('const amount = calculateInvoiceTax(currentInvoice);');
        assert.strictEqual(focus[1], 'calculateinvoicetax');
        const selected = selectLexicalWindow(lines, focus, 500);
        assert.strictEqual(selected?.anchorLine, 73);
        assert.ok(selected?.snippet.includes('export function calculateInvoiceTax'));
        assert.ok(selected?.snippet.includes('invoice.taxRate'));
        assert.ok(!selected?.snippet.includes('unrelated0'));
        assert.ok(selected!.snippet.length <= 500);
    });

    test('ignores language keywords without a matching identifier', () => {
        const focus = lexicalFocus('const value = function return');
        assert.deepStrictEqual(focus, ['value']);
        assert.strictEqual(selectLexicalWindow(['const other = 1;', 'return other;'], focus), undefined);
    });

    test('can match a Unicode identifier in another file', () => {
        const focus = lexicalFocus('const result = 计算税额(invoice);');
        const selected = selectLexicalWindow([
            'const unrelated = 1;',
            'export function 计算税额(invoice: Invoice) {',
            '  return invoice.amount * invoice.rate;',
        ], focus);
        assert.strictEqual(selected?.anchorLine, 1);
    });

    test('prefers a related block whose identifiers are spread across lines', () => {
        const lines = Array.from({ length: 100 }, (_, index) => `const unrelated${index} = ${index};`);
        lines[5] = 'const region = feature.region;';
        lines[73] = 'function calculateTotal(input) {';
        lines[74] = '  const invoice = input.invoice;';
        lines[75] = '  const taxRate = input.taxRate;';
        lines[76] = '  return invoice.amount * taxRate;';
        lines[77] = '}';
        const selected = selectLexicalWindow(lines, ['region', 'taxrate', 'invoice', 'calculatetotal'], 700);
        assert.ok(selected?.snippet.includes('function calculateTotal'));
        assert.ok(selected?.snippet.includes('const taxRate'));
        assert.ok(!selected?.snippet.includes('const region'));
    });

    test('refreshes a related document snapshot after an edit', () => {
        let content = 'function oldHelper() {}';
        const document = { version: 1, getText: () => content };
        assert.ok(selectLexicalWindow(cachedLexicalLines(document), ['oldhelper']));
        content = 'function newHelper() {}';
        document.version++;
        assert.strictEqual(selectLexicalWindow(cachedLexicalLines(document), ['oldhelper']), undefined);
        assert.ok(selectLexicalWindow(cachedLexicalLines(document), ['newhelper']));
    });

    test('uses short YAML keys to find the relevant neighboring service', () => {
        const focus = lexicalFocus('services:\n  db:\n    id:');
        assert.deepStrictEqual(focus.slice(0, 3), ['id', 'db', 'services']);
        const lines = [
            'services:',
            '  web:',
            '    image: nginx',
            '  db:',
            '    id: postgres-main',
            '    image: postgres',
        ];
        const selected = selectLexicalWindow(lines, focus, 300);
        assert.ok(selected?.snippet.includes('id: postgres-main'));
        assert.strictEqual(selected?.anchorLine, 4);
    });

    test('uses numeric YAML values to distinguish neighboring services', () => {
        const focus = lexicalFocus('services:\n  db:\n    port: 5432\n    image:');
        assert.ok(focus.includes('5432'));
        const selected = selectLexicalWindow([
            'services:',
            '  web:',
            '    port: 8080',
            '    image: nginx',
            '  db:',
            '    port: 5432',
            '    image: postgres',
        ], focus, 300);
        assert.strictEqual(selected?.anchorLine, 5);
    });

    test('finds a symbol after a long neighboring source line', () => {
        const selected = selectLexicalWindow([
            `const targetServiceExtra = '${'x'.repeat(2200)}'; targetService();`,
            'const unrelated = 1;',
        ], ['targetservice'], 400);
        assert.strictEqual(selected?.anchorLine, 0);
        assert.ok(selected?.snippet.includes('targetService();'));
        assert.ok(!selected?.snippet.includes('targetServiceExtra'));
        assert.ok(selected!.snippet.length <= 400);
    });

    test('keeps YAML parent keys across long lines within the recent 60-line context', () => {
        const prefix = ['services:', ...Array.from({ length: 15 }, () => `  # ${'x'.repeat(180)}`), '  web:'].join('\n');
        assert.ok(lexicalFocus(prefix).includes('services'));
        assert.ok(!lexicalFocus(['oldKey:', ...Array.from({ length: 60 }, () => '  # filler')].join('\n')).includes('oldkey'));
    });

    test('keeps an earlier key when recent lines contain many distinct identifiers', () => {
        const prefix = ['deployment:', ...Array.from({ length: 50 }, (_, index) =>
            `  service${index}: image${index}`)].join('\n');
        assert.ok(lexicalFocus(prefix).includes('deployment'));
    });

    test('matches a related definition across the native-sized 60-line window', () => {
        const lines = Array.from({ length: 90 }, (_, index) => `const unrelated${index} = ${index};`);
        lines[25] = 'export function invoiceTotal(invoice: Invoice) {';
        lines[55] = '  return invoice.taxRate * invoice.subtotal;';
        const selected = selectLexicalWindow(lines, ['invoice', 'invoicetotal', 'taxrate'], 800);
        assert.ok(selected?.snippet.includes('invoiceTotal'));
        assert.strictEqual(selected?.anchorLine, 25);
        assert.ok(selected!.snippet.length <= 800);
    });

    test('ranks a concise relevant window above a noisy window with more hits', () => {
        const lines = Array.from({ length: 130 }, () => '');
        for (let index = 0; index < 60; index++) {
            lines[index] = `const unrelated${index} = ${index};`;
        }
        lines[5] = 'const target = alpha;';
        lines[120] = 'const beta = 1;';
        const selected = selectLexicalWindow(lines, ['target', 'alpha', 'beta']);
        assert.strictEqual(selected?.anchorLine, 120);
        assert.ok(selected?.snippet.includes('const beta = 1;'));
        assert.ok(!selected?.snippet.includes('const target = alpha;'));
    });

    test('prioritizes the recently focused neighbor tab', async () => {
        const first = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'first: true' });
        const second = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'second: true' });
        const tracking = registerNeighborFileAccessTracking();
        try {
            await vscode.window.showTextDocument(first);
            await vscode.window.showTextDocument(second);
            assert.deepStrictEqual(sortNeighborFilesByAccess([first, second]), [second, first]);
        } finally {
            tracking.dispose();
        }
    });

    test('uses a relevant definition from an open source file larger than 10 KB', async () => {
        const lines = Array.from({ length: 520 }, (_, index) => `export const unrelatedValue${index} = ${index};`);
        lines[405] = 'export function uniqueInvoiceTaxHelper(invoice: Invoice) { return invoice.taxRate * invoice.subtotal; }';
        const neighbor = await vscode.workspace.openTextDocument({ language: 'typescript', content: lines.join('\n') });
        const source = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const tax = uniqueInvoiceTaxHelper(invoice);' });
        assert.ok(neighbor.getText().length > 10_000);
        const tracking = registerNeighborFileAccessTracking();
        try {
            await vscode.window.showTextDocument(neighbor);
            await vscode.window.showTextDocument(source);
            const computer = Object.create(GhostTextComputer.prototype) as GhostTextComputer;
            const related = (computer as unknown as {
                _collectRelatedFiles(document: vscode.TextDocument, prefix: string): Array<{ uri: string; snippet: string }>;
            })._collectRelatedFiles(source, source.getText());
            assert.ok(related.some(file => file.uri === neighbor.uri.toString()
                && file.snippet.includes('uniqueInvoiceTaxHelper')));
        } finally {
            tracking.dispose();
        }
    });

    test('uses a TSX definition for a TypeScript ghost prompt', async () => {
        const neighbor = await vscode.workspace.openTextDocument({
            language: 'typescriptreact',
            content: 'export function uniqueTsxInvoiceHelper(invoice: Invoice) { return invoice.total; }',
        });
        const source = await vscode.workspace.openTextDocument({
            language: 'typescript', content: 'const value = uniqueTsxInvoiceHelper(invoice);',
        });
        const tracking = registerNeighborFileAccessTracking();
        try {
            await vscode.window.showTextDocument(neighbor);
            await vscode.window.showTextDocument(source);
            const computer = Object.create(GhostTextComputer.prototype) as GhostTextComputer;
            const related = (computer as unknown as {
                _collectRelatedFiles(document: vscode.TextDocument, prefix: string): Array<{ uri: string; snippet: string }>;
            })._collectRelatedFiles(source, source.getText());
            assert.ok(related.some(file => file.uri === neighbor.uri.toString()
                && file.snippet.includes('uniqueTsxInvoiceHelper')));
        } finally {
            tracking.dispose();
        }
    });
});
