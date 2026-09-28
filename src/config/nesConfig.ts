import * as vscode from 'vscode';
import { createServiceIdentifier } from '../di/services';
import { ConfigKeys } from './configKeys';

export type NesSupportedEndpoint = 'chat/completions' | 'responses' | 'messages' | 'completions';

export interface NesCapabilities {
    limits: {
        max_output_tokens: number;
        max_context_window_tokens: number;
    };
    supports: {
        thinking: boolean;
        reasoning_effort: string;
    };
}

export const INesConfigProvider = createServiceIdentifier<INesConfigProvider>('INesConfigProvider');

export interface INesConfigProvider {
    readonly _serviceBrand: undefined;
    /** Changes whenever settings affecting NES output or requests are updated. */
    get revision(): number;
    get enabled(): boolean;
    set enabled(value: boolean);
    get endpointConfigured(): boolean;
    get baseUrl(): string;
    get apiKey(): string;
    get model(): string;
    get family(): string;
    get endpoint(): NesSupportedEndpoint;
    get capabilities(): NesCapabilities;
    get maxOutputTokens(): number;
    get suffixOverlapThreshold(): number;
    get suffixOverlapType(): 'low' | 'high';
    get presencePenalty(): number;
    get frequencyPenalty(): number;
    get stream(): boolean;
    get nextCursorPredictionEnabled(): boolean;
    set nextCursorPredictionEnabled(value: boolean);
    get nextCursorJumpWithoutEdit(): boolean;
    get mimicGhostTextBehavior(): boolean;
    get promptTemplate(): string;
    readonly eagernessSelection?: string;
    setEagernessSelection?(value: string): void | Promise<void>;
    onDidChangeEnabled(listener: () => void): vscode.Disposable;
}

export class VSCodeNesConfigProvider implements INesConfigProvider {
    readonly _serviceBrand: undefined;

    private readonly _onDidChangeEnabled = new vscode.EventEmitter<void>();
    private readonly _enabledKey = 'nes.enabled';
    private readonly _ncpKey = 'nes.nextCursorPredictionEnabled';
    private readonly _eagernessKey = 'nes.eagernessSelection';
    private readonly _cache = new Map<string, unknown>();
    private _revision = 0;
    private _enabledOverride: boolean | undefined;
    private _ncpOverride: boolean | undefined;
    private _enabledWrite = 0;
    private _ncpWrite = 0;
    private _enabledPersist = Promise.resolve();
    private _ncpPersist = Promise.resolve();

    constructor(private readonly _context: vscode.ExtensionContext) {
        _context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('localalot.nes')) {
                    this._cache.clear();
                    this._revision++;
                }
            }),
        );
    }

    private _cached<T>(key: string, defaultValue: T): T {
        if (this._cache.has(key)) {
            return this._cache.get(key) as T;
        }
        const value = vscode.workspace.getConfiguration().get<T>(key, defaultValue);
        this._cache.set(key, value);
        return value;
    }

    get revision(): number {
        return this._revision;
    }

    get enabled(): boolean {
        return this._enabledOverride ?? this._context.workspaceState.get<boolean>(this._enabledKey, true);
    }

    set enabled(value: boolean) {
        if (this.enabled === value) return;
        this._enabledOverride = value;
        const write = ++this._enabledWrite;
        this._revision++;
        this._onDidChangeEnabled.fire();
        this._enabledPersist = this._enabledPersist.catch(() => undefined)
            .then(() => this._context.workspaceState.update(this._enabledKey, value));
        void this._enabledPersist.catch(() => {
            if (this._enabledWrite !== write) return;
            this._enabledOverride = undefined;
            this._revision++;
            this._onDidChangeEnabled.fire();
        });
    }

    get family(): string {
        return this._cached<string>(ConfigKeys.Nes.family, 'standard');
    }

    get nextCursorPredictionEnabled(): boolean {
        return this._ncpOverride ?? this._context.workspaceState.get<boolean>(this._ncpKey, true);
    }

    get nextCursorJumpWithoutEdit(): boolean {
        return this._cached<boolean>(ConfigKeys.Nes.nextCursorJumpWithoutEdit, false);
    }

    get eagernessSelection(): string {
        const value = this._context.workspaceState.get<string>(this._eagernessKey, 'auto');
        return ['auto', 'low', 'medium', 'high'].includes(value) ? value : 'auto';
    }

    setEagernessSelection(value: string): void {
        const normalized = ['auto', 'low', 'medium', 'high'].includes(value) ? value : 'auto';
        void this._context.workspaceState.update(this._eagernessKey, normalized);
        this._revision++;
    }

    set nextCursorPredictionEnabled(value: boolean) {
        if (this.nextCursorPredictionEnabled === value) return;
        this._ncpOverride = value;
        const write = ++this._ncpWrite;
        this._revision++;
        this._onDidChangeEnabled.fire();
        this._ncpPersist = this._ncpPersist.catch(() => undefined)
            .then(() => this._context.workspaceState.update(this._ncpKey, value));
        void this._ncpPersist.catch(() => {
            if (this._ncpWrite !== write) return;
            this._ncpOverride = undefined;
            this._revision++;
            this._onDidChangeEnabled.fire();
        });
    }

    get baseUrl(): string {
        return this._cached<string>(ConfigKeys.Nes.baseUrl, '');
    }

    get endpointConfigured(): boolean {
        return this.baseUrl.trim().length > 0;
    }

    get apiKey(): string {
        return this._cached<string>(ConfigKeys.Nes.apiKey, '');
    }

    get model(): string {
        return this._cached<string>(ConfigKeys.Nes.model, 'gpt-4o');
    }

    get endpoint(): NesSupportedEndpoint {
        return this._cached<NesSupportedEndpoint>(ConfigKeys.Nes.endpoint, 'chat/completions');
    }

    get capabilities(): NesCapabilities {
        const key = 'nes.capabilities';
        if (this._cache.has(key)) {
            return this._cache.get(key) as NesCapabilities;
        }
        const value: NesCapabilities = {
            limits: {
                max_output_tokens: this.maxOutputTokens,
                max_context_window_tokens: this._cached<number>(ConfigKeys.Nes.maxContextWindowTokens, 128000),
            },
            supports: {
                thinking: this._cached<boolean>(ConfigKeys.Nes.thinking, false),
                reasoning_effort: this._cached<string>(ConfigKeys.Nes.reasoningEffort, 'medium'),
            },
        };
        this._cache.set(key, value);
        return value;
    }

    get maxOutputTokens(): number {
        return this._cached<number>(ConfigKeys.Nes.maxOutputTokens, 9216);
    }

    get suffixOverlapThreshold(): number {
        return this._cached<number>(ConfigKeys.Nes.suffixOverlapThreshold, 1);
    }

    get suffixOverlapType(): 'low' | 'high' {
        return this._cached<'low' | 'high'>(ConfigKeys.Nes.suffixOverlapType, 'high');
    }

    get presencePenalty(): number {
        return this._cached<number>(ConfigKeys.Nes.presencePenalty, 0);
    }

    get frequencyPenalty(): number {
        return this._cached<number>(ConfigKeys.Nes.frequencyPenalty, 0);
    }

    get stream(): boolean {
        return this._cached<boolean>(ConfigKeys.Nes.stream, true);
    }

    get mimicGhostTextBehavior(): boolean {
        return this._cached<boolean>(ConfigKeys.Nes.mimicGhostTextBehavior, false);
    }

    get promptTemplate(): string {
        return this._cached<string>(
            ConfigKeys.Nes.promptTemplate,
            '<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n\n',
        );
    }

    onDidChangeEnabled(listener: () => void): vscode.Disposable {
        return this._onDidChangeEnabled.event(listener);
    }
}
