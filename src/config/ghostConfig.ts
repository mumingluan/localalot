import * as vscode from 'vscode';
import { createServiceIdentifier } from '../di/services';
import { ConfigKeys } from './configKeys';

export type GhostEndpoint = 'completions' | 'fim/completions' | 'chat/completions' | 'responses' | 'messages';
export type GhostContextPlacement = 'extra' | 'prefix';

export interface GhostCapabilities {
    limits: {
        max_output_tokens: number;
        max_context_window_tokens: number;
    };
}

export const IGhostConfigProvider = createServiceIdentifier<IGhostConfigProvider>('IGhostConfigProvider');

export interface IGhostConfigProvider {
    readonly _serviceBrand: undefined;
    /** Increments whenever a ghost setting changes, including credentials. */
    get revision(): number;
    get enabled(): boolean;
    set enabled(value: boolean);
    get endpointConfigured(): boolean;
    get baseUrl(): string;
    get apiKey(): string;
    get model(): string;
    get family(): string;
    get endpoint(): GhostEndpoint;
    get contextPlacement(): GhostContextPlacement;
    get stops(): string[];
    get promptTemplate(): string;
    get capabilities(): GhostCapabilities;
    get maxOutputTokens(): number;
    get reasoningEffort(): string;
    get delay(): number;
    get presencePenalty(): number;
    get frequencyPenalty(): number;
    get stream(): boolean;
    onDidChangeEnabled(listener: () => void): vscode.Disposable;
}

export class VSCodeGhostConfigProvider implements IGhostConfigProvider {
    readonly _serviceBrand: undefined;

    private readonly _onDidChangeEnabled = new vscode.EventEmitter<void>();
    private readonly _stateKey = 'ghost.enabled';
    private readonly _cache = new Map<string, unknown>();
    private _revision = 0;
    private _enabledOverride: boolean | undefined;
    private _enabledWrite = 0;
    private _enabledPersist = Promise.resolve();

    constructor(private readonly _context: vscode.ExtensionContext) {
        _context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('localalot.ghost')) {
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

    // --- workspaceState (no cache) ---

    get revision(): number {
        return this._revision;
    }

    get enabled(): boolean {
        return this._enabledOverride ?? this._context.workspaceState.get<boolean>(this._stateKey, true);
    }

    set enabled(value: boolean) {
        if (this.enabled === value) return;
        this._enabledOverride = value;
        const write = ++this._enabledWrite;
        this._revision++;
        this._onDidChangeEnabled.fire();
        this._enabledPersist = this._enabledPersist.catch(() => undefined)
            .then(() => this._context.workspaceState.update(this._stateKey, value));
        void this._enabledPersist.catch(() => {
            if (this._enabledWrite !== write) return;
            this._enabledOverride = undefined;
            this._revision++;
            this._onDidChangeEnabled.fire();
        });
    }

    // --- settings.json (cached) ---

    get baseUrl(): string {
        return this._cached<string>(ConfigKeys.Ghost.baseUrl, '');
    }

    get endpointConfigured(): boolean {
        return this.baseUrl.trim().length > 0;
    }

    get apiKey(): string {
        return this._cached<string>(ConfigKeys.Ghost.apiKey, '');
    }

    get model(): string {
        return this._cached<string>(ConfigKeys.Ghost.model, 'gpt-4o');
    }

    get family(): string {
        return this._cached<string>(ConfigKeys.Ghost.family, 'standard');
    }

    get endpoint(): GhostEndpoint {
        return this._cached<GhostEndpoint>(ConfigKeys.Ghost.endpoint, 'completions');
    }

    get contextPlacement(): GhostContextPlacement {
        return this._cached<GhostContextPlacement>(ConfigKeys.Ghost.contextPlacement, 'prefix');
    }

    get stops(): string[] {
        return this._cached<string[]>(ConfigKeys.Ghost.stops, []);
    }

    get promptTemplate(): string {
        return this._cached<string>(
            ConfigKeys.Ghost.promptTemplate,
            '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
        );
    }

    get capabilities(): GhostCapabilities {
        const key = 'ghost.capabilities';
        if (this._cache.has(key)) {
            return this._cache.get(key) as GhostCapabilities;
        }
        const value: GhostCapabilities = {
            limits: {
                max_output_tokens: this.maxOutputTokens,
                max_context_window_tokens: this._cached<number>(ConfigKeys.Ghost.maxContextWindowTokens, 8192),
            },
        };
        this._cache.set(key, value);
        return value;
    }

    get maxOutputTokens(): number {
        return this._cached<number>(ConfigKeys.Ghost.maxOutputTokens, 500);
    }

    get reasoningEffort(): string {
        return this._cached<string>(ConfigKeys.Ghost.reasoningEffort, 'low');
    }

    get delay(): number {
        return this._cached<number>(ConfigKeys.Ghost.delay, 0);
    }

    get presencePenalty(): number {
        return this._cached<number>(ConfigKeys.Ghost.presencePenalty, 0);
    }

    get frequencyPenalty(): number {
        return this._cached<number>(ConfigKeys.Ghost.frequencyPenalty, 0);
    }

    get stream(): boolean {
        return this._cached<boolean>(ConfigKeys.Ghost.stream, true);
    }

    onDidChangeEnabled(listener: () => void): vscode.Disposable {
        return this._onDidChangeEnabled.event(listener);
    }
}
