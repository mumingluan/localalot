import * as path from 'path';
import * as vscode from 'vscode';
import { getLocalConfiguration } from '../config/compatConfiguration';
import { IGhostConfigProvider } from '../config/ghostConfig';
import { isEligibleForInlineCompletion } from '../completions/shared/documentEligibility';
import { ILogService } from '../completions/shared/log/logService';
import { registerOriginalInlineCompletionProvider } from '../completions/shared/inlineRegistration';
import { waitForIgnoreRules } from './ignoreReadiness';
import { withNativeInlineContext } from './inlineContext';

declare const __non_webpack_require__: NodeRequire;

interface NativeGhostInstance extends vscode.Disposable {
    provider: vscode.InlineCompletionItemProvider;
    ready: Promise<void>;
    whenReady(): Promise<void>;
}

interface NativeGhostModule {
    createLocalGhostProvider(context: vscode.ExtensionContext): NativeGhostInstance;
}

/** Registers the original Ghost provider with Localalot's enablement and endpoint settings. */
export class NativeGhostRuntime implements vscode.Disposable {
    private _native: NativeGhostInstance | undefined;
    private _registration: vscode.Disposable | undefined;
    private _listeners: vscode.Disposable[] = [];
    private _disposed = false;
    private _startupError: string | undefined;
    private readonly _onDidChangeAvailability = new vscode.EventEmitter<void>();

    readonly onDidChangeAvailability = this._onDidChangeAvailability.event;
    get startupError(): string | undefined { return this._startupError; }

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _config: IGhostConfigProvider,
        private readonly _log: ILogService,
        private readonly _nesHandlesCompletions: () => boolean = () => false,
    ) { }

    register(): vscode.Disposable {
        try { this._start(); }
        catch (error) { this.dispose(); throw error; }
        this._listeners.push(this._config.onDidChangeEnabled(() => this.invalidateCachedCompletions()));
        this._listeners.push(vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('localalot.ghost')
                || event.affectsConfiguration('cc-completion.ghost')
                || event.affectsConfiguration('localalot.advanced')
                || event.affectsConfiguration('cc-completion.advanced')
                || event.affectsConfiguration('localalot.nes.promptingStrategy')
                || event.affectsConfiguration('localalot.nes.baseUrl')
                || event.affectsConfiguration('localalot.nes.endpoint')
                || event.affectsConfiguration('localalot.enable')
                || event.affectsConfiguration('cc-completion.enable')
                || event.affectsConfiguration('localalot.exclude')
                || event.affectsConfiguration('cc-completion.exclude')
                || event.affectsConfiguration('localalot.ignoreWhenSuggestVisible')
                || event.affectsConfiguration('cc-completion.ignoreWhenSuggestVisible')
                || event.affectsConfiguration('localalot.respectSelectedCompletionInfo')
                || event.affectsConfiguration('cc-completion.respectSelectedCompletionInfo')
                || event.affectsConfiguration('editor.quickSuggestions')) {
                this.invalidateCachedCompletions();
            }
        }));
        return this;
    }

    invalidateCachedCompletions(): void {
        if (this._disposed) return;
        this._stop();
        try { this._start(); }
        catch (error) {
            this._stop();
            this._setStartupError(String(error));
            this._log.error(`Original Ghost provider reset failed: ${String(error)}`);
        }
    }

    private _start(): void {
        if (!this._config.enabled || this._disposed) {
            this._setStartupError(undefined);
            return;
        }
        const file = path.join(this._context.extensionPath, 'dist', 'native-core.js');
        const native = __non_webpack_require__(file) as NativeGhostModule;
        const instance = native.createLocalGhostProvider(this._context);
        const provider = new Proxy(instance.provider, {
            get: (target, key) => {
                if (key === 'provideInlineCompletionItems') {
                    return (
                        document: vscode.TextDocument,
                        position: vscode.Position,
                        context: vscode.InlineCompletionContext,
                        token: vscode.CancellationToken,
                    ) => {
                        if (!this._config.enabled || !this._config.endpointConfigured
                            || this._nesHandlesCompletions()
                            || !isEligibleForInlineCompletion(document)) return undefined;
                        if (getLocalConfiguration('localalot', document.uri)
                            .get<boolean>('ignoreWhenSuggestVisible', false) && context.selectedCompletionInfo) return undefined;
                        const version = document.version;
                        return waitForIgnoreRules(instance.whenReady(), token).then(ready => {
                            if (!ready || token.isCancellationRequested || document.version !== version
                                || this._native !== instance || this._disposed
                                || !this._config.enabled || !this._config.endpointConfigured
                                || this._nesHandlesCompletions()
                                || !isEligibleForInlineCompletion(document)) return undefined;
                            return target.provideInlineCompletionItems(document, position, withNativeInlineContext(context), token);
                        });
                    };
                }
                const value = Reflect.get(target, key, target) as unknown;
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
        this._native = instance;
        this._registration = registerOriginalInlineCompletionProvider(
            { pattern: '**' }, provider,
            {
                displayName: 'Localalot',
                debounceDelayMs: 0,
                groupId: 'completions',
                // Match the upstream completion provider's arbitration rule.
                // This also prevents duplicate ghost text when Copilot is
                // installed but only partially disabled.
                excludes: ['github.copilot'],
            },
        );
        this._setStartupError(undefined);
        this._log.info('Original Copilot Ghost provider registered with Localalot endpoint');
    }

    private _setStartupError(message: string | undefined): void {
        if (this._startupError === message) return;
        this._startupError = message;
        this._onDidChangeAvailability.fire();
    }

    private _stop(): void {
        this._registration?.dispose();
        this._registration = undefined;
        this._native?.dispose();
        this._native = undefined;
    }

    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._stop();
        for (const listener of this._listeners) listener.dispose();
        this._listeners = [];
        this._onDidChangeAvailability.dispose();
    }
}
