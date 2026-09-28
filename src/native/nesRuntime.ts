import * as path from 'path';
import * as vscode from 'vscode';
import { getLocalConfiguration } from '../config/compatConfiguration';
import { INesConfigProvider } from '../config/nesConfig';
import { isEligibleForInlineCompletion } from '../completions/shared/documentEligibility';
import { ILogService } from '../completions/shared/log/logService';
import { registerOriginalInlineCompletionProvider } from '../completions/shared/inlineRegistration';
import { waitForIgnoreRules } from './ignoreReadiness';
import { withNativeInlineContext } from './inlineContext';

declare const __non_webpack_require__: NodeRequire;

interface NativeNesInstance extends vscode.Disposable {
    provider: vscode.InlineCompletionItemProvider;
    ready: Promise<void>;
    whenReady(): Promise<void>;
    handlesCompletions(): boolean;
}

interface NativeNesModule {
    createLocalNesProvider(context: vscode.ExtensionContext, readNextCursorEnabled: () => boolean): NativeNesInstance;
}

/** Registers the original Copilot inline edit provider with Localalot's model settings. */
export class NativeNesRuntime implements vscode.Disposable {
    private _native: NativeNesInstance | undefined;
    private _registration: vscode.Disposable | undefined;
    private _listeners: vscode.Disposable[] = [];
    private _disposed = false;
    private _startupError: string | undefined;
    private readonly _onDidChangeAvailability = new vscode.EventEmitter<void>();

    readonly onDidChangeAvailability = this._onDidChangeAvailability.event;
    get startupError(): string | undefined { return this._startupError; }

    get handlesCompletions(): boolean {
        return !this._disposed && !!this._registration && !!this._config.enabled && !!this._config.endpointConfigured
            && this._native?.handlesCompletions() === true;
    }

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _config: INesConfigProvider,
        private readonly _log: ILogService,
    ) { }

    register(): vscode.Disposable {
        try { this._start(); }
        catch (error) { this.dispose(); throw error; }
        this._listeners.push(this._config.onDidChangeEnabled(() => this.invalidateCachedEdits()));
        this._listeners.push(vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('localalot.nes')
                || event.affectsConfiguration('cc-completion.nes')
                || event.affectsConfiguration('localalot.nextEditSuggestions.enabled')
                || event.affectsConfiguration('localalot.nextEditSuggestions.extendedRange')
                || event.affectsConfiguration('localalot.nextEditSuggestions.eagerness')
                || event.affectsConfiguration('cc-completion.nextEditSuggestions.eagerness')
                || event.affectsConfiguration('localalot.enable')
                || event.affectsConfiguration('cc-completion.enable')
                || event.affectsConfiguration('localalot.exclude')
                || event.affectsConfiguration('cc-completion.exclude')) {
                this.invalidateCachedEdits();
            }
        }));
        return this;
    }

    invalidateCachedEdits(): void {
        if (this._disposed) return;
        this._stop();
        try { this._start(); }
        catch (error) {
            this._stop();
            this._setStartupError(String(error));
            this._log.error(`Original NES provider reset failed: ${String(error)}`);
        }
    }

    private _start(): void {
        if (!this._config.enabled || this._disposed) {
            this._setStartupError(undefined);
            return;
        }
        const file = path.join(this._context.extensionPath, 'dist', 'native-core.js');
        const native = __non_webpack_require__(file) as NativeNesModule;
        const instance = native.createLocalNesProvider(this._context, () => this._config.nextCursorPredictionEnabled);
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
                            || !isEligibleForInlineCompletion(document)) return undefined;
                        const version = document.version;
                        return waitForIgnoreRules(instance.whenReady(), token).then(ready => {
                            if (!ready || token.isCancellationRequested || document.version !== version
                                || this._native !== instance || this._disposed
                                || !this._config.enabled || !this._config.endpointConfigured
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
            { displayName: 'Localalot Next Edit', debounceDelayMs: 0, groupId: 'nes' },
        );
        this._setStartupError(undefined);
        this._log.info('Original Copilot NES provider registered with Localalot endpoint');
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
