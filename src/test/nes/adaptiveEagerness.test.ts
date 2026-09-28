import * as assert from 'assert';
import { AdaptiveEagerness } from '../../completions/nes/adaptiveEagerness';
import { AggressivenessLevel } from '../../completions/nes/stubs/types';
import { NextEditProvider } from '../../completions/nes/nextEditProvider';
import { NesCompletionInfo, NesCompletionItem } from '../../completions/nes/types';
import * as vscode from 'vscode';

suite('NES adaptive eagerness', () => {
    test('uses confidence before changing frequency and responds to recent outcomes', () => {
        const eagerness = new AdaptiveEagerness();
        assert.strictEqual(eagerness.level, AggressivenessLevel.Medium);
        for (let i = 0; i < 3; i++) eagerness.record(true);
        assert.strictEqual(eagerness.level, AggressivenessLevel.Medium);
        eagerness.record(true);
        assert.strictEqual(eagerness.level, AggressivenessLevel.High);

        for (let i = 0; i < 10; i++) eagerness.record(false);
        assert.strictEqual(eagerness.level, AggressivenessLevel.Low);
        for (let i = 0; i < 10; i++) eagerness.record(true);
        assert.strictEqual(eagerness.level, AggressivenessLevel.High);
    });

    test('recent actions outweigh older actions within the scoring window', () => {
        const eager = new AdaptiveEagerness();
        const cautious = new AdaptiveEagerness();
        for (let i = 0; i < 5; i++) eager.record(false);
        for (let i = 0; i < 5; i++) eager.record(true);
        for (let i = 0; i < 5; i++) cautious.record(true);
        for (let i = 0; i < 5; i++) cautious.record(false);
        assert.strictEqual(eager.level, AggressivenessLevel.High);
        assert.strictEqual(cautious.level, AggressivenessLevel.Low);
    });

    test('diagnostic edits and unseen candidates do not train model eagerness', () => {
        let level = AggressivenessLevel.Medium;
        const workflow = { setAggressiveness(value: AggressivenessLevel) { level = value; } };
        const provider = new NextEditProvider(
            { createInstance: () => workflow } as never,
            { eagernessSelection: 'auto' } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const item = (source: 'provider' | 'diagnostic', wasShown: boolean): NesCompletionItem => ({
            insertText: '',
            wasShown,
            info: new NesCompletionInfo({} as never, '', {} as never, 'id', source),
        });
        for (let i = 0; i < 4; i++) provider.handleEndOfLifetime(item('diagnostic', true), { kind: 0 });
        for (let i = 0; i < 4; i++) provider.handleEndOfLifetime(item('provider', false), { kind: 1 });
        assert.strictEqual(level, AggressivenessLevel.Medium);
        for (let i = 0; i < 4; i++) provider.handleEndOfLifetime(item('provider', true), { kind: 0 });
        assert.strictEqual(level, AggressivenessLevel.High);
    });

    test('a quick rejection remains eligible, while a reviewed rejection is remembered', () => {
        let recorded = 0;
        const workflow = {
            setAggressiveness() {},
            recordRejectedEdit() { recorded++; },
        };
        const provider = new NextEditProvider(
            { createInstance: () => workflow } as never,
            { eagernessSelection: 'auto' } as never,
            { info() {}, debug() {}, error() {} } as never,
        );
        const range = new vscode.Range(0, 0, 0, 3);
        const document = {
            uri: vscode.Uri.parse('untitled:reviewed-rejection'),
            version: 1,
            offsetAt: () => 0,
        } as never;
        const makeItem = (shownForMs: number) => {
            const cacheEntry = { edit: 'bar', rejected: false };
            const suggestion = {
                range,
                edit: 'bar',
                edits: [{ replaceRange: range, newText: 'bar' }],
                cacheEntry,
            } as never;
            const item: NesCompletionItem = {
                insertText: 'bar',
                wasShown: true,
                shownAt: Date.now() - shownForMs,
                info: new NesCompletionInfo(suggestion, 'untitled:reviewed-rejection', document, 'id'),
            };
            return { item, cacheEntry };
        };
        const quick = makeItem(200);
        provider.handleEndOfLifetime(quick.item, { kind: 1 });
        assert.strictEqual(quick.cacheEntry.rejected, false);
        assert.strictEqual(recorded, 0);

        const reviewed = makeItem(1_500);
        provider.handleEndOfLifetime(reviewed.item, { kind: 1 });
        assert.strictEqual(reviewed.cacheEntry.rejected, true);
        assert.strictEqual(recorded, 1);
    });
});
