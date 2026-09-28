import { IMultilineStrategy, MultilineContext, IMultilineDetector } from './types';
import { DetectorChain } from './DetectorChain';
import { FileSizeGuardDetector } from './FileSizeGuardDetector';
import { NewLineDetector } from './NewLineDetector';
import { EmptyBlockDetector } from './EmptyBlockDetector';
import { MLModelDetector } from './MLModelDetector';
import { ServerModeDetector } from './ServerModeDetector';
import { nativeBlockMode } from './nativeBlockMode';

export class DefaultMultilineStrategy implements IMultilineStrategy {
    readonly _serviceBrand: undefined;
    private readonly chain: DetectorChain;

    constructor(
        fileSizeGuard: IMultilineDetector = new FileSizeGuardDetector(),
        newLineDetector: IMultilineDetector = new NewLineDetector(),
        emptyBlock: IMultilineDetector = new EmptyBlockDetector(),
        serverMode: IMultilineDetector = new ServerModeDetector(),
        mlModel: IMultilineDetector = new MLModelDetector(),
    ) {
        this.chain = new DetectorChain([
            serverMode,
            fileSizeGuard,
            newLineDetector,
            emptyBlock,
            mlModel,
        ]);
    }

    async determineMultiline(ctx: MultilineContext): Promise<boolean> {
        if (ctx.afterAccept) {
            return true;
        }
        // Native MoreMultiline starts JS/TS/Go with a single-line request and
        // reveals the larger block only after the user accepts a suggestion.
        if (nativeBlockMode(ctx.languageId) === 'client') {
            return false;
        }
        const result = await this.chain.detect(ctx);
        return result.decision === 'multiline';
    }
}
