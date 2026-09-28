import { DetectionResult, IMultilineDetector, MultilineContext } from './types';
import { nativeBlockMode } from './nativeBlockMode';

/** The native server block mode requests multiline for every valid cursor position. */
export class ServerModeDetector implements IMultilineDetector {
    get name(): string { return 'ServerMode'; }

    async detect(ctx: MultilineContext): Promise<DetectionResult> {
        return nativeBlockMode(ctx.languageId) === 'server'
            ? { decision: 'multiline' }
            : { decision: 'defer' };
    }
}
