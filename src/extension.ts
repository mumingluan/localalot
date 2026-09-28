import * as vscode from 'vscode';
import * as path from 'path';
import { InstantiationServiceBuilder, SyncDescriptor } from './di/services';

// Config
import { IGhostConfigProvider, VSCodeGhostConfigProvider } from './config/ghostConfig';
import { INesConfigProvider, VSCodeNesConfigProvider } from './config/nesConfig';
import { WordPatternManager } from './config/wordPatternManager';

// Shared
import { ILogService, LogService } from './completions/shared/log/logService';
// UI
import { IStatusBarPanel, StatusBarPanel, type LocalRequestStatus } from './ui/statusBarPanel';
import { NativeGhostRuntime } from './native/ghostRuntime';
import { NativeNesRuntime } from './native/nesRuntime';
import { registerIgnoreContextInvalidation } from './native/ignoreContextInvalidation';
import { registerNextEditAcceptanceCommand } from './completions/shared/inlineRegistration';

declare const __non_webpack_require__: NodeRequire;

export function activate(context: vscode.ExtensionContext) {
    const logService = new LogService();
    logService.info('Localalot activating...');

    // Build DI container
    const builder = new InstantiationServiceBuilder();

    // === Config (direct instances, with context for workspaceState) ===
    const ghostConfig = new VSCodeGhostConfigProvider(context);
    const nesConfig = new VSCodeNesConfigProvider(context);

    // === WordPattern (global, independent of ghost/nes enabled state) ===
    const wordPatternManager = new WordPatternManager(logService);
    context.subscriptions.push(wordPatternManager.register());

    builder.define(IGhostConfigProvider, ghostConfig);
    builder.define(INesConfigProvider, nesConfig);

    // === Shared ===
    builder.define(ILogService, logService);

    // === UI ===
    builder.define(IStatusBarPanel, new SyncDescriptor(StatusBarPanel));

    // Seal
    const instantiationService = builder.seal();
    context.subscriptions.push(instantiationService);
    // Activate providers
    let ghostRegistration: vscode.Disposable;
    let invalidateGhost: () => void;
    let ghostCore: 'native' | 'unavailable';
    const startupIssues: LocalRequestStatus[] = [];
    let nativeGhostRuntime: NativeGhostRuntime | undefined;
    let nativeNesRuntime: NativeNesRuntime | undefined;
    try {
        nativeGhostRuntime = new NativeGhostRuntime(context, ghostConfig, logService,
            () => nativeNesRuntime?.handlesCompletions ?? false);
        ghostRegistration = nativeGhostRuntime.register();
        invalidateGhost = () => nativeGhostRuntime?.invalidateCachedCompletions();
        ghostCore = 'native';
    } catch (error) {
        nativeGhostRuntime = undefined;
        logService.error(`Original Ghost provider failed to start: ${String(error)}`);
        startupIssues.push({ component: 'ghost', message: `Original provider could not start: ${String(error)}` });
        ghostRegistration = new vscode.Disposable(() => undefined);
        invalidateGhost = () => undefined;
        ghostCore = 'unavailable';
    }
    let nesRegistration: vscode.Disposable;
    let invalidateNes: () => void;
    let nesCore: 'native' | 'unavailable';
    try {
        nativeNesRuntime = new NativeNesRuntime(context, nesConfig, logService);
        nesRegistration = nativeNesRuntime.register();
        invalidateNes = () => nativeNesRuntime?.invalidateCachedEdits();
        nesCore = 'native';
    } catch (error) {
        nativeNesRuntime = undefined;
        logService.error(`Original NES provider failed to start: ${String(error)}`);
        startupIssues.push({ component: 'nes', message: `Original provider could not start: ${String(error)}` });
        nesRegistration = new vscode.Disposable(() => undefined);
        invalidateNes = () => undefined;
        nesCore = 'unavailable';
    }
    // The editor's inline rename processor calls these original command IDs.
    // This contribution owns its own lifetime so model changes cannot remove them.
    if (!vscode.extensions.getExtension('GitHub.copilot-chat')) {
        try {
            const native = __non_webpack_require__(path.join(context.extensionPath, 'dist', 'native-core.js')) as {
                createLocalNesRenameContribution(context: vscode.ExtensionContext): vscode.Disposable;
            };
            context.subscriptions.push(native.createLocalNesRenameContribution(context));
        } catch (error) {
            logService.error(`Original NES rename commands failed to start: ${String(error)}`);
        }
    }
    if (nativeNesRuntime?.handlesCompletions) invalidateGhost();
    let nesEnabled = nesConfig.enabled;
    const statusBar = instantiationService.createInstance(StatusBarPanel);
    statusBar.setCacheInvalidators(
        invalidateGhost,
        invalidateNes,
    );
    statusBar.setUnifiedCompletionsProvider(() => nativeNesRuntime?.handlesCompletions ?? false);
    const currentStartupIssues = (): LocalRequestStatus[] => [
        ...startupIssues,
        ...(nativeGhostRuntime?.startupError
            ? [{ component: 'ghost' as const, message: `Original provider could not start: ${nativeGhostRuntime.startupError}` }] : []),
        ...(nativeNesRuntime?.startupError
            ? [{ component: 'nes' as const, message: `Original provider could not start: ${nativeNesRuntime.startupError}` }] : []),
    ];
    statusBar.setRequestStatusProvider(currentStartupIssues);
    try {
        const nativeStatus = __non_webpack_require__(path.join(context.extensionPath, 'dist', 'native-core.js')) as {
            onDidChangeLocalRequestStatus: vscode.Event<void>;
            getLocalRequestStatuses(): Array<{ component: 'ghost' | 'nes'; message: string }>;
        };
        statusBar.setRequestStatusProvider(() => [...currentStartupIssues(), ...nativeStatus.getLocalRequestStatuses()]);
        context.subscriptions.push(nativeStatus.onDidChangeLocalRequestStatus(() => statusBar.refresh()));
    } catch (error) {
        logService.error(`Could not connect local request status: ${String(error)}`);
    }

    context.subscriptions.push(
        ghostRegistration,
        nesRegistration,
        ...(nativeGhostRuntime ? [nativeGhostRuntime.onDidChangeAvailability(() => statusBar.refresh())] : []),
        ...(nativeNesRuntime ? [nativeNesRuntime.onDidChangeAvailability(() => statusBar.refresh())] : []),
        nesConfig.onDidChangeEnabled(() => {
            const current = nesConfig.enabled;
            if (current !== nesEnabled) {
                nesEnabled = current;
                invalidateGhost();
            }
        }),
        registerNextEditAcceptanceCommand(),
        registerIgnoreContextInvalidation(() => {
            invalidateGhost();
            invalidateNes();
        }),
        statusBar.register(),
    );

    logService.info('Localalot activated');
    return { ghostCore, nesCore };
}

export function deactivate() {}
