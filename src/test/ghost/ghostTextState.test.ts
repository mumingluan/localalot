import * as assert from 'assert';
import * as vscode from 'vscode';
import { CurrentGhostText } from '../../completions/ghost/ghostTextState';
import { ResultType } from '../../completions/ghost/types';

suite('CurrentGhostText', () => {
    test('typing as suggested stays within the source scope', () => {
        const state = new CurrentGhostText();
        state.setGhostText('const value = ', '', [{
            completionIndex: 0, completionText: 'fromA', displayText: 'fromA',
            displayNeedsWsOffset: false, isMiddleOfTheLine: false,
        }], ResultType.Network, 'stop', undefined, 'file-a:model-a');
        assert.strictEqual(state.getCompletionsForUserTyping('const value = fr', '', 'file-b:model-a'), undefined);
        assert.strictEqual(state.hasAcceptedCurrentCompletion('const value = fromA', '', 'file-a:model-b'), false);
        assert.strictEqual(state.getCompletionsForUserTyping('const value = fr', '', 'file-a:model-a')?.[0].completionText, 'omA');
    });

    test('preserves middle-of-line range semantics after user typing', () => {
        const state = new CurrentGhostText();
        state.setGhostText('const value = ', ';', [{
            completionIndex: 0,
            completionText: 'compute()',
            displayText: 'compute()',
            displayNeedsWsOffset: true,
            isMiddleOfTheLine: true,
        }], ResultType.Network, 'stop');

        const remaining = state.getCompletionsForUserTyping('const value = comp', ';');
        assert.strictEqual(remaining?.length, 1);
        assert.strictEqual(remaining?.[0].completionText, 'ute()');
        assert.strictEqual(remaining?.[0].isMiddleOfTheLine, true);
        assert.strictEqual(remaining?.[0].displayNeedsWsOffset, true);
    });

    test('continues from the indentation actually inserted by VS Code', () => {
        const state = new CurrentGhostText();
        state.setGhostText('function run() {\n', '', [{
            completionIndex: 0, completionText: '\twork();\n\treturn;', displayText: '\twork();\n\treturn;',
            displayNeedsWsOffset: false, isMiddleOfTheLine: false, finishReason: 'stop',
        }], ResultType.Network);
        state.setRenderedCompletion('\twork();\n\treturn;', 'function run() {\n', '', '    work();\n    return;');

        assert.strictEqual(state.getCompletionsForUserTyping('function run() {\n    work();\n    re', '')?.[0].completionText, 'turn;');
        assert.strictEqual(state.hasAcceptedCurrentCompletion('function run() {\n    work();\n    return;', ''), true);
        assert.strictEqual(state.getCompletionsForUserTyping('function run() {\n\twork();', ''), undefined);
    });

    test('continues after an inline suggestion replaces existing line text', () => {
        const state = new CurrentGhostText();
        state.setGhostText('const value = old', ';\nnext();', [{
            completionIndex: 0, completionText: 'newValue', displayText: 'newValue',
            displayNeedsWsOffset: false, isMiddleOfTheLine: true, finishReason: 'stop',
        }], ResultType.Network);
        state.setRenderedCompletion('newValue', 'const value = ', '\nnext();', 'newValue;');

        assert.strictEqual(state.getCompletionsForUserTyping('const value = newV', '\nnext();')?.[0].completionText, 'alue;');
        assert.strictEqual(state.hasAcceptedCurrentCompletion('const value = newValue;', '\nnext();'), true);
    });

    test('keeps manual typing beside a covered same-line suffix after the ghost is shown', () => {
        const state = new CurrentGhostText();
        state.setGhostText('call(', ');\nnext();', [
            { completionIndex: 0, completionText: 'value);', displayText: 'value);',
                displayNeedsWsOffset: false, isMiddleOfTheLine: true, finishReason: 'stop' },
            { completionIndex: 1, completionText: 'variant);', displayText: 'variant);',
                displayNeedsWsOffset: false, isMiddleOfTheLine: true, finishReason: 'stop' },
        ], ResultType.Network);
        state.setRenderedCompletion('value);', '', '\nnext();', 'call(value);');

        assert.deepStrictEqual(
            state.getCompletionsForUserTyping('call(v', ');\nnext();')?.map(choice => choice.completionText),
            ['alue);', 'ariant);'],
        );
        assert.strictEqual(state.hasAcceptedCurrentCompletion('call(value);', '\nnext();'), true);
    });

    test('matches a rendered multiline completion in a CRLF document', () => {
        const state = new CurrentGhostText();
        // Prompt construction uses LF, while VS Code's rendered edit can use CRLF.
        state.setGhostText('header\n', '', [{
            completionIndex: 0, completionText: 'first\nsecond', displayText: 'first\nsecond',
            displayNeedsWsOffset: false, isMiddleOfTheLine: false, finishReason: 'stop',
        }], ResultType.Network);
        state.setRenderedCompletion('first\nsecond', 'header\r\n', '', 'first\nsecond');
        assert.strictEqual(state.getCompletionsForUserTyping('header\nfirst\nsec', '')?.[0].completionText, 'ond');
        assert.strictEqual(state.getCompletionsForUserTyping('header\r\nfirst\r\nsec', '')?.[0].completionText, 'ond');
        assert.strictEqual(state.hasAcceptedCurrentCompletion('header\nfirst\nsecond', ''), true);
    });

    test('does not switch to an unseen candidate while typing', () => {
        const state = new CurrentGhostText();
        state.setGhostText('const value = ', ';', [
            {
                completionIndex: 0,
                completionText: 'completeValue()',
                displayText: 'completeValue()',
                displayNeedsWsOffset: false,
                isMiddleOfTheLine: false,
            },
            {
                completionIndex: 1,
                completionText: 'computeValue()',
                displayText: 'computeValue()',
                displayNeedsWsOffset: false,
                isMiddleOfTheLine: false,
            },
        ], ResultType.Network, 'stop');

        assert.strictEqual(state.getCompletionsForUserTyping('const value = compute', ';'), undefined);
        state.setActiveCompletion('computeValue()');
        const remaining = state.getCompletionsForUserTyping('const value = compute', ';');
        assert.strictEqual(remaining?.length, 1);
        assert.strictEqual(remaining?.[0].completionText, 'Value()');
    });

    test('keeps the selected candidate first when alternatives share its typed prefix', () => {
        const state = new CurrentGhostText();
        state.setGhostText('prefix', '', [
            { completionIndex: 0, completionText: 'calculateTax()', displayText: 'calculateTax()', displayNeedsWsOffset: false, isMiddleOfTheLine: false },
            { completionIndex: 1, completionText: 'calculateTotal()', displayText: 'calculateTotal()', displayNeedsWsOffset: false, isMiddleOfTheLine: false },
        ], ResultType.Cycling);
        state.setActiveCompletion('calculateTotal()');
        const remaining = state.getCompletionsForUserTyping('prefixcalculateT', '');
        assert.deepStrictEqual(remaining?.map(choice => choice.completionText), ['otal()', 'ax()']);
    });

    test('keeps matching alternatives after VS Code renders the whole line', () => {
        const state = new CurrentGhostText();
        state.setGhostText('const value = ', '', [
            { completionIndex: 0, completionText: 'calculate()', displayText: 'calculate()',
                displayNeedsWsOffset: false, isMiddleOfTheLine: false, suffixCoverage: 0 },
            { completionIndex: 1, completionText: 'calendar()', displayText: 'calendar()',
                displayNeedsWsOffset: false, isMiddleOfTheLine: false, suffixCoverage: 0 },
        ], ResultType.Cycling);
        state.setRenderedCompletion('calculate()', '', '', 'const value = calculate();');

        assert.deepStrictEqual(
            state.getCompletionsForUserTyping('const value = cal', '')?.map(choice => choice.completionText),
            ['culate();', 'endar();'],
        );
    });

    test('follows a cached alternative selected after partial typing', () => {
        const state = new CurrentGhostText();
        state.setGhostText('const value = ', '', [
            { completionIndex: 0, completionText: 'calculate()', displayText: 'calculate()',
                displayNeedsWsOffset: false, isMiddleOfTheLine: false, finishReason: 'stop' },
        ], ResultType.Network);
        state.setRenderedCompletion('lendar()', '', '', 'const value = calendar()', {
            completionIndex: 1, completionText: 'lendar()', displayText: 'lendar()',
            displayNeedsWsOffset: false, isMiddleOfTheLine: false, finishReason: 'stop',
        });

        assert.strictEqual(state.getCompletionsForUserTyping('const value = cal', '')?.[0].completionText, 'endar()');
        state.setRenderedCompletion('endar()', '', '', 'const value = calendar()', {
            completionIndex: 0, completionText: 'endar()', displayText: 'endar()',
            displayNeedsWsOffset: false, isMiddleOfTheLine: false, finishReason: 'stop',
        });
        assert.strictEqual(state.getCompletionsForUserTyping('const value = cale', '')?.[0].completionText, 'ndar()');
        assert.strictEqual(state.hasAcceptedCurrentCompletion('const value = calendar()', ''), true);
    });

    test('acceptance follows the candidate selected while cycling', () => {
        const state = new CurrentGhostText();
        state.setGhostText('prefix', '', [
            { completionIndex: 0, completionText: 'first', displayText: 'first', displayNeedsWsOffset: false, isMiddleOfTheLine: false, finishReason: 'length' },
            { completionIndex: 1, completionText: 'second', displayText: 'second', displayNeedsWsOffset: false, isMiddleOfTheLine: false, finishReason: 'stop' },
        ], ResultType.Cycling);
        state.setActiveCompletion('second');
        assert.strictEqual(state.hasAcceptedCurrentCompletion('prefixsecond', ''), true);
    });

    test('an explicit accept marker does not make unrelated cursor positions follow-ups', () => {
        const state = new CurrentGhostText();
        state.setGhostText('prefix', '\nnext', [{
            completionIndex: 0,
            completionText: 'choice',
            displayText: 'choice',
            displayNeedsWsOffset: false,
            isMiddleOfTheLine: false,
            finishReason: 'stop',
        }], ResultType.Network);
        state.markExplicitlyAccepted();
        assert.strictEqual(state.hasAcceptedCurrentCompletion('prefixchoice', '\nnext'), true);
        assert.strictEqual(state.hasAcceptedCurrentCompletion('other position', '\nnext'), false);
        assert.strictEqual(state.hasAcceptedCurrentCompletion('prefixchoice', '\nchanged'), false);
    });

    test('clearing a rejected completion resets the accepted follow-up state', () => {
        const state = new CurrentGhostText();
        state.markExplicitlyAccepted();
        assert.strictEqual(state.hasAcceptedCurrentCompletion_original(), true);
        state.clear();
        assert.strictEqual(state.hasAcceptedCurrentCompletion_original(), false);
    });

    test('rejecting an old shown choice keeps the newer in-flight request valid', () => {
        const state = new CurrentGhostText();
        const choice = (completionText: string) => ({
            completionIndex: 0, completionText, displayText: completionText,
            displayNeedsWsOffset: false, isMiddleOfTheLine: false, finishReason: 'stop',
        });
        state.setGhostText('const value = ', '', [choice('old')], ResultType.Network);
        const nextRequestId = state.beginRequest();
        state.rejectShownCompletion('old');
        assert.strictEqual(state.getCompletionsForUserTyping('const value = o', ''), undefined);
        state.setGhostText('const value = ', '', [choice('fresh')], ResultType.Network,
            undefined, nextRequestId);
        assert.strictEqual(state.getCompletionsForUserTyping('const value = fr', '')?.[0].completionText, 'esh');

        state.rejectShownCompletion('old');
        assert.strictEqual(state.getCompletionsForUserTyping('const value = fr', '')?.[0].completionText, 'esh');
    });

    test('ignores an older request after a newer request starts', () => {
        const state = new CurrentGhostText();
        const first = state.beginRequest();
        const second = state.beginRequest();
        state.setGhostText('prefix', '', [{
            completionIndex: 0,
            completionText: 'stale',
            displayText: 'stale',
            displayNeedsWsOffset: false,
            isMiddleOfTheLine: false,
        }], ResultType.Network, 'stop', first);
        assert.strictEqual(state.getCompletionsForUserTyping('prefixstale', ''), undefined);
        state.setGhostText('prefix', '', [{
            completionIndex: 0,
            completionText: 'fresh',
            displayText: 'fresh',
            displayNeedsWsOffset: false,
            isMiddleOfTheLine: false,
        }], ResultType.Network, 'stop', second);
        assert.strictEqual(state.getCompletionsForUserTyping('prefixfr', '')?.[0].completionText, 'esh');
    });
});
