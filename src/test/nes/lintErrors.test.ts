import * as assert from 'assert';
import * as vscode from 'vscode';
import { LintErrors } from '../../completions/nes/lintErrors';
import { StringText } from '../../completions/nes/stubs/abstractText';
import { OffsetRange } from '../../completions/nes/stubs/offsetRange';
import { Position } from '../../completions/nes/stubs/position';
import { DocumentId, LintOptionShowCode, LintOptionWarning, LintOptions } from '../../completions/nes/stubs/types';
import { CurrentDocument } from '../../completions/nes/xtabCurrentDocument';

suite('NES lint context', () => {
    const options: LintOptions = {
        enable: true, tagName: 'diagnostics', warnings: LintOptionWarning.YES_IF_NO_ERRORS,
        showCode: LintOptionShowCode.YES_WITH_SURROUNDING,
        maxLints: 5, maxLineDistance: 1000, nRecentFiles: 0,
    };

    test('cursor prediction prefers errors and uses warnings when there are no errors', async () => {
        const source = 'const first = 1;\nconst second = 2;';
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: source });
        const collection = vscode.languages.createDiagnosticCollection('nes-lint-priority');
        try {
            const warning = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 5), 'warning context', vscode.DiagnosticSeverity.Warning);
            const error = new vscode.Diagnostic(new vscode.Range(1, 6, 1, 12), 'error context', vscode.DiagnosticSeverity.Error);
            collection.set(document.uri, [warning, error]);
            const lint = new LintErrors(document.uri, new CurrentDocument(new StringText(source), new Position(2, 7)));
            const withError = lint.getFormattedLintErrors(options);
            assert.ok(withError.startsWith('<|diagnostics|>\n'));
            assert.ok(withError.includes('error context'));
            assert.ok(!withError.includes('warning context'));

            const distantError = new vscode.Diagnostic(
                new vscode.Range(1, 0, 1, 5), 'distant same-line error', vscode.DiagnosticSeverity.Error,
            );
            collection.set(document.uri, [distantError, error]);
            const nearest = lint.getFormattedLintErrors({ ...options, maxLints: 1 });
            assert.ok(nearest.includes('error context'));
            assert.ok(!nearest.includes('distant same-line error'));

            collection.set(document.uri, [warning]);
            const withoutError = lint.getFormattedLintErrors(options);
            assert.ok(withoutError.includes('warning context'));

            collection.set(document.uri, [new vscode.Diagnostic(
                new vscode.Range(1, 6, 1, 12), "Cannot find module './missing'", vscode.DiagnosticSeverity.Error,
            )]);
            assert.ok(lint.getFormattedLintErrors(options).includes("Cannot find module './missing'"));

            const linked = new vscode.Diagnostic(
                new vscode.Range(1, 6, 1, 12), 'linked diagnostic', vscode.DiagnosticSeverity.Information,
            );
            linked.code = { value: 'TS2307', target: vscode.Uri.parse('https://example.test/diagnostic') };
            collection.set(document.uri, [linked]);
            assert.ok(lint.getFormattedLintErrors(options).includes('warning TS2307: linked diagnostic'));
        } finally {
            collection.dispose();
        }
    });

    test('includes a recent file diagnostic without showing unrelated current-file code', async () => {
        const source = 'const active = 1;';
        const recentSource = 'const recent = 2;';
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: source });
        const recent = await vscode.workspace.openTextDocument({ language: 'typescript', content: recentSource });
        const collection = vscode.languages.createDiagnosticCollection('nes-lint-recent');
        try {
            collection.set(recent.uri, [new vscode.Diagnostic(
                new vscode.Range(0, 6, 0, 12), 'recent file error', vscode.DiagnosticSeverity.Error,
            )]);
            const history = [{
                kind: 'visibleRanges' as const,
                docId: DocumentId.create(recent.uri.toString()),
                documentContent: new StringText(recentSource),
                visibleRanges: [new OffsetRange(0, 1)],
            }];
            const lint = new LintErrors(
                document.uri, new CurrentDocument(new StringText(source), new Position(1, 1)), history,
            );
            const formatted = lint.getFormattedLintErrors({ ...options, nRecentFiles: 1 });
            assert.ok(formatted.includes('recent file error'));
            assert.ok(!formatted.includes('0|const active = 1;'));
            assert.strictEqual(lint.getFormattedLintErrors(options), '<|diagnostics|>\n\n<|/diagnostics|>');
        } finally {
            collection.dispose();
        }
    });
});
