import * as vscode from 'vscode';
import { IInstantiationService } from '../../di/instantiation';
import { ICurrentGhostText, ILastGhostText } from '../../di/services';
import { GhostTextComputer, GhostTextResult } from './ghostTextComputer';
import { CurrentGhostText, LastGhostText } from './ghostTextState';

export interface GhostVirtualCompletion {
    text: string;
    range: vscode.Range;
}

export class GhostText {
    private readonly _currentGhostText: CurrentGhostText;
    private readonly _lastGhostText: LastGhostText;

    constructor(
        @IInstantiationService private readonly _instantiationService: IInstantiationService,
    ) {
        this._currentGhostText = this._instantiationService.invokeFunction(
            (accessor) => accessor.get(ICurrentGhostText)
        );
        this._lastGhostText = this._instantiationService.invokeFunction(
            (accessor) => accessor.get(ILastGhostText)
        );
    }

    async getInlineCompletions(
        document: vscode.TextDocument,
        position: vscode.Position,
        token?: vscode.CancellationToken,
        isSpeculative: boolean = false,
        isCycling: boolean = false,
        selectedCompletionInfo?: vscode.SelectedCompletionInfo,
        virtualCompletion?: GhostVirtualCompletion,
    ): Promise<GhostTextResult | undefined> {
        const computer = this._instantiationService.createInstance(GhostTextComputer, this._currentGhostText, this._lastGhostText);
        return computer.getGhostText(document, position, token, isSpeculative, isCycling, selectedCompletionInfo, virtualCompletion);
    }
}
