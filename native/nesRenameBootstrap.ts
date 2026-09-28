import type { ExtensionContext } from 'vscode';
import { ITelemetryService } from '../vendor/copilot/src/platform/telemetry/common/telemetry';
import { NullTelemetryService } from '../vendor/copilot/src/platform/telemetry/common/nullTelemetryService';
import { registerServices as registerCommonServices } from '../vendor/copilot/src/extension/extension/vscode/services';
import { NesRenameContribution } from '../vendor/copilot/src/extension/typescriptContext/vscode-node/nesRenameService';
import { InstantiationServiceBuilder } from '../vendor/copilot/src/util/common/services';

/** Keep VS Code's original NES rename commands alive across model/config resets. */
export function createLocalNesRenameContribution(context: ExtensionContext): { dispose(): void } {
    const builder = new InstantiationServiceBuilder();
    registerCommonServices(builder, context);
    builder.define(ITelemetryService, new NullTelemetryService());
    const root = builder.seal();
    try {
        const contribution = root.createInstance(NesRenameContribution);
        return { dispose: () => { contribution.dispose(); root.dispose(); } };
    } catch (error) {
        root.dispose();
        throw error;
    }
}
