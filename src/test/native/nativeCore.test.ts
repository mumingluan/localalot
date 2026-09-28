import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { Worker } from 'worker_threads';
import { createStableAcceptanceBridge } from '../../completions/shared/inlineRegistration';

const execFileAsync = promisify(execFile);

suite('Original Copilot core bundle', () => {
    test('is independently activatable when GitHub Copilot is disabled', () => {
        const extension = vscode.extensions.getExtension('mumingluan.localalot');
        assert.ok(extension);
        const packageJson = extension.packageJSON as {
            activationEvents?: string[];
            extensionDependencies?: string[];
        };
        assert.ok(packageJson.activationEvents?.includes('onStartupFinished'));
        assert.deepStrictEqual(packageJson.extensionDependencies ?? [], []);
    });

    test('related files cache follows the provider and current ignore rules', async () => {
        const native = require('../../../dist/native-core.js') as {
            getRelatedFilesAndTraits(...args: unknown[]): Promise<{
                entries: Map<string, Map<string, string>>;
            }>;
            advanceRelatedFilesIgnoreRevision(): void;
        };
        const doc = { uri: 'file:///cache-context.ts', clientLanguageId: 'typescript', detectedLanguageId: 'typescript' };
        const logTarget = { logIt() {} };
        const providerFor = (value: string) => {
            let calls = 0;
            const provider = {
                getRelatedFiles: async () => {
                    calls++;
                    return { entries: new Map([['related/other', new Map([['file:///related.ts', value]])]]), traits: [] };
                },
            };
            const accessor = {
                get: (id: { toString(): string }) => {
                    switch (id.toString()) {
                        case 'instantiationService': return instantiation;
                        case 'ICompletionsLogTargetService': return logTarget;
                        case 'ICompletionsRelatedFilesProviderService': return provider;
                        default: throw new Error(`Unexpected service ${id.toString()}`);
                    }
                },
            };
            const instantiation = { invokeFunction: (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => fn(accessor, ...args) };
            return { accessor, get calls() { return calls; } };
        };
        const first = providerFor('first');
        const second = providerFor('second');
        const read = async (accessor: unknown) => (await native.getRelatedFilesAndTraits(accessor, doc, {}))
            .entries.get('related/other')?.get('file:///related.ts');

        assert.strictEqual(await read(first.accessor), 'first');
        assert.strictEqual(await read(first.accessor), 'first');
        assert.strictEqual(first.calls, 1);
        assert.strictEqual(await read(second.accessor), 'second');
        assert.strictEqual(second.calls, 1);
        native.advanceRelatedFilesIgnoreRevision();
        assert.strictEqual(await read(first.accessor), 'first');
        assert.strictEqual(first.calls, 2);
    });

    test('neighbor prompt context filters ignored open tabs and related files', async () => {
        const native = require('../../../dist/native-core.js') as {
            NeighborSource: {
                getNeighborFilesAndTraits(...args: unknown[]): Promise<{
                    docs: Map<string, unknown>;
                    neighborSource: Map<string, string[]>;
                }>;
            };
        };
        const openAllowed = 'file:///workspace/open.ts';
        const openIgnored = 'file:///workspace/open.secret.ts';
        const relatedAllowed = 'file:///workspace/related.ts';
        const relatedIgnored = 'file:///workspace/related.secret.ts';
        const openDocs = new Map([
            [openAllowed, { uri: openAllowed, source: 'open allowed' }],
            [openIgnored, { uri: openIgnored, source: 'open ignored' }],
        ]);
        const related = {
            entries: new Map([['related/other', new Map([
                [relatedAllowed, 'related allowed'], [relatedIgnored, 'related ignored'],
            ])]]),
            traits: [],
        };
        const services: Record<string, unknown> = {
            ICompletionsFeaturesService: { excludeRelatedFiles: () => false },
            ICompletionsLogTargetService: { logIt() {} },
            instantiationService: {
                createInstance: () => ({
                    getNeighborFiles: async () => ({
                        docs: openDocs,
                        neighborSource: new Map([['opentabs', [openAllowed, openIgnored]]]),
                    }),
                }),
                invokeFunction: async () => related,
            },
            ICompletionsTextDocumentManagerService: {
                getTextDocument: async () => ({ uri: 'file:///workspace/active.ts' }),
                getWorkspaceFolder: () => ({ uri: 'file:///workspace' }),
            },
            IIgnoreService: { isCopilotIgnored: async (uri: { toString(): string }) => uri.toString().endsWith('.secret.ts') },
        };
        const accessor = { get: (id: { toString(): string }) => services[id.toString()] };
        const result = await native.NeighborSource.getNeighborFilesAndTraits(
            accessor, 'file:///workspace/active.ts', 'typescript', {}, undefined, undefined, false, true,
        );
        assert.deepStrictEqual([...result.docs.keys()], [openAllowed, relatedAllowed]);
        assert.deepStrictEqual(result.neighborSource.get('opentabs'), [openAllowed]);
        assert.deepStrictEqual(result.neighborSource.get('related/other'), [relatedAllowed]);
    });

    test('neighbor files use the current Ghost or NES service container', async () => {
        const native = require('../../../dist/native-core.js') as {
            NeighborSource: {
                reset(): void;
                getNeighborFilesAndTraits(...args: unknown[]): Promise<{ docs: Map<string, unknown> }>;
            };
        };
        const accessorFor = (name: string) => {
            let next = 0;
            let created = 0;
            const source = {
                getNeighborFiles: async () => ({
                    docs: new Map([[name, { uri: name, source: name }]]), neighborSource: new Map(),
                }),
            };
            const services = [{}, {}, { createInstance: () => { created++; return source; } }, {}, {
                isCopilotIgnored: async () => false,
            }];
            return { accessor: { get: () => services[next++] }, get created() { return created; } };
        };
        native.NeighborSource.reset();
        const ghost = accessorFor('ghost-neighbor');
        const nes = accessorFor('nes-neighbor');
        try {
            const collect = (accessor: unknown) => native.NeighborSource.getNeighborFilesAndTraits(
                accessor, 'file:///active.ts', 'typescript', {}, undefined, undefined, undefined, false,
            );
            assert.deepStrictEqual([...((await collect(ghost.accessor)).docs.keys())], ['ghost-neighbor']);
            assert.deepStrictEqual([...((await collect(nes.accessor)).docs.keys())], ['nes-neighbor']);
            assert.strictEqual(ghost.created, 1);
            assert.strictEqual(nes.created, 1);
        } finally {
            native.NeighborSource.reset();
        }
    });

    test('activates the original TypeScript server plugin', async function () {
        this.timeout(20000);
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'localalot-ts-plugin-'));
        const file = path.join(directory, 'sample.ts');
        try {
            await fs.writeFile(file, [
                'interface Person { name: string; age: number; }',
                'function greet(person: Person) {',
                '  return person.name;',
                '}',
            ].join('\n'));
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            await vscode.window.showTextDocument(document);
            const tsExtension = vscode.extensions.getExtension('vscode.typescript-language-features');
            assert.ok(tsExtension, 'VS Code TypeScript extension is unavailable');
            await tsExtension.activate();
            const token = new vscode.CancellationTokenSource();
            let response: { body?: { kind?: string; message?: string } } | undefined;
            let lastError: unknown;
            try {
                for (let attempt = 0; attempt < 10 && response?.body?.kind !== 'ok'; attempt++) {
                    try {
                        response = await vscode.commands.executeCommand(
                            'typescript.tsserverRequest', '_.copilot.ping', { executionTarget: 0 }, token.token,
                        );
                    } catch (error) {
                        lastError = error;
                    }
                    if (response?.body?.kind !== 'ok') await new Promise(resolve => setTimeout(resolve, 500));
                }
            } finally {
                token.dispose();
            }
            assert.strictEqual(response?.body?.kind, 'ok',
                response?.body?.message ?? `TypeScript plugin did not answer ping: ${String(lastError)}`);
            const contextToken = new vscode.CancellationTokenSource();
            try {
                const contextResponse = await vscode.commands.executeCommand<{ body?: { state?: unknown; message?: string } }>(
                    'typescript.tsserverRequest', '_.copilot.context', {
                        file: document.uri,
                        line: 3,
                        offset: 16,
                        startTime: Date.now(),
                        timeBudget: 1000,
                        primaryCharacterBudget: 4000,
                        secondaryCharacterBudget: 4000,
                    }, { executionTarget: 0 }, contextToken.token,
                );
                assert.ok(contextResponse?.body?.state !== undefined,
                    contextResponse?.body?.message ?? 'TypeScript plugin did not compute context');
            } finally {
                contextToken.dispose();
            }
            const extension = vscode.extensions.getExtension('mumingluan.localalot');
            assert.ok(extension);
            await extension.activate();
            const commands = await vscode.commands.getCommands(true);
            assert.ok(commands.includes('github.copilot.nes.prepareRename'),
                'Original NES rename prepare command was not registered');
            assert.ok(commands.includes('github.copilot.nes.postRename'),
                'Original NES rename follow-up command was not registered');
            const rename = await vscode.commands.executeCommand<{ canRename: string }>(
                'github.copilot.nes.prepareRename', document.uri, new vscode.Position(2, 11),
                'person', 'user', 'original-ts-nes-rename-test', undefined,
            );
            assert.ok(rename && ['yes', 'maybe'].includes(rename.canRename),
                `Original NES rename prepare rejected a valid local symbol: ${JSON.stringify(rename)}`);
            const subscriptions: vscode.Disposable[] = [];
            const native = require('../../../dist/native-core.js') as {
                createLocalGhostProvider(context: unknown, options?: () => unknown): {
                    provider: { provideInlineCompletionItems(...args: unknown[]): Promise<unknown> };
                    getContextProviders(): Array<{ id: string; resolver: { resolve(request: unknown, token: vscode.CancellationToken): Promise<unknown> } }>;
                    dispose(): void;
                };
                createLocalNesProvider(context: unknown): {
                    getContextProviders(): Array<{ id: string; resolver: { resolve(request: unknown, token: vscode.CancellationToken): Promise<unknown> } }>;
                    dispose(): void;
                };
            };
            let posted = '';
            const server = http.createServer((request, response) => {
                const chunks: Buffer[] = [];
                request.on('data', chunk => chunks.push(chunk));
                request.on('end', () => {
                    posted = Buffer.concat(chunks).toString('utf8');
                    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, text: ';', finish_reason: 'stop' }] })}\n\n`);
                });
            });
            await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
            const address = server.address();
            assert.ok(address && typeof address !== 'string');
            let ghost: ReturnType<typeof native.createLocalGhostProvider> | undefined;
            const bridgeToken = new vscode.CancellationTokenSource();
            try {
                ghost = native.createLocalGhostProvider({
                    extension, extensionUri: extension.extensionUri, extensionPath: extension.extensionPath,
                    extensionMode: vscode.ExtensionMode.Test, subscriptions,
                    globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
                }, () => ({
                    baseUrl: `http://127.0.0.1:${address.port}`,
                    apiKey: '', model: 'local-model', endpoint: 'fim/completions',
                    maxOutputTokens: 128, promptTemplate: '', stops: [], contextPlacement: 'prefix',
                }));
                const provider = ghost.getContextProviders().find(item => item.id === 'typescript-ai-context-provider');
                assert.ok(provider, 'Original TypeScript context provider was not registered with Ghost');
                const position = new vscode.Position(2, 15);
                const items = await provider.resolver.resolve({
                    completionId: 'original-ts-bridge-test',
                    documentContext: {
                        uri: document.uri.toString(), languageId: document.languageId, version: document.version,
                        offset: document.offsetAt(position), position,
                    },
                    activeExperiments: new Map(), timeBudget: 1000, timeoutEnd: Date.now() + 1000,
                    source: 'completion',
                }, bridgeToken.token);
                assert.ok(Array.isArray(items) && items.length > 0,
                    `Original TypeScript server context did not reach Ghost: ${JSON.stringify(items)}`);
                await ghost.provider.provideInlineCompletionItems(
                    document, new vscode.Position(2, 21),
                    { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, requestUuid: 'original-ts-prompt-test' },
                    bridgeToken.token,
                );
                assert.ok(posted.includes('6.0.3'),
                    `Original TypeScript context did not reach the Ghost model request: ${posted.slice(0, 1200)}`);
            } finally {
                bridgeToken.dispose();
                ghost?.dispose();
                vscode.Disposable.from(...subscriptions).dispose();
                await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            }
            const nesSubscriptions: vscode.Disposable[] = [];
            const nes = native.createLocalNesProvider({
                extension, extensionUri: extension.extensionUri, extensionPath: extension.extensionPath,
                extensionMode: vscode.ExtensionMode.Test, subscriptions: nesSubscriptions,
                globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
            });
            const nesToken = new vscode.CancellationTokenSource();
            try {
                const provider = nes.getContextProviders().find(item => item.id === 'typescript-ai-context-provider');
                assert.ok(provider, 'Original TypeScript context provider was not registered with NES');
                const position = new vscode.Position(2, 15);
                const items = await provider.resolver.resolve({
                    completionId: 'original-ts-nes-bridge-test',
                    documentContext: {
                        uri: document.uri.toString(), languageId: document.languageId, version: document.version,
                        offset: document.offsetAt(position), position,
                    },
                    activeExperiments: new Map(), timeBudget: 1000, timeoutEnd: Date.now() + 1000,
                    source: 'nes',
                }, nesToken.token);
                assert.ok(Array.isArray(items) && items.length > 0,
                    `Original TypeScript server context did not reach NES: ${JSON.stringify(items)}`);
            } finally {
                nesToken.dispose();
                nes.dispose();
                vscode.Disposable.from(...nesSubscriptions).dispose();
            }
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    test('releases the original Git service listeners after a Ghost reset', async function () {
        this.timeout(5000);
        const native = require('../../../dist/native-core.js') as {
            GitExtensionServiceImpl: new (log: unknown) => {
                dispose(): void;
                _disposables: vscode.Disposable[];
            };
        };
        const service = new native.GitExtensionServiceImpl({ info() { }, error() { } });
        try {
            await vscode.extensions.getExtension('vscode.git')?.activate();
            await new Promise(resolve => setTimeout(resolve, 100));
            assert.ok(service._disposables.length > 0, 'Git service did not register a listener');
        } finally {
            service.dispose();
        }
        assert.strictEqual(service._disposables.length, 0, 'Git listeners survived disposal');
        service.dispose();
    });

    test('loads the original exact cl100k and o200k Ghost tokenizers', async () => {
        const native = require('../../../dist/native-core.js') as {
            ensureTokenizersLoaded(): Promise<void>;
            getTokenizer(name: string): { tokenize(text: string): number[] };
            TokenizerName: { cl100k: string; o200k: string };
            TTokenizer: new (...args: unknown[]) => unknown;
            LocalModelManager: new () => { getTokenizerForModel(): string };
        };
        await native.ensureTokenizersLoaded();
        const cl100k = native.getTokenizer(native.TokenizerName.cl100k);
        const o200k = native.getTokenizer(native.TokenizerName.o200k);
        assert.ok(cl100k instanceof native.TTokenizer, 'Ghost fell back to approximate cl100k tokenization');
        assert.ok(o200k instanceof native.TTokenizer, 'Ghost fell back to approximate o200k tokenization');
        assert.notDeepStrictEqual(cl100k.tokenize('hello world'), o200k.tokenize('hello world'));
        const config = vscode.workspace.getConfiguration('localalot.ghost');
        const previous = config.inspect<string>('tokenizer')?.globalValue;
        try {
            const models = new native.LocalModelManager();
            await config.update('tokenizer', 'cl100k_base', vscode.ConfigurationTarget.Global);
            assert.strictEqual(models.getTokenizerForModel(), native.TokenizerName.cl100k);
            await config.update('tokenizer', 'o200k_base', vscode.ConfigurationTarget.Global);
            assert.strictEqual(models.getTokenizerForModel(), native.TokenizerName.o200k);
        } finally {
            await config.update('tokenizer', previous, vscode.ConfigurationTarget.Global);
        }
    });

    test('bundles and runs the original diff worker used after NES acceptance', async function () {
        this.timeout(5000);
        const worker = new Worker(path.resolve(__dirname, '../../../dist/diffWorker.js'));
        try {
            const response = await new Promise<{ res?: { identical: boolean; changes: unknown[] }; err?: Error }>((resolve, reject) => {
                worker.once('message', resolve);
                worker.once('error', reject);
                worker.postMessage({
                    id: 1, fn: 'computeDiff',
                    args: ['const value = 1;', 'const value = 2;', {
                        ignoreTrimWhitespace: false, maxComputationTimeMs: 1000, computeMoves: false,
                    }],
                });
            });
            assert.strictEqual(response.err, undefined);
            assert.strictEqual(response.res?.identical, false);
            assert.ok(response.res?.changes.length);
        } finally {
            await worker.terminate();
        }
    });

    test('loads Ghost, NES, cursor prediction and the original inline-position rule', () => {
        const native = require('../../../dist/native-core.js') as {
            GhostText: unknown;
            GhostTextProvider: unknown;
            XtabProvider: unknown;
            XtabNextCursorPredictor: unknown;
            NextEditProvider: unknown;
            InlineCompletionProviderImpl: unknown;
            isInlineSuggestionFromTextAfterCursor(text: string): boolean | undefined;
        };
        for (const key of [
            'GhostText', 'GhostTextProvider', 'XtabProvider',
            'XtabNextCursorPredictor', 'NextEditProvider', 'InlineCompletionProviderImpl',
        ] as const) {
            assert.strictEqual(typeof native[key], 'function', key);
        }
        assert.strictEqual(native.isInlineSuggestionFromTextAfterCursor(''), false);
        assert.strictEqual(native.isInlineSuggestionFromTextAfterCursor(');'), true);
        assert.strictEqual(native.isInlineSuggestionFromTextAfterCursor('existingCode'), undefined);
    });
});

suite('Original Copilot local transport', () => {
    test('reports local request failures and clears them after recovery', async () => {
        const originalFetch = globalThis.fetch;
        let ghostFails = true;
        let nesFails = true;
        globalThis.fetch = (async url => {
            const isNes = String(url).endsWith('/chat/completions');
            if (isNes ? nesFails : ghostFails) return new Response(isNes
                ? JSON.stringify({ error: { message: 'model unavailable' } }) : 'model unavailable', { status: 503 });
            return new Response(JSON.stringify(isNes
                ? { choices: [{ message: { content: 'edited' }, finish_reason: 'stop' }] }
                : { choices: [{ index: 0, text: 'completed', finish_reason: 'stop' }] }),
            { headers: { 'Content-Type': 'application/json' } });
        }) as typeof fetch;
        const native = require('../../../dist/native-core.js') as {
            LocalGhostTransport: new (options: () => unknown) => {
                fetchAndStreamCompletions(params: unknown, telemetry: unknown, callback: unknown): Promise<{
                    type: string; choices?: AsyncIterable<unknown>;
                }>;
            };
            LocalNesEndpoint: new (model: string | undefined, options: () => unknown) => {
                makeChatRequest2(options: unknown, token: vscode.CancellationToken): Promise<{ type: string; reason?: string }>;
            };
            onDidChangeLocalRequestStatus(listener: () => void): vscode.Disposable;
            getLocalRequestStatuses(): Array<{ component: string; message: string }>;
        };
        let changes = 0;
        const listener = native.onDidChangeLocalRequestStatus(() => changes++);
        const ghost = new native.LocalGhostTransport(() => ({
            baseUrl: 'http://127.0.0.1:1', apiKey: '', model: 'local-model',
            endpoint: 'completions', maxOutputTokens: 128, promptTemplate: '{prefix}', stops: [], stream: false,
        }));
        const nes = new native.LocalNesEndpoint(undefined, () => ({
            model: 'local-nes', baseUrl: 'http://127.0.0.1:1', apiKey: '', endpoint: 'chat/completions',
            family: 'standard', maxOutputTokens: 128, maxContextWindowTokens: 8192,
            promptTemplate: '{system}\n{user}', presencePenalty: 0, frequencyPenalty: 0,
            stream: false, thinking: false, reasoningEffort: 'none',
        }));
        const ghostParams = {
            prompt: { prefix: 'const x = ', suffix: '', context: [] },
            engineModelId: 'ignored', ourRequestId: 'request-status-test', languageId: 'typescript', count: 1,
        };
        const nesParams = {
            debugName: 'request-status-test', messages: [{ role: 1, content: [{ type: 1, text: 'PRIVATE_SOURCE_MARKER_926' }] }],
            location: 6, requestOptions: { max_tokens: 64 },
        };
        const token = new vscode.CancellationTokenSource();
        try {
            assert.strictEqual((await ghost.fetchAndStreamCompletions(ghostParams, {}, () => undefined)).type, 'failed');
            assert.match(native.getLocalRequestStatuses().find(status => status.component === 'ghost')?.message ?? '', /503/);
            const nesFailure = await nes.makeChatRequest2(nesParams, token.token);
            assert.strictEqual(nesFailure.type, 'failed');
            assert.match(native.getLocalRequestStatuses().find(status => status.component === 'nes')?.message ?? '', /503/);
            assert.match(nesFailure.reason ?? '', /model unavailable/);
            assert.ok(!nesFailure.reason?.includes('PRIVATE_SOURCE_MARKER_926'));
            assert.ok(!native.getLocalRequestStatuses().some(status => status.message.includes('PRIVATE_SOURCE_MARKER_926')));

            ghostFails = false;
            const recoveredGhost = await ghost.fetchAndStreamCompletions(ghostParams, {}, () => undefined);
            assert.strictEqual(recoveredGhost.type, 'success');
            for await (const _choice of recoveredGhost.choices ?? []) { /* consume */ }
            assert.ok(!native.getLocalRequestStatuses().some(status => status.component === 'ghost'));
            assert.ok(native.getLocalRequestStatuses().some(status => status.component === 'nes'));

            nesFails = false;
            assert.strictEqual((await nes.makeChatRequest2(nesParams, token.token)).type, 'success');
            assert.ok(!native.getLocalRequestStatuses().some(status => status.component === 'nes'));
            assert.ok(changes >= 4);
        } finally {
            listener.dispose();
            token.dispose();
            globalThis.fetch = originalFetch;
        }
    });

    test('aborts the local Ghost request when the original provider stops reading', async () => {
        const originalFetch = globalThis.fetch;
        let signal: AbortSignal | undefined;
        globalThis.fetch = (async (_url, init) => {
            signal = init?.signal as AbortSignal;
            return new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(
                        'data: {"choices":[{"index":0,"text":"first\\n","finish_reason":null}]}\n\n',
                    ));
                },
            }), { headers: { 'Content-Type': 'text/event-stream' } });
        }) as typeof fetch;
        try {
            const native = require('../../../dist/native-core.js') as {
                LocalGhostTransport: new (options: () => unknown) => {
                    fetchAndStreamCompletions(params: unknown, telemetry: unknown, callback: unknown): Promise<{
                        type: string; choices?: AsyncIterable<{ completionText: string }>;
                    }>;
                };
            };
            const transport = new native.LocalGhostTransport(() => ({
                baseUrl: 'http://127.0.0.1:1', apiKey: '', model: 'local-model',
                endpoint: 'completions', maxOutputTokens: 128, promptTemplate: '{prefix}', stops: [],
            }));
            const result = await transport.fetchAndStreamCompletions({
                prompt: { prefix: 'start', suffix: '', context: [] },
                engineModelId: 'ignored', ourRequestId: 'early-stop-test',
                languageId: 'plaintext', count: 1,
            }, {}, () => ({ yieldSolution: true, continueStreaming: true }));
            assert.strictEqual(result.type, 'success');
            const iterator = result.choices![Symbol.asyncIterator]();
            assert.strictEqual((await iterator.next()).value?.completionText, 'first\n');
            assert.strictEqual(signal?.aborted, false);
            await iterator.return?.();
            assert.strictEqual(signal?.aborted, true);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test('sends configured Ghost output and sampling limits to the local model', async () => {
        let posted: Record<string, unknown> | undefined;
        const server = http.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(chunk));
            request.on('end', () => {
                posted = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ choices: [{ index: 0, text: 'done', finish_reason: 'stop' }] }));
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const config = vscode.workspace.getConfiguration('localalot.ghost');
        const changes: Array<[string, unknown, unknown]> = [
            ['baseUrl', `http://127.0.0.1:${address.port}`, config.inspect<string>('baseUrl')?.globalValue],
            ['model', 'local-ghost-test', config.inspect<string>('model')?.globalValue],
            ['endpoint', 'completions', config.inspect<string>('endpoint')?.globalValue],
            ['capabilities.limits.max_output_tokens', 37, config.inspect<number>('capabilities.limits.max_output_tokens')?.globalValue],
            ['presencePenalty', 0.3, config.inspect<number>('presencePenalty')?.globalValue],
            ['frequencyPenalty', 0.4, config.inspect<number>('frequencyPenalty')?.globalValue],
            ['stream', false, config.inspect<boolean>('stream')?.globalValue],
        ];
        try {
            for (const [key, value] of changes) await config.update(key, value, vscode.ConfigurationTarget.Global);
            const native = require('../../../dist/native-core.js') as {
                LocalGhostTransport: new () => {
                    fetchAndStreamCompletions(params: unknown, telemetry: unknown, callback: unknown): Promise<{
                        type: string; choices?: AsyncIterable<{ completionText: string }>;
                    }>;
                };
            };
            const result = await new native.LocalGhostTransport().fetchAndStreamCompletions({
                prompt: { prefix: 'const value = ', suffix: '', context: [] },
                engineModelId: 'ignored', ourRequestId: 'configured-ghost-test', languageId: 'typescript', count: 1,
                postOptions: { max_tokens: 90 },
            }, {}, () => undefined);
            assert.strictEqual(result.type, 'success');
            const choices: string[] = [];
            for await (const choice of result.choices ?? []) choices.push(choice.completionText);
            assert.deepStrictEqual(choices, ['done']);
            assert.strictEqual(posted?.model, 'local-ghost-test');
            assert.strictEqual(posted?.max_tokens, 37);
            assert.strictEqual(posted?.presence_penalty, 0.3);
            assert.strictEqual(posted?.frequency_penalty, 0.4);
            assert.strictEqual(posted?.stream, false);
        } finally {
            for (const [key, , original] of changes) await config.update(key, original, vscode.ConfigurationTarget.Global);
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    test('releases cancellation listener after a failed local Ghost response', async () => {
        const server = http.createServer((_request, response) => {
            response.writeHead(503, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: { message: 'model unavailable' }, prompt: 'PRIVATE_SOURCE_MARKER' }));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const address = server.address();
            assert.ok(address && typeof address !== 'string');
            const native = require('../../../dist/native-core.js') as {
                LocalGhostTransport: new (options: () => unknown) => {
                    fetchAndStreamCompletions(params: unknown, telemetry: unknown, callback: unknown, token: unknown): Promise<{ type: string; reason?: string }>;
                };
            };
            let disposed = 0;
            const token = {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose: () => { disposed++; } }),
            };
            const transport = new native.LocalGhostTransport(() => ({
                baseUrl: `http://127.0.0.1:${address.port}`,
                apiKey: '', model: 'local-model', endpoint: 'completions',
                maxOutputTokens: 128, promptTemplate: '{prefix}', stops: [],
            }));
            const result = await transport.fetchAndStreamCompletions({
                prompt: { prefix: 'const x = ', suffix: '', context: [] },
                engineModelId: 'ignored', ourRequestId: 'failed-local-test',
                languageId: 'typescript', count: 1,
            }, {}, () => undefined, token);
            assert.strictEqual(result.type, 'failed');
            assert.match(result.reason ?? '', /503.*model unavailable/);
            assert.ok(!result.reason?.includes('PRIVATE_SOURCE_MARKER'), 'endpoint error echoed source into the status menu');
            assert.strictEqual(disposed, 1);
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    test('preserves original prompt fields and streams local choices', async () => {
        let posted: Record<string, unknown> | undefined;
        const server = http.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(chunk));
            request.on('end', () => {
                posted = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.write(`data: ${JSON.stringify({ choices: [{ index: 0, text: '\n  image:', finish_reason: null }] })}\n\n`);
                response.end('data: {"choices":[{"index":0,"text":" nginx","finish_reason":"stop"}]}\n\n');
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const address = server.address();
            assert.ok(address && typeof address !== 'string');
            const native = require('../../../dist/native-core.js') as {
                LocalGhostTransport: new (options: () => unknown) => {
                    fetchAndStreamCompletions(params: unknown, telemetry: unknown, callback: unknown): Promise<{
                        type: string;
                        choices?: AsyncIterable<{ completionText: string }>;
                    }>;
                };
            };
            const transport = new native.LocalGhostTransport(() => ({
                baseUrl: `http://127.0.0.1:${address.port}`,
                apiKey: '',
                model: 'local-model',
                endpoint: 'fim/completions',
                maxOutputTokens: 128,
                promptTemplate: '',
                stops: [],
                contextPlacement: 'prefix',
            }));
            const result = await transport.fetchAndStreamCompletions({
                prompt: { prefix: 'services:\n  web:', suffix: '\n  db:', context: ['# nearby: worker.ts\nconst image = "nginx";'] },
                engineModelId: 'ignored',
                ourRequestId: 'local-test',
                languageId: 'yaml',
                count: 1,
                extra: { language: 'yaml' },
            }, {}, () => undefined);
            assert.strictEqual(result.type, 'success');
            const choices: string[] = [];
            for await (const choice of result.choices ?? []) choices.push(choice.completionText);
            assert.deepStrictEqual(choices, ['\n  image: nginx']);
            assert.strictEqual(posted?.prompt, '# nearby: worker.ts\nconst image = "nginx";\nservices:\n  web:');
            assert.strictEqual(posted?.suffix, '\n  db:');
            assert.strictEqual(posted?.model, 'local-model');
            assert.strictEqual(posted?.max_tokens, 128);
            assert.ok(!('context' in (posted?.extra as Record<string, unknown>)));

            const extraTransport = new native.LocalGhostTransport(() => ({
                baseUrl: `http://127.0.0.1:${address.port}`,
                apiKey: '',
                model: 'local-model',
                endpoint: 'fim/completions',
                maxOutputTokens: 128,
                promptTemplate: '',
                stops: [],
                contextPlacement: 'extra',
            }));
            const extraResult = await extraTransport.fetchAndStreamCompletions({
                prompt: { prefix: 'services:\n  web:', suffix: '\n  db:', context: ['# nearby: worker.ts\nconst image = "nginx";'] },
                engineModelId: 'ignored',
                ourRequestId: 'local-extra-test',
                languageId: 'yaml',
                count: 1,
                extra: { language: 'yaml' },
            }, {}, () => undefined);
            assert.strictEqual(extraResult.type, 'success');
            for await (const _choice of extraResult.choices ?? []) { /* consume the stream */ }
            assert.strictEqual(posted?.prompt, 'services:\n  web:');
            assert.deepStrictEqual((posted?.extra as Record<string, unknown>).context, ['# nearby: worker.ts\nconst image = "nginx";']);
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });
    test('adapts original Ghost prompts and chat choices at the local chat endpoint', async () => {
        const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
        const server = http.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(chunk));
            request.on('end', () => {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
                posted.push({ path: request.url ?? '', body });
                if (body.stream) {
                    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    response.end('data: {"choices":[{"index":0,"delta":{"content":"\\n  image: nginx"},"finish_reason":"stop"}]}\n\n');
                } else {
                    response.writeHead(200, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify({ choices: [{ index: 0, message: { content: '\n  image: alpine' }, finish_reason: 'stop' }] }));
                }
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const address = server.address();
            assert.ok(address && typeof address !== 'string');
            const native = require('../../../dist/native-core.js') as {
                LocalGhostTransport: new (options: () => unknown) => {
                    fetchAndStreamCompletions(params: unknown, telemetry: unknown, callback: unknown): Promise<{
                        type: string; choices?: AsyncIterable<{ completionText: string }>;
                    }>;
                };
            };
            for (const stream of [true, false]) {
                const transport: InstanceType<typeof native.LocalGhostTransport> = new native.LocalGhostTransport((): unknown => ({
                    baseUrl: `http://127.0.0.1:${address.port}`,
                    apiKey: '', model: 'local-chat-model', endpoint: 'chat/completions',
                    maxOutputTokens: 80, promptTemplate: 'unused', stops: [], contextPlacement: 'prefix', stream,
                }));
                const result: { type: string; choices?: AsyncIterable<{ completionText: string }> } = await transport.fetchAndStreamCompletions({
                    prompt: { prefix: 'services:\n  web:', suffix: '\n  db:', context: ['# nearby: nginx configuration'] },
                    engineModelId: 'ignored', ourRequestId: `chat-${stream}`,
                    languageId: 'yaml', count: 1, postOptions: { max_tokens: 32 },
                }, {}, () => undefined);
                assert.strictEqual(result.type, 'success');
                const choices: string[] = [];
                for await (const choice of result.choices ?? []) choices.push(choice.completionText);
                assert.deepStrictEqual(choices, [stream ? '\n  image: nginx' : '\n  image: alpine']);
            }
            assert.strictEqual(posted.length, 2);
            for (const { path, body } of posted) {
                assert.strictEqual(path, '/chat/completions');
                assert.strictEqual(body.model, 'local-chat-model');
                assert.strictEqual(body.max_tokens, 32);
                assert.ok(!('prompt' in body));
                assert.ok(!('extra' in body));
                const messages = body.messages as Array<{ role: string; content: string }>;
                assert.deepStrictEqual(messages.map(message => message.role), ['system', 'user']);
                assert.ok(messages[1].content.includes('# nearby: nginx configuration'));
                assert.ok(messages[1].content.includes('<CODE_BEFORE>services:\n  web:</CODE_BEFORE>'));
                assert.ok(messages[1].content.includes('<CODE_AFTER>\n  db:</CODE_AFTER>'));
            }
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });
    test('adapts original Ghost prompts to Responses and Messages endpoints', async () => {
        const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
        const server = http.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(chunk));
            request.on('end', () => {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
                posted.push({ path: request.url ?? '', body });
                const text = '\n  image: nginx';
                if (body.stream) {
                    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    response.end(request.url === '/responses'
                        ? `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`
                        : `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n\n`);
                } else {
                    response.writeHead(200, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify(request.url === '/responses'
                        ? { output: [{ type: 'message', content: [{ type: 'output_text', text }] }], status: 'completed' }
                        : { content: [{ type: 'text', text }], stop_reason: 'end_turn' }));
                }
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const address = server.address();
            assert.ok(address && typeof address !== 'string');
            const native = require('../../../dist/native-core.js') as {
                LocalGhostTransport: new (options: () => unknown) => {
                    fetchAndStreamCompletions(params: unknown, telemetry: unknown, callback: unknown): Promise<{
                        type: string; choices?: AsyncIterable<{ completionText: string }>;
                    }>;
                };
            };
            for (const endpoint of ['responses', 'messages'] as const) {
                for (const contextPlacement of ['prefix', 'extra'] as const) {
                    for (const stream of [true, false]) {
                        const transport: InstanceType<typeof native.LocalGhostTransport> = new native.LocalGhostTransport((): unknown => ({
                            baseUrl: `http://127.0.0.1:${address.port}`,
                            apiKey: '', model: 'local-model', endpoint,
                            family: contextPlacement === 'extra' ? 'openai-gpt5' : 'standard',
                            reasoningEffort: 'low',
                            maxOutputTokens: 80, promptTemplate: 'unused', stops: [],
                            contextPlacement, stream,
                        }));
                        const result: { type: string; choices?: AsyncIterable<{ completionText: string }> } = await transport.fetchAndStreamCompletions({
                            prompt: { prefix: 'services:\n  web:', suffix: '\n  db:', context: ['# nearby: nginx configuration'] },
                            engineModelId: 'ignored', ourRequestId: `${endpoint}-${stream}`,
                            languageId: 'yaml', count: 1, postOptions: { max_tokens: 32 },
                        }, {}, () => undefined);
                        assert.strictEqual(result.type, 'success');
                        const choices: string[] = [];
                        for await (const choice of result.choices ?? []) choices.push(choice.completionText);
                        assert.deepStrictEqual(choices, ['\n  image: nginx']);
                    }
                }
            }
            assert.strictEqual(posted.length, 8);
            for (const { path, body } of posted) {
                const isResponses = path === '/responses';
                assert.ok(isResponses || path === '/messages');
                assert.strictEqual(body.model, 'local-model');
                assert.strictEqual(isResponses ? body.max_output_tokens : body.max_tokens, 32);
                const input = (isResponses ? body.input : body.messages) as Array<{ role: string; content: string }>;
                const separateContext = isResponses
                    ? input.some(message => message.role === 'developer')
                    : String(body.system).includes('# nearby: nginx configuration');
                assert.deepStrictEqual(input.map(message => message.role), isResponses
                    ? (separateContext ? ['developer', 'system', 'user'] : ['system', 'user']) : ['user']);
                assert.strictEqual(input.at(-1)?.content.includes('# nearby: nginx configuration'), !separateContext);
                if (separateContext && isResponses) assert.ok(input[0].content.includes('# nearby: nginx configuration'));
                if (isResponses && separateContext) {
                    assert.deepStrictEqual(body.reasoning, { effort: 'low' });
                    assert.ok(!('temperature' in body) && !('top_p' in body));
                } else if (isResponses) {
                    assert.ok(!('reasoning' in body));
                    assert.strictEqual(body.temperature, 0);
                }
                assert.ok(input.at(-1)?.content.includes('<CODE_BEFORE>services:\n  web:</CODE_BEFORE>'));
                assert.ok(input.at(-1)?.content.includes('<CODE_AFTER>\n  db:</CODE_AFTER>'));
                if (!isResponses) assert.ok(typeof body.system === 'string');
            }
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });
});

suite('Original Copilot provider bootstrap', () => {
    test('uses the configured local Ghost context window in the original prompt builder', async function () {
        this.timeout(15000);
        const prompts: string[] = [];
        const server = http.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(chunk));
            request.on('end', () => {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { prompt: string };
                prompts.push(body.prompt);
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end('data: {"choices":[{"index":0,"text":" done","finish_reason":"stop"}]}\n\n');
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const settings = vscode.workspace.getConfiguration('localalot.ghost.capabilities.limits');
        const previousWindow = settings.inspect<number>('max_context_window_tokens')?.globalValue;
        const previousOutput = settings.inspect<number>('max_output_tokens')?.globalValue;
        const extension = vscode.extensions.getExtension('mumingluan.localalot');
        assert.ok(extension);
        const native = require('../../../dist/native-core.js') as {
            createLocalGhostProvider(context: unknown, options: () => unknown): {
                provider: { provideInlineCompletionItems(...args: unknown[]): Promise<unknown> };
                dispose(): void;
            };
        };
        const token = new vscode.CancellationTokenSource();
        try {
            await settings.update('max_output_tokens', 200, vscode.ConfigurationTarget.Global);
            const content = Array.from({ length: 800 }, (_, i) =>
                `const uniqueLine_${i} = "value_${i}_abcdefghijklmnopqrstuvwxyz";`).join('\n');
            for (const window of [1024, 4096]) {
                await settings.update('max_context_window_tokens', window, vscode.ConfigurationTarget.Global);
                const subscriptions: vscode.Disposable[] = [];
                const instance = native.createLocalGhostProvider({
                    extension, extensionUri: extension.extensionUri, extensionPath: extension.extensionPath,
                    extensionMode: vscode.ExtensionMode.Test, subscriptions,
                    globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
                }, () => ({
                    baseUrl: `http://127.0.0.1:${address.port}`, apiKey: '',
                    model: 'local-model', endpoint: 'fim/completions',
                    maxOutputTokens: 200, promptTemplate: '', stops: [], contextPlacement: 'prefix',
                }));
                try {
                    const doc = await vscode.workspace.openTextDocument({ language: 'javascript', content: `${content}\n// window ${window}\n` });
                    await instance.provider.provideInlineCompletionItems(
                        doc, new vscode.Position(doc.lineCount - 1, 0),
                        { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, requestUuid: `native-window-${window}` }, token.token,
                    );
                    assert.strictEqual(prompts.length, window === 1024 ? 1 : 2,
                        `original Ghost did not request the ${window}-token prompt`);
                } finally {
                    instance.dispose();
                    vscode.Disposable.from(...subscriptions).dispose();
                }
            }
            assert.ok(prompts[1].length > prompts[0].length * 1.5,
                `Ghost ignored the context window: small=${prompts[0].length}, large=${prompts[1].length}`);
        } finally {
            token.dispose();
            await settings.update('max_context_window_tokens', previousWindow, vscode.ConfigurationTarget.Global);
            await settings.update('max_output_tokens', previousOutput, vscode.ConfigurationTarget.Global);
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    test('is the active Ghost provider in Localalot', async () => {
        const extension = vscode.extensions.getExtension('mumingluan.localalot');
        assert.ok(extension);
        const api = await extension.activate() as { ghostCore?: string; nesCore?: string } | undefined;
        assert.strictEqual(api?.ghostCore, 'native');
        assert.strictEqual(api?.nesCore, 'native');
    });

    test('constructs the original inline provider without chat contributions', () => {
        const native = require('../../../dist/native-core.js') as {
            createLocalGhostProvider(context: unknown): { provider: unknown; dispose(): void };
        };
        const extension = vscode.extensions.getExtension('mumingluan.localalot');
        assert.ok(extension);
        const context = {
            extension,
            extensionUri: extension.extensionUri,
            extensionPath: extension.extensionPath,
            extensionMode: vscode.ExtensionMode.Test,
            subscriptions: [] as vscode.Disposable[],
            globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
        };
        const instance = native.createLocalGhostProvider(context);
        try {
            assert.strictEqual(typeof (instance.provider as { provideInlineCompletionItems?: unknown }).provideInlineCompletionItems, 'function');
        } finally {
            instance.dispose();
            vscode.Disposable.from(...context.subscriptions).dispose();
        }
    });

    test('original Ghost honors the local IntelliSense preview setting and its dynamic default', async () => {
        const native = require('../../../dist/native-core.js') as {
            localRespectSelectedCompletionInfo(defaultValue: boolean): boolean;
            createLocalGhostProvider(context: unknown): {
                provider: vscode.InlineCompletionItemProvider & {
                    ghostTextProvider: { provideInlineCompletionItems(...args: unknown[]): Promise<unknown> };
                };
                dispose(): void;
            };
        };
        const extension = vscode.extensions.getExtension('mumingluan.localalot');
        assert.ok(extension);
        const config = vscode.workspace.getConfiguration('localalot');
        const previous = config.inspect<boolean>('respectSelectedCompletionInfo')?.globalValue;
        const subscriptions: vscode.Disposable[] = [];
        const instance = native.createLocalGhostProvider({
            extension, extensionUri: extension.extensionUri, extensionPath: extension.extensionPath,
            extensionMode: vscode.ExtensionMode.Test, subscriptions,
            globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
        });
        const token = new vscode.CancellationTokenSource();
        const selectedCompletionInfo: vscode.SelectedCompletionInfo = {
            range: new vscode.Range(0, 0, 0, 6), text: 'helper',
        };
        const seen: Array<vscode.SelectedCompletionInfo | undefined> = [];
        instance.provider.ghostTextProvider.provideInlineCompletionItems = async (...args: unknown[]) => {
            seen.push((args[2] as vscode.InlineCompletionContext).selectedCompletionInfo);
            return undefined;
        };
        try {
            await config.update('respectSelectedCompletionInfo', undefined, vscode.ConfigurationTarget.Global);
            assert.strictEqual(native.localRespectSelectedCompletionInfo(true), true);
            assert.strictEqual(native.localRespectSelectedCompletionInfo(false), false);
            const document = await vscode.workspace.openTextDocument({ language: 'javascript', content: 'helper' });
            const provide = () => instance.provider.provideInlineCompletionItems(
                document, new vscode.Position(0, 6), {
                    triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo,
                    requestUuid: `native-intellisense-${seen.length}`,
                } as vscode.InlineCompletionContext, token.token,
            );
            await config.update('respectSelectedCompletionInfo', false, vscode.ConfigurationTarget.Global);
            await provide();
            assert.strictEqual(seen.at(-1), undefined);
            await config.update('respectSelectedCompletionInfo', true, vscode.ConfigurationTarget.Global);
            await provide();
            assert.strictEqual(seen.at(-1), selectedCompletionInfo);
        } finally {
            token.dispose();
            instance.dispose();
            vscode.Disposable.from(...subscriptions).dispose();
            await config.update('respectSelectedCompletionInfo', previous, vscode.ConfigurationTarget.Global);
        }
    });

    test('adds original SCM guidance to commit-message Ghost requests', async function () {
        this.timeout(10000);
        let posted: Record<string, unknown> | undefined;
        const server = http.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(chunk));
            request.on('end', () => {
                posted = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end('data: {"choices":[{"index":0,"text":"Add feature","finish_reason":"stop"}]}\n\n');
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const native = require('../../../dist/native-core.js') as {
            createLocalGhostProvider(context: unknown, options: () => unknown): {
                provider: { provideInlineCompletionItems(...args: unknown[]): Promise<unknown> };
                getLastRequestLog(): unknown;
                dispose(): void;
            };
        };
        const extension = vscode.extensions.getExtension('mumingluan.localalot');
        assert.ok(extension);
        const context = {
            extension, extensionUri: extension.extensionUri, extensionPath: extension.extensionPath,
            extensionMode: vscode.ExtensionMode.Test, subscriptions: [] as vscode.Disposable[],
            globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
        };
        const content = vscode.workspace.registerTextDocumentContentProvider('vscode-scm', {
            provideTextDocumentContent: () => 'Add handling for config ',
        });
        const instance = native.createLocalGhostProvider(context, () => ({
            baseUrl: `http://127.0.0.1:${address.port}`,
            apiKey: '', model: 'local-model', endpoint: 'completions',
            maxOutputTokens: 128, promptTemplate: '{prefix}', stops: [],
        }));
        const token = new vscode.CancellationTokenSource();
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse('vscode-scm:/commit-message'));
            const result = await instance.provider.provideInlineCompletionItems(
                doc, new vscode.Position(0, doc.lineAt(0).text.length),
                { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, requestUuid: 'scm-context-test' }, token.token,
            );
            assert.ok(posted, `Ghost did not request a commit-message completion: items=${JSON.stringify(result).slice(0, 200)}, log=${String(instance.getLastRequestLog()).slice(-1000)}`);
            assert.match(String(posted.prompt), /This is a git commit message input field/);
        } finally {
            token.dispose();
            instance.dispose();
            content.dispose();
            vscode.Disposable.from(...context.subscriptions).dispose();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    test('includes staged Git changes in original commit-message Ghost context', async function () {
        this.timeout(15000);
        const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'localalot-scm-'));
        let server: http.Server | undefined;
        let content: vscode.Disposable | undefined;
        let instance: { provider: { provideInlineCompletionItems(...args: unknown[]): Promise<unknown> }; dispose(): void } | undefined;
        const token = new vscode.CancellationTokenSource();
        const contextSubscriptions: vscode.Disposable[] = [];
        try {
            await execFileAsync('git', ['init', '-q'], { cwd: repoDir });
            const sourceFile = path.join(repoDir, 'message-context.ts');
            await fs.writeFile(sourceFile, 'export const value = 1;\n');
            await execFileAsync('git', ['add', 'message-context.ts'], { cwd: repoDir });
            await execFileAsync('git', ['-c', 'user.name=Localalot Test', '-c', 'user.email=localalot@example.test', 'commit', '-qm', 'Initial commit'], { cwd: repoDir });
            await fs.writeFile(sourceFile, 'export const value = 42;\n');
            await execFileAsync('git', ['add', 'message-context.ts'], { cwd: repoDir });

            const gitExtension = vscode.extensions.getExtension('vscode.git');
            assert.ok(gitExtension, 'built-in Git extension is unavailable');
            const git = await gitExtension.activate() as { getAPI(version: 1): {
                openRepository(uri: vscode.Uri): Promise<{ state: { indexChanges: unknown[] }; status(): Promise<void> } | null>;
            } };
            const repository = await git.getAPI(1).openRepository(vscode.Uri.file(repoDir));
            assert.ok(repository, 'built-in Git extension did not open the temporary repository');
            await repository.status();
            assert.ok(repository.state.indexChanges.length > 0, 'Git did not detect the staged edit');

            let posted: Record<string, unknown> | undefined;
            server = http.createServer((request, response) => {
                const chunks: Buffer[] = [];
                request.on('data', chunk => chunks.push(chunk));
                request.on('end', () => {
                    posted = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
                    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    response.end('data: {"choices":[{"index":0,"text":"Update value","finish_reason":"stop"}]}\n\n');
                });
            });
            await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
            const address = server.address();
            assert.ok(address && typeof address !== 'string');
            const native = require('../../../dist/native-core.js') as {
                createLocalGhostProvider(context: unknown, options: () => unknown): typeof instance;
            };
            const extension = vscode.extensions.getExtension('mumingluan.localalot');
            assert.ok(extension);
            content = vscode.workspace.registerTextDocumentContentProvider('vscode-scm', {
                provideTextDocumentContent: () => 'Update staged value ',
            });
            instance = native.createLocalGhostProvider({
                extension, extensionUri: extension.extensionUri, extensionPath: extension.extensionPath,
                extensionMode: vscode.ExtensionMode.Test, subscriptions: contextSubscriptions,
                globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
            }, () => ({
                baseUrl: `http://127.0.0.1:${address.port}`,
                apiKey: '', model: 'local-model', endpoint: 'completions',
                maxOutputTokens: 128, promptTemplate: '{prefix}', stops: [],
            }));
            assert.ok(instance);
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse('vscode-scm:/staged-commit-message'));
            await instance.provider.provideInlineCompletionItems(
                doc, new vscode.Position(0, doc.lineAt(0).text.length),
                { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, requestUuid: 'scm-staged-diff-test' }, token.token,
            );
            assert.ok(posted, 'Ghost did not send a commit-message request');
            assert.match(String(posted.prompt), /\+export const value = 42;/);
        } finally {
            token.dispose();
            instance?.dispose();
            content?.dispose();
            vscode.Disposable.from(...contextSubscriptions).dispose();
            if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
            await fs.rm(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    });

    test('offers a YAML completion through the original Ghost provider', async () => {
        let posted: Record<string, unknown> | undefined;
        const server = http.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(chunk));
            request.on('end', () => {
                posted = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end(`data: ${JSON.stringify({ choices: [{ index: 0, text: '\n    image: nginx', finish_reason: 'stop' }] })}\n\n`);
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const native = require('../../../dist/native-core.js') as {
            createLocalGhostProvider(context: unknown, options: () => unknown): {
                provider: {
                    provideInlineCompletionItems(...args: unknown[]): Promise<{ items: Array<{ insertText: string }> } | undefined>;
                };
                ready: Promise<void>;
                getLastRequestLog(): unknown;
                dispose(): void;
            };
        };
        const extension = vscode.extensions.getExtension('mumingluan.localalot');
        assert.ok(extension);
        const context = {
            extension,
            extensionUri: extension.extensionUri,
            extensionPath: extension.extensionPath,
            extensionMode: vscode.ExtensionMode.Test,
            subscriptions: [] as vscode.Disposable[],
            globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
        };
        const instance = native.createLocalGhostProvider(context, () => ({
            baseUrl: `http://127.0.0.1:${address.port}`,
            apiKey: '', model: 'local-model', endpoint: 'fim/completions',
            maxOutputTokens: 128, promptTemplate: '', stops: [],
        }));
        const token = new vscode.CancellationTokenSource();
        try {
            await instance.ready;
            const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'services:\n  web:' });
            const result = await instance.provider.provideInlineCompletionItems(
                doc, new vscode.Position(1, 6),
                { triggerKind: vscode.InlineCompletionTriggerKind.Automatic, requestUuid: 'native-yaml-test' }, token.token,
            );
            const error = String(instance.getLastRequestLog()).match(/## Error[^]*?```\n([^\n]+)/)?.[1];
            assert.ok(result?.items.length, `original provider returned no YAML completion; request=${JSON.stringify(posted)}; error=${error}`);
            assert.ok(result.items[0].insertText.includes('image: nginx'));
            assert.strictEqual(posted?.model, 'local-model');
            assert.ok(!Array.isArray(posted?.stop) || !posted.stop.includes('\n'), `YAML mapping request stopped at newline: ${JSON.stringify(posted)}`);
            assert.ok(typeof posted?.max_tokens === 'number' && posted.max_tokens > 32, `YAML mapping token budget is too small: ${JSON.stringify(posted)}`);

            const localConfig = vscode.workspace.getConfiguration('localalot');
            const previousEnable = localConfig.inspect<Record<string, boolean>>('enable')?.globalValue;
            try {
                await localConfig.update('enable', { '*': true, yaml: false }, vscode.ConfigurationTarget.Global);
                const disabled = await instance.provider.provideInlineCompletionItems(
                    doc, new vscode.Position(1, 6),
                    { triggerKind: vscode.InlineCompletionTriggerKind.Automatic, requestUuid: 'native-yaml-disabled-test' }, token.token,
                );
                assert.ok(!disabled || disabled.items.length === 0, 'Localalot language setting did not disable the original provider');
            } finally {
                await localConfig.update('enable', previousEnable, vscode.ConfigurationTarget.Global);
            }
        } finally {
            token.dispose();
            instance.dispose();
            vscode.Disposable.from(...context.subscriptions).dispose();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    test('offers a YAML ghost suggestion through the local chat endpoint', async function () {
        this.timeout(10000);
        let posted: Record<string, unknown> | undefined;
        const server = http.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(chunk));
            request.on('end', () => {
                posted = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end('data: {"choices":[{"index":0,"delta":{"content":"\\n    image: nginx"},"finish_reason":"stop"}]}\n\n');
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const extension = vscode.extensions.getExtension('mumingluan.localalot');
        assert.ok(extension);
        const subscriptions: vscode.Disposable[] = [];
        const native = require('../../../dist/native-core.js') as {
            createLocalGhostProvider(context: unknown, options: () => unknown): {
                provider: { provideInlineCompletionItems(...args: unknown[]): Promise<{ items: Array<{ insertText: string }> } | undefined> };
                ready: Promise<void>; getLastRequestLog(): unknown; dispose(): void;
            };
        };
        const instance = native.createLocalGhostProvider({
            extension, extensionUri: extension.extensionUri, extensionPath: extension.extensionPath,
            extensionMode: vscode.ExtensionMode.Test, subscriptions,
            globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
        }, () => ({
            baseUrl: `http://127.0.0.1:${address.port}`,
            apiKey: '', model: 'local-chat-model', endpoint: 'chat/completions',
            maxOutputTokens: 128, promptTemplate: '', stops: [], contextPlacement: 'prefix',
        }));
        const token = new vscode.CancellationTokenSource();
        try {
            await instance.ready;
            const document = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'services:\n  web:' });
            const result = await instance.provider.provideInlineCompletionItems(
                document, new vscode.Position(1, 6),
                { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, requestUuid: 'native-yaml-chat-test' }, token.token,
            );
            assert.ok(result?.items.length,
                `original Ghost returned no chat completion: body=${JSON.stringify(posted)}; log=${String(instance.getLastRequestLog()).slice(-900)}`);
            assert.ok(result.items[0].insertText.includes('image: nginx'));
            const messages = posted?.messages as Array<{ content: string }> | undefined;
            assert.ok(messages?.[1].content.includes('<CODE_BEFORE>services:\n  web:</CODE_BEFORE>'));
            assert.ok(!Array.isArray(posted?.stop) || !posted.stop.includes('\n'));
        } finally {
            token.dispose();
            instance.dispose();
            vscode.Disposable.from(...subscriptions).dispose();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    test('includes language-server definitions in the original Ghost request', async function () {
        this.timeout(10000);
        let posted: Record<string, unknown> | undefined;
        const server = http.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(chunk));
            request.on('end', () => {
                posted = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end(`data: ${JSON.stringify({ choices: [{ index: 0, text: '();', finish_reason: 'stop' }] })}\n\n`);
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const extension = vscode.extensions.getExtension('mumingluan.localalot');
        assert.ok(extension);
        const subscriptions: vscode.Disposable[] = [];
        const native = require('../../../dist/native-core.js') as {
            createLocalGhostProvider(context: unknown, options: () => unknown): {
                provider: { provideInlineCompletionItems(...args: unknown[]): Promise<unknown> };
                ready: Promise<void>;
                getLastRequestLog(): unknown; dispose(): void;
            };
        };
        const instance = native.createLocalGhostProvider({
            extension, extensionUri: extension.extensionUri, extensionPath: extension.extensionPath,
            extensionMode: vscode.ExtensionMode.Test, subscriptions,
            globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
        }, () => ({
            baseUrl: `http://127.0.0.1:${address.port}`,
            apiKey: '', model: 'local-model', endpoint: 'fim/completions',
            maxOutputTokens: 128, promptTemplate: '', stops: [], contextPlacement: 'prefix',
        }));
        const token = new vscode.CancellationTokenSource();
        try {
            await instance.ready;
            const definition = await vscode.workspace.openTextDocument({
                language: 'javascript', content: 'function GHOST_SEMANTIC_MARKER() { return 42; }',
            });
            let sameFileDefinition: vscode.Uri | undefined;
            let crossFileDefinition = definition.uri;
            subscriptions.push(vscode.languages.registerDefinitionProvider({ language: 'javascript' }, {
                provideDefinition: document => new vscode.Location(
                    sameFileDefinition?.toString() === document.uri.toString() ? document.uri : crossFileDefinition,
                    new vscode.Range(0, 0, 0, 42),
                ),
            }));
            const doc = await vscode.workspace.openTextDocument({ language: 'javascript', content: 'const output = helper' });
            const result = await instance.provider.provideInlineCompletionItems(
                doc, new vscode.Position(0, 21),
                { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, requestUuid: 'native-ghost-semantic-test' }, token.token,
            );
            const requestBody = JSON.stringify(posted);
            assert.ok(requestBody?.includes('GHOST_SEMANTIC_MARKER'),
                `original Ghost request omitted language-server definition: ${requestBody?.slice(0, 1200)}; result=${JSON.stringify(result)}; log=${String(instance.getLastRequestLog()).slice(-1000)}`);
            const excludedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'localalot-excluded-context-'));
            const excludedFile = path.join(excludedDirectory, 'excluded-definition.js');
            const localConfig = vscode.workspace.getConfiguration('localalot');
            const previousExclusions = localConfig.inspect<string[]>('exclude')?.globalValue;
            try {
                await fs.writeFile(excludedFile, 'function EXCLUDED_SEMANTIC_MARKER() { return 7; }');
                const excludedDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(excludedFile));
                crossFileDefinition = excludedDoc.uri;
                await localConfig.update('exclude', ['**/excluded-definition.js'], vscode.ConfigurationTarget.Global);
                posted = undefined;
                const excludedSource = await vscode.workspace.openTextDocument({
                    language: 'javascript', content: 'const excludedOutput = helper',
                });
                await instance.provider.provideInlineCompletionItems(
                    excludedSource, new vscode.Position(0, 29),
                    { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, requestUuid: 'native-ghost-excluded-definition-test' }, token.token,
                );
                assert.ok(posted, 'original Ghost did not make a request with an excluded definition');
                assert.ok(!JSON.stringify(posted).includes('EXCLUDED_SEMANTIC_MARKER'),
                    `excluded definition leaked into Ghost prompt: ${JSON.stringify(posted).slice(0, 1200)}`);
            } finally {
                crossFileDefinition = definition.uri;
                await localConfig.update('exclude', previousExclusions, vscode.ConfigurationTarget.Global);
                await fs.unlink(excludedFile).catch(() => undefined);
                await fs.rmdir(excludedDirectory);
            }
            const sameFile = await vscode.workspace.openTextDocument({
                language: 'javascript',
                content: [
                    'function GHOST_DEEP_DEFINITION() { return 42; }',
                    ...Array.from({ length: 600 }, (_, index) => `// filler ${index}: ${'x'.repeat(90)}`),
                    'const output = helper',
                ].join('\n'),
            });
            sameFileDefinition = sameFile.uri;
            posted = undefined;
            await instance.provider.provideInlineCompletionItems(
                sameFile, new vscode.Position(601, 21),
                { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, requestUuid: 'native-ghost-deep-definition-test' }, token.token,
            );
            assert.ok(JSON.stringify(posted).includes('GHOST_DEEP_DEFINITION'),
                `original Ghost request omitted a distant same-file definition: ${JSON.stringify(posted).slice(0, 1200)}`);
            const ghostConfig = vscode.workspace.getConfiguration('localalot.ghost');
            const previousSemantic = ghostConfig.inspect<boolean>('semanticContextEnabled')?.globalValue;
            try {
                await ghostConfig.update('semanticContextEnabled', false, vscode.ConfigurationTarget.Global);
                posted = undefined;
                const secondSubscriptions: vscode.Disposable[] = [];
                const second = native.createLocalGhostProvider({
                    extension, extensionUri: extension.extensionUri, extensionPath: extension.extensionPath,
                    extensionMode: vscode.ExtensionMode.Test, subscriptions: secondSubscriptions,
                    globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
                }, () => ({
                    baseUrl: `http://127.0.0.1:${address.port}`,
                    apiKey: '', model: 'local-model', endpoint: 'fim/completions',
                    maxOutputTokens: 128, promptTemplate: '', stops: [], contextPlacement: 'prefix',
                }));
                try {
                    await second.ready;
                    const disabledDoc = await vscode.workspace.openTextDocument({
                        language: 'javascript', content: 'const alternate = helper',
                    });
                    await second.provider.provideInlineCompletionItems(
                        disabledDoc, new vscode.Position(0, 24),
                        { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, requestUuid: 'native-ghost-semantic-disabled-test' }, token.token,
                    );
                    assert.ok(posted, 'original Ghost did not make a request with semantic context disabled');
                    assert.ok(!JSON.stringify(posted).includes('GHOST_SEMANTIC_MARKER'),
                        `disabling semantic context still sent the definition: ${JSON.stringify(posted).slice(0, 1200)}`);
                } finally {
                    second.dispose();
                    vscode.Disposable.from(...secondSubscriptions).dispose();
                }
            } finally {
                await ghostConfig.update('semanticContextEnabled', previousSemantic, vscode.ConfigurationTarget.Global);
            }
        } finally {
            token.dispose();
            instance.dispose();
            vscode.Disposable.from(...subscriptions).dispose();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });
});

suite('Original Copilot NES bootstrap', () => {
    test('uses the original unified patch strategy for an inline completion', async function () {
        this.timeout(12000);
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'localalot-unified-'));
        const file = path.join(directory, 'sample.js');
        await fs.writeFile(file, 'const value = 1;');
        let patchPath = '';
        let posted: Record<string, unknown> | undefined;
        const server = http.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(chunk));
            request.on('end', () => {
                posted = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                const patch = `${patchPath}:0\n-const value = 2;\n+const value = 2; // continued`;
                response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: patch }, finish_reason: 'stop' }] })}\n\n`);
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const config = vscode.workspace.getConfiguration('localalot.nes');
        const previous = {
            strategy: config.inspect<string>('promptingStrategy')?.globalValue,
            baseUrl: config.inspect<string>('baseUrl')?.globalValue,
            endpoint: config.inspect<string>('endpoint')?.globalValue,
            model: config.inspect<string>('model')?.globalValue,
        };
        const subscriptions: vscode.Disposable[] = [];
        const token = new vscode.CancellationTokenSource();
        let instance: { provider: { model: { workspace: {
            getDocumentByTextDocument(document: vscode.TextDocument): unknown;
        } }; provideInlineCompletionItems(...args: unknown[]): Promise<{
            items: Array<{ insertText: string; isInlineCompletion?: boolean; isInlineEdit?: boolean }>;
        } | undefined> }; handlesCompletions(): boolean; getLastRequestLog(): unknown; dispose(): void } | undefined;
        try {
            await config.update('promptingStrategy', 'patchBased02Unified', vscode.ConfigurationTarget.Global);
            await config.update('baseUrl', `http://127.0.0.1:${address.port}`, vscode.ConfigurationTarget.Global);
            await config.update('endpoint', 'chat/completions', vscode.ConfigurationTarget.Global);
            await config.update('model', 'local-unified', vscode.ConfigurationTarget.Global);
            const extension = vscode.extensions.getExtension('mumingluan.localalot');
            assert.ok(extension);
            const native = require('../../../dist/native-core.js') as {
                createLocalNesProvider(context: unknown, cursorEnabled: () => boolean): typeof instance;
            };
            instance = native.createLocalNesProvider({
                extension, extensionUri: extension.extensionUri, extensionPath: extension.extensionPath,
                extensionMode: vscode.ExtensionMode.Test, subscriptions,
                globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
            }, () => false);
            assert.ok(instance);
            assert.strictEqual(instance.handlesCompletions(), true);
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            patchPath = document.uri.path;
            const editor = await vscode.window.showTextDocument(document);
            const trackingDeadline = Date.now() + 3000;
            while (!instance.provider.model.workspace.getDocumentByTextDocument(document)
                && Date.now() < trackingDeadline) {
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            assert.ok(instance.provider.model.workspace.getDocumentByTextDocument(document),
                'original NES workspace did not finish tracking the opened file');
            editor.selection = new vscode.Selection(0, 16, 0, 16);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, new vscode.Range(0, 14, 0, 15), '2');
            assert.ok(await vscode.workspace.applyEdit(edit));
            const result = await instance.provider.provideInlineCompletionItems(
                document, new vscode.Position(0, 16),
                { triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
                    requestUuid: 'native-unified-patch-test', requestIssuedDateTime: Date.now() }, token.token,
            );
            assert.ok(result?.items.length,
                `original unified strategy returned no completion; posted=${JSON.stringify(posted)}; log=${String(instance.getLastRequestLog()).slice(-900)}`);
            assert.strictEqual(result.items[0].isInlineCompletion, true);
            assert.strictEqual(result.items[0].isInlineEdit, false);
            assert.ok(result.items[0].insertText.includes('// continued'));
        } finally {
            instance?.dispose();
            token.dispose();
            vscode.Disposable.from(...subscriptions).dispose();
            await config.update('promptingStrategy', previous.strategy, vscode.ConfigurationTarget.Global);
            await config.update('baseUrl', previous.baseUrl, vscode.ConfigurationTarget.Global);
            await config.update('endpoint', previous.endpoint, vscode.ConfigurationTarget.Global);
            await config.update('model', previous.model, vscode.ConfigurationTarget.Global);
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });

    test('passes original prompt strategy and lint settings to the NES model', async () => {
        const extension = vscode.extensions.getExtension('mumingluan.localalot');
        assert.ok(extension);
        const config = vscode.workspace.getConfiguration('localalot.nes');
        const previous = {
            strategy: config.inspect<string>('promptingStrategy')?.globalValue,
            tags: config.inspect<boolean>('includeTagsInCurrentFile')?.globalValue,
            postScript: config.inspect<boolean>('includePostScript')?.globalValue,
            lint: config.inspect<Record<string, unknown>>('lintOptions')?.globalValue,
        };
        const subscriptions: vscode.Disposable[] = [];
        let instance: { handlesCompletions(): boolean; provider: { _modelService: { selectedModelConfiguration(): {
            promptingStrategy: string; includeTagsInCurrentFile: boolean; includePostScript?: boolean;
            lintOptions?: { maxLints?: number }; supportsNextCursorLinePrediction?: boolean;
        } } }; dispose(): void } | undefined;
        try {
            await config.update('promptingStrategy', 'xtab275', vscode.ConfigurationTarget.Global);
            await config.update('includeTagsInCurrentFile', true, vscode.ConfigurationTarget.Global);
            await config.update('includePostScript', false, vscode.ConfigurationTarget.Global);
            await config.update('lintOptions', { maxLints: 2 }, vscode.ConfigurationTarget.Global);
            const native = require('../../../dist/native-core.js') as {
                createLocalNesProvider(context: unknown, cursorEnabled: () => boolean): typeof instance;
            };
            instance = native.createLocalNesProvider({
                extension, extensionUri: extension.extensionUri, extensionPath: extension.extensionPath,
                extensionMode: vscode.ExtensionMode.Test, subscriptions,
                globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
            }, () => true);
            assert.ok(instance);
            const normal = instance.provider._modelService.selectedModelConfiguration();
            assert.strictEqual(normal.promptingStrategy, 'xtab275');
            assert.strictEqual(normal.includeTagsInCurrentFile, true);
            assert.strictEqual(normal.includePostScript, false);
            assert.strictEqual(normal.lintOptions?.maxLints, 2);
            await config.update('promptingStrategy', 'patchBased02WithRecentLineNumbers', vscode.ConfigurationTarget.Global);
            const patch = instance.provider._modelService.selectedModelConfiguration();
            assert.strictEqual(patch.promptingStrategy, 'patchBased02WithRecentLineNumbers');
            assert.strictEqual(patch.includeTagsInCurrentFile, false,
                'the original strategy-specific configuration did not override generic tags');
            assert.strictEqual(patch.supportsNextCursorLinePrediction, false);
            instance.dispose();
            instance = undefined;
            await config.update('promptingStrategy', 'patchBased02Unified', vscode.ConfigurationTarget.Global);
            instance = native.createLocalNesProvider({
                extension, extensionUri: extension.extensionUri, extensionPath: extension.extensionPath,
                extensionMode: vscode.ExtensionMode.Test, subscriptions,
                globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
            }, () => true);
            assert.ok(instance);
            assert.strictEqual(instance.handlesCompletions(), true,
                'the original unified strategy did not take responsibility for Ghost completions');
        } finally {
            instance?.dispose();
            vscode.Disposable.from(...subscriptions).dispose();
            await config.update('promptingStrategy', previous.strategy, vscode.ConfigurationTarget.Global);
            await config.update('includeTagsInCurrentFile', previous.tags, vscode.ConfigurationTarget.Global);
            await config.update('includePostScript', previous.postScript, vscode.ConfigurationTarget.Global);
            await config.update('lintOptions', previous.lint, vscode.ConfigurationTarget.Global);
        }
    });

    test('feeds nearby VS Code diagnostics into the original NES context once', async function () {
        this.timeout(10000);
        const extension = vscode.extensions.getExtension('mumingluan.localalot');
        assert.ok(extension);
        const config = vscode.workspace.getConfiguration('localalot.nes');
        const previousContext = config.inspect<boolean>('diagnosticContextEnabled')?.globalValue;
        const previousLint = config.inspect<Record<string, unknown>>('lintOptions')?.globalValue;
        const subscriptions: vscode.Disposable[] = [];
        let instance: { getContextProviders(): Array<{ id: string; resolver: {
            resolveOnTimeout?(request: unknown): Array<{ value?: string }>;
        } }>; dispose(): void } | undefined;
        try {
            await config.update('diagnosticContextEnabled', true, vscode.ConfigurationTarget.Global);
            await config.update('lintOptions', {}, vscode.ConfigurationTarget.Global);
            const document = await vscode.workspace.openTextDocument({ language: 'javascript', content: 'const value = missing;\n' });
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(0, 14, 0, 21), 'Localalot unique context diagnostic', vscode.DiagnosticSeverity.Error,
            );
            const collection = vscode.languages.createDiagnosticCollection('localalot-nes-context-test');
            subscriptions.push(collection);
            collection.set(document.uri, [diagnostic]);
            const native = require('../../../dist/native-core.js') as {
                createLocalNesProvider(context: unknown, cursorEnabled: () => boolean): typeof instance;
            };
            const create = () => native.createLocalNesProvider({
                extension, extensionUri: extension.extensionUri, extensionPath: extension.extensionPath,
                extensionMode: vscode.ExtensionMode.Test, subscriptions,
                globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
            }, () => false);
            instance = create();
            assert.ok(instance);
            const provider = instance.getContextProviders().find(candidate => candidate.id === 'diagnostics-context-provider');
            assert.ok(provider?.resolver.resolveOnTimeout, 'Original diagnostics context provider was not registered');
            const items = provider.resolver.resolveOnTimeout({
                documentContext: { uri: document.uri.toString(), languageId: document.languageId,
                    position: new vscode.Position(0, 20) },
            });
            assert.ok(items.some(item => item.value?.includes('Localalot unique context diagnostic')),
                'Nearby error did not reach the original NES context');
            instance.dispose();
            instance = undefined;
            await config.update('lintOptions', { maxLints: 2 }, vscode.ConfigurationTarget.Global);
            instance = create();
            assert.ok(instance);
            assert.ok(!instance.getContextProviders().some(candidate => candidate.id === 'diagnostics-context-provider'),
                'Diagnostic provider duplicated configured lint prompt context');
        } finally {
            instance?.dispose();
            vscode.Disposable.from(...subscriptions).dispose();
            await config.update('diagnosticContextEnabled', previousContext, vscode.ConfigurationTarget.Global);
            await config.update('lintOptions', previousLint, vscode.ConfigurationTarget.Global);
        }
    });

    test('turns a VS Code import diagnostic into an original NES fix', async function () {
        this.timeout(10000);
        const extension = vscode.extensions.getExtension('mumingluan.localalot');
        assert.ok(extension);
        const config = vscode.workspace.getConfiguration('localalot.nes');
        const previous = config.inspect<boolean>('diagnosticFixesEnabled')?.globalValue;
        const subscriptions: vscode.Disposable[] = [];
        let instance: { provider: {
            provideInlineCompletionItems(...args: unknown[]): Promise<{ items: Array<{ info?: { source?: string } }> } | undefined>;
            model: {
                workspace: { getDocumentByTextDocument(document: vscode.TextDocument): { id: unknown } | undefined };
                diagnosticsBasedProvider?: { _diagnosticsCompletionHandler: {
                    getCurrentState(id: unknown): { item?: { type: string; toOffsetEdit(): unknown } };
                } };
            };
        }; dispose(): void } | undefined;
        try {
            await config.update('diagnosticFixesEnabled', true, vscode.ConfigurationTarget.Global);
            const document = await vscode.workspace.openTextDocument({ language: 'javascript', content: 'const result = Widg;' });
            const editor = await vscode.window.showTextDocument(document);
            editor.selection = new vscode.Selection(0, 19, 0, 19);
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(0, 15, 0, 21), "Cannot find name 'Widget'.", vscode.DiagnosticSeverity.Error,
            );
            diagnostic.source = 'ts';
            diagnostic.code = 2304;
            const collection = vscode.languages.createDiagnosticCollection('localalot-native-test');
            subscriptions.push(collection);
            subscriptions.push(vscode.languages.registerCodeActionsProvider({ language: 'javascript' }, {
                provideCodeActions: () => {
                    const action = new vscode.CodeAction('Add import from "./widget"', vscode.CodeActionKind.QuickFix);
                    action.diagnostics = [diagnostic];
                    action.edit = new vscode.WorkspaceEdit();
                    action.edit.insert(document.uri, new vscode.Position(0, 0), 'import { Widget } from "./widget";\n');
                    return [action];
                },
            }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));
            const native = require('../../../dist/native-core.js') as {
                createLocalNesProvider(context: unknown, cursorEnabled: () => boolean): typeof instance;
            };
            instance = native.createLocalNesProvider({
                extension, extensionUri: extension.extensionUri, extensionPath: extension.extensionPath,
                extensionMode: vscode.ExtensionMode.Test, subscriptions,
                globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
            }, () => false);
            assert.ok(instance);
            const deadline = Date.now() + 3000;
            while (!instance.provider.model.workspace.getDocumentByTextDocument(document) && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            assert.ok(instance.provider.model.workspace.getDocumentByTextDocument(document), 'original workspace did not track the test document');
            await new Promise(resolve => setTimeout(resolve, 100));
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, new vscode.Range(0, 15, 0, 19), 'Widget');
            assert.ok(await vscode.workspace.applyEdit(edit));
            editor.selection = new vscode.Selection(0, 21, 0, 21);
            collection.set(document.uri, [diagnostic]);
            const resultDeadline = Date.now() + 3000;
            let item: { type: string; toOffsetEdit(): unknown } | undefined;
            let lastState: unknown;
            while (Date.now() < resultDeadline) {
                const tracked = instance.provider.model.workspace.getDocumentByTextDocument(document);
                if (tracked) {
                    lastState = instance.provider.model.diagnosticsBasedProvider
                        ?._diagnosticsCompletionHandler.getCurrentState(tracked.id);
                    item = (lastState as { item?: { type: string; toOffsetEdit(): unknown } } | undefined)?.item;
                }
                if (item) break;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            assert.strictEqual(item?.type, 'import',
                `the original diagnostic processor did not produce an import fix: item=${item?.type}; state=${Object.keys(lastState ?? {})}`);
            assert.ok(item.toOffsetEdit());
            const token = new vscode.CancellationTokenSource();
            try {
                const result = await instance.provider.provideInlineCompletionItems(
                    document, new vscode.Position(0, 21),
                    { triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
                        requestUuid: 'native-diagnostic-fix-test', requestIssuedDateTime: Date.now() }, token.token,
                );
                assert.ok(result?.items.some(candidate => candidate.info?.source === 'diagnostics'),
                    'the original inline provider did not surface its diagnostic fix');
            } finally {
                token.dispose();
            }
        } finally {
            instance?.dispose();
            vscode.Disposable.from(...subscriptions).dispose();
            await config.update('diagnosticFixesEnabled', previous, vscode.ConfigurationTarget.Global);
        }
    });

    test('connects the original diagnostic fixes provider when enabled', async () => {
        const native = require('../../../dist/native-core.js') as {
            createLocalNesProvider(context: unknown, cursorEnabled: () => boolean): {
                provider: { model: { diagnosticsBasedProvider?: { ID: string } } };
                dispose(): void;
            };
        };
        const extension = vscode.extensions.getExtension('mumingluan.localalot');
        assert.ok(extension);
        const config = vscode.workspace.getConfiguration('localalot.nes');
        const previous = config.inspect<boolean>('diagnosticFixesEnabled')?.globalValue;
        const construct = () => {
            const subscriptions: vscode.Disposable[] = [];
            const instance = native.createLocalNesProvider({
                extension, extensionUri: extension.extensionUri, extensionPath: extension.extensionPath,
                extensionMode: vscode.ExtensionMode.Test, subscriptions,
                globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
            }, () => false);
            try {
                return instance.provider.model.diagnosticsBasedProvider?.ID;
            } finally {
                instance.dispose();
                vscode.Disposable.from(...subscriptions).dispose();
            }
        };
        try {
            await config.update('diagnosticFixesEnabled', true, vscode.ConfigurationTarget.Global);
            assert.strictEqual(construct(), 'DiagnosticsNextEditProvider');
            await config.update('diagnosticFixesEnabled', false, vscode.ConfigurationTarget.Global);
            assert.strictEqual(construct(), undefined);
        } finally {
            await config.update('diagnosticFixesEnabled', previous, vscode.ConfigurationTarget.Global);
        }
    });

    test('honors Localalot formatting-only edit setting in the original filter', async function () {
        this.timeout(15000);
        const server = http.createServer((request, response) => {
            request.resume();
            request.on('end', () => {
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'const  value = 2;' }, finish_reason: 'stop' }] })}\n\n`);
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const config = vscode.workspace.getConfiguration('localalot.nes');
        const previous = {
            baseUrl: config.inspect<string>('baseUrl')?.globalValue,
            model: config.inspect<string>('model')?.globalValue,
            endpoint: config.inspect<string>('endpoint')?.globalValue,
            whitespace: config.inspect<boolean>('allowWhitespaceOnlyChanges')?.globalLanguageValue,
        };
        const extension = vscode.extensions.getExtension('mumingluan.localalot');
        assert.ok(extension);
        const native = require('../../../dist/native-core.js') as {
            createLocalNesProvider(context: unknown, cursorEnabled: () => boolean): {
                provider: { provideInlineCompletionItems(...args: unknown[]): Promise<{ items: Array<{ insertText: string }> } | undefined> };
                dispose(): void;
            };
        };
        const run = async (enabled: boolean) => {
            await config.update('allowWhitespaceOnlyChanges', enabled, vscode.ConfigurationTarget.Global, true);
            const subscriptions: vscode.Disposable[] = [];
            const instance = native.createLocalNesProvider({
                extension, extensionUri: extension.extensionUri, extensionPath: extension.extensionPath,
                extensionMode: vscode.ExtensionMode.Test, subscriptions,
                globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
            }, () => false);
            const token = new vscode.CancellationTokenSource();
            try {
                const doc = await vscode.workspace.openTextDocument({ language: 'javascript', content: 'const value = 1;' });
                const editor = await vscode.window.showTextDocument(doc);
                editor.selection = new vscode.Selection(0, 16, 0, 16);
                const edit = new vscode.WorkspaceEdit();
                edit.replace(doc.uri, new vscode.Range(0, 14, 0, 15), '2');
                assert.ok(await vscode.workspace.applyEdit(edit));
                return await instance.provider.provideInlineCompletionItems(
                    doc, new vscode.Position(0, 16),
                    { triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
                        requestUuid: `native-nes-whitespace-${enabled}`, requestIssuedDateTime: Date.now() }, token.token,
                );
            } finally {
                token.dispose();
                instance.dispose();
                vscode.Disposable.from(...subscriptions).dispose();
            }
        };
        try {
            await config.update('baseUrl', `http://127.0.0.1:${address.port}`, vscode.ConfigurationTarget.Global);
            await config.update('model', 'local-nes', vscode.ConfigurationTarget.Global);
            await config.update('endpoint', 'chat/completions', vscode.ConfigurationTarget.Global);
            const rejected = await run(false);
            assert.ok(!rejected?.items.length, 'the original filter accepted a formatting-only edit while disabled');
            const accepted = await run(true);
            assert.ok(accepted?.items.some(item => item.insertText.includes('const  value = 2;')),
                'the original filter rejected a formatting-only edit while enabled');
        } finally {
            await config.update('allowWhitespaceOnlyChanges', previous.whitespace, vscode.ConfigurationTarget.Global, true);
            await config.update('baseUrl', previous.baseUrl, vscode.ConfigurationTarget.Global);
            await config.update('model', previous.model, vscode.ConfigurationTarget.Global);
            await config.update('endpoint', previous.endpoint, vscode.ConfigurationTarget.Global);
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    test('honors per-language import edits in the original NES filter', async function () {
        this.timeout(15000);
        const server = http.createServer((request, response) => {
            request.resume();
            request.on('end', () => {
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {
                    content: 'import { bar } from "pkg";\nconst value = 2;',
                }, finish_reason: 'stop' }] })}\n\n`);
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const config = vscode.workspace.getConfiguration('localalot.nes');
        const previous = {
            baseUrl: config.inspect<string>('baseUrl')?.globalValue,
            model: config.inspect<string>('model')?.globalValue,
            endpoint: config.inspect<string>('endpoint')?.globalValue,
            imports: config.inspect<boolean>('allowImportChanges')?.globalLanguageValue,
        };
        const extension = vscode.extensions.getExtension('mumingluan.localalot');
        assert.ok(extension);
        const native = require('../../../dist/native-core.js') as {
            createLocalNesProvider(context: unknown, cursorEnabled: () => boolean): {
                provider: { provideInlineCompletionItems(...args: unknown[]): Promise<{ items: Array<{ insertText: string }> } | undefined> };
                dispose(): void;
            };
        };
        const run = async (enabled: boolean) => {
            await config.update('allowImportChanges', enabled, vscode.ConfigurationTarget.Global, true);
            const subscriptions: vscode.Disposable[] = [];
            const instance = native.createLocalNesProvider({
                extension, extensionUri: extension.extensionUri, extensionPath: extension.extensionPath,
                extensionMode: vscode.ExtensionMode.Test, subscriptions,
                globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
            }, () => false);
            const token = new vscode.CancellationTokenSource();
            try {
                const doc = await vscode.workspace.openTextDocument({
                    language: 'javascript', content: 'import { foo } from "pkg";\nconst value = 1;',
                });
                const editor = await vscode.window.showTextDocument(doc);
                editor.selection = new vscode.Selection(1, 16, 1, 16);
                const edit = new vscode.WorkspaceEdit();
                edit.replace(doc.uri, new vscode.Range(1, 14, 1, 15), '2');
                assert.ok(await vscode.workspace.applyEdit(edit));
                return await instance.provider.provideInlineCompletionItems(
                    doc, new vscode.Position(1, 16),
                    { triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
                        requestUuid: `native-nes-import-${enabled}`, requestIssuedDateTime: Date.now() }, token.token,
                );
            } finally {
                token.dispose();
                instance.dispose();
                vscode.Disposable.from(...subscriptions).dispose();
            }
        };
        try {
            await config.update('baseUrl', `http://127.0.0.1:${address.port}`, vscode.ConfigurationTarget.Global);
            await config.update('model', 'local-nes', vscode.ConfigurationTarget.Global);
            await config.update('endpoint', 'chat/completions', vscode.ConfigurationTarget.Global);
            const rejected = await run(false);
            assert.ok(!rejected?.items.length, 'import edit bypassed the disabled language setting');
            const accepted = await run(true);
            assert.ok(accepted?.items.some(item => item.insertText.includes('bar')),
                'original NES filtered the import edit despite the enabled language setting');
        } finally {
            await config.update('allowImportChanges', previous.imports, vscode.ConfigurationTarget.Global, true);
            await config.update('baseUrl', previous.baseUrl, vscode.ConfigurationTarget.Global);
            await config.update('model', previous.model, vscode.ConfigurationTarget.Global);
            await config.update('endpoint', previous.endpoint, vscode.ConfigurationTarget.Global);
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    test('uses the original next-cursor predictor to edit a distant line', async function () {
        this.timeout(12000);
        const requests: Array<Record<string, unknown>> = [];
        const server = http.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(chunk));
            request.on('end', () => {
                const posted = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
                requests.push(posted);
                const messages = posted.messages as Array<{ role: string; content: string }>;
                const system = messages.find(message => message.role === 'system')?.content ?? '';
                const user = messages.find(message => message.role === 'user')?.content ?? '';
                const editWindow = /<\|code_to_edit\|>\n([\s\S]*?)<\|\/code_to_edit\|>/.exec(user)?.[1]
                    .replaceAll('<|cursor|>', '').trimEnd() ?? '';
                const answer = system.includes('predict the line number')
                    ? '25'
                    : editWindow.replace('const target = 0;', 'const target = 1;');
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: answer }, finish_reason: 'stop' }] })}\n\n`);
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const config = vscode.workspace.getConfiguration('localalot.nes');
        const previous = {
            baseUrl: config.inspect<string>('baseUrl')?.globalValue,
            model: config.inspect<string>('model')?.globalValue,
            endpoint: config.inspect<string>('endpoint')?.globalValue,
            cursorModel: config.inspect<string>('nextCursorPrediction.model')?.globalValue,
        };
        let instance: { provider: { provideInlineCompletionItems(...args: unknown[]): Promise<{ items: Array<{ insertText: string }> } | undefined> }; getLastRequestLog(): unknown; dispose(): void } | undefined;
        let bridge: ReturnType<typeof createStableAcceptanceBridge> | undefined;
        const token = new vscode.CancellationTokenSource();
        const subscriptions: vscode.Disposable[] = [];
        try {
            await config.update('baseUrl', `http://127.0.0.1:${address.port}`, vscode.ConfigurationTarget.Global);
            await config.update('model', 'local-nes', vscode.ConfigurationTarget.Global);
            await config.update('endpoint', 'chat/completions', vscode.ConfigurationTarget.Global);
            await config.update('nextCursorPrediction.model', 'local-cursor', vscode.ConfigurationTarget.Global);
            const extension = vscode.extensions.getExtension('mumingluan.localalot');
            assert.ok(extension);
            const native = require('../../../dist/native-core.js') as { createLocalNesProvider(context: unknown, cursorEnabled: () => boolean): typeof instance };
            instance = native.createLocalNesProvider({
                extension, extensionUri: extension.extensionUri, extensionPath: extension.extensionPath,
                extensionMode: vscode.ExtensionMode.Test, subscriptions,
                globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
            }, () => true);
            assert.ok(instance);
            const lines = Array.from({ length: 35 }, (_, index) => index === 0
                ? 'const first = 1;' : index === 25 ? 'const target = 0;' : `// filler ${index}`);
            const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: lines.join('\n') });
            const editor = await vscode.window.showTextDocument(doc);
            editor.selection = new vscode.Selection(0, 16, 0, 16);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(0, 14, 0, 15), '2');
            assert.ok(await vscode.workspace.applyEdit(edit));
            bridge = createStableAcceptanceBridge(instance.provider as unknown as vscode.InlineCompletionItemProvider, true);
            const result = await bridge.provider.provideInlineCompletionItems(
                doc, new vscode.Position(0, 16),
                { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined,
                    requestUuid: 'native-cursor-test', requestIssuedDateTime: Date.now() } as vscode.InlineCompletionContext, token.token,
            );
            assert.ok(requests.some(posted => JSON.stringify(posted.messages).includes('predict the line number')),
                `original cursor predictor was not called; requests=${JSON.stringify(requests).slice(0, 1200)}; log=${String(instance.getLastRequestLog()).slice(-1200)}`);
            const cursorRequest = requests.find(posted => JSON.stringify(posted.messages).includes('predict the line number'));
            assert.strictEqual(cursorRequest?.model, 'local-cursor');
            assert.ok(requests.some(posted => posted.model === 'local-nes'), 'the next edit should still use the NES model');
            assert.ok(result && !Array.isArray(result) && result.items.length === 0,
                'the distant original edit should use the stable action');
            const codeLenses = await bridge.codeLensProvider?.provideCodeLenses(doc, token.token);
            assert.ok(codeLenses && Array.isArray(codeLenses) && codeLenses[0]?.command);
            const action = codeLenses[0].command;
            assert.ok(action.title.includes('const target = 1;'));
            await vscode.commands.executeCommand(action.command, ...(action.arguments ?? []));
            assert.ok(doc.lineAt(25).text.includes('const target = 1;'));
        } finally {
            bridge?.dispose();
            instance?.dispose();
            token.dispose();
            vscode.Disposable.from(...subscriptions).dispose();
            await config.update('baseUrl', previous.baseUrl, vscode.ConfigurationTarget.Global);
            await config.update('model', previous.model, vscode.ConfigurationTarget.Global);
            await config.update('endpoint', previous.endpoint, vscode.ConfigurationTarget.Global);
            await config.update('nextCursorPrediction.model', previous.cursorModel, vscode.ConfigurationTarget.Global);
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    test('suggests a next edit through the original provider', async function () {
        this.timeout(10000);
        let posted: Record<string, unknown> | undefined;
        const server = http.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(chunk));
            request.on('end', () => {
                posted = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end('data: {"choices":[{"index":0,"delta":{"content":"const value = 3;"},"finish_reason":"stop"}]}\n\n');
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const config = vscode.workspace.getConfiguration('localalot.nes');
        const previous = {
            baseUrl: config.inspect<string>('baseUrl')?.globalValue,
            model: config.inspect<string>('model')?.globalValue,
            endpoint: config.inspect<string>('endpoint')?.globalValue,
            neighborFilesEnabled: config.inspect<boolean>('neighborFilesEnabled')?.globalValue,
            lintOptions: config.inspect<Record<string, unknown>>('lintOptions')?.globalValue,
            maxContextWindowTokens: config.inspect<number>('capabilities.limits.max_context_window_tokens')?.globalValue,
            maxOutputTokens: config.inspect<number>('capabilities.limits.max_output_tokens')?.globalValue,
        };
        let instance: { provider: { provideInlineCompletionItems(...args: unknown[]): Promise<{ items: Array<{ insertText: string }> } | undefined> }; getLastRequestLog(): unknown; dispose(): void } | undefined;
        const token = new vscode.CancellationTokenSource();
        try {
            await config.update('baseUrl', `http://127.0.0.1:${address.port}`, vscode.ConfigurationTarget.Global);
            await config.update('model', 'local-nes', vscode.ConfigurationTarget.Global);
            await config.update('endpoint', 'chat/completions', vscode.ConfigurationTarget.Global);
            await config.update('neighborFilesEnabled', false, vscode.ConfigurationTarget.Global);
            await config.update('lintOptions', { maxLints: 5 }, vscode.ConfigurationTarget.Global);
            await config.update('capabilities.limits.max_context_window_tokens', 4096, vscode.ConfigurationTarget.Global);
            await config.update('capabilities.limits.max_output_tokens', 9216, vscode.ConfigurationTarget.Global);
            const extension = vscode.extensions.getExtension('mumingluan.localalot');
            assert.ok(extension);
            const context = {
                extension,
                extensionUri: extension.extensionUri,
                extensionPath: extension.extensionPath,
                extensionMode: vscode.ExtensionMode.Test,
                subscriptions: [] as vscode.Disposable[],
                globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
            };
            const native = require('../../../dist/native-core.js') as { createLocalNesProvider(context: unknown): typeof instance };
            instance = native.createLocalNesProvider(context);
            assert.ok(instance);
            const definition = await vscode.workspace.openTextDocument({
                language: 'javascript', content: 'function localSemanticMarker() { return 42; }',
            });
            const definitionProvider = vscode.languages.registerDefinitionProvider({ language: 'javascript' }, {
                provideDefinition: () => new vscode.Location(definition.uri, new vscode.Range(0, 0, 0, 42)),
            });
            context.subscriptions.push(definitionProvider);
            const doc = await vscode.workspace.openTextDocument({ language: 'javascript', content: 'const value = 1;' });
            const editor = await vscode.window.showTextDocument(doc);
            editor.selection = new vscode.Selection(0, 16, 0, 16);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(0, 14, 0, 15), '2');
            assert.ok(await vscode.workspace.applyEdit(edit));
            const diagnostics = vscode.languages.createDiagnosticCollection('localalot-nes-lint-test');
            context.subscriptions.push(diagnostics);
            const lint = new vscode.Diagnostic(new vscode.Range(0, 14, 0, 15),
                'LOCALALOT_LINT_MARKER', vscode.DiagnosticSeverity.Error);
            lint.source = 'eslint';
            diagnostics.set(doc.uri, [lint]);
            const result = await instance.provider.provideInlineCompletionItems(
                doc, new vscode.Position(0, 16),
                { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, requestUuid: 'native-nes-test', requestIssuedDateTime: Date.now() }, token.token,
            );
            assert.ok(result?.items.length, `original NES returned no edit; posted=${JSON.stringify(posted)}; log=${String(instance.getLastRequestLog()).slice(0, 500)}`);
            assert.ok(result.items[0].insertText.includes('3'));
            assert.strictEqual(posted?.max_tokens, 1024, 'NES output should fit a 4096-token model window');
            assert.strictEqual(posted?.prediction, undefined, 'unsupported local endpoints must not receive prediction by default');
            assert.ok(JSON.stringify(posted?.messages).includes('localSemanticMarker'),
                `original NES prompt omitted language-server definition: ${JSON.stringify(posted?.messages).slice(0, 1000)}`);
            assert.ok(JSON.stringify(posted?.messages).includes('LOCALALOT_LINT_MARKER'),
                `original NES prompt omitted configured lint context: ${JSON.stringify(posted?.messages).slice(0, 1000)}`);
            vscode.Disposable.from(...context.subscriptions).dispose();
        } finally {
            instance?.dispose();
            token.dispose();
            await config.update('baseUrl', previous.baseUrl, vscode.ConfigurationTarget.Global);
            await config.update('model', previous.model, vscode.ConfigurationTarget.Global);
            await config.update('endpoint', previous.endpoint, vscode.ConfigurationTarget.Global);
            await config.update('neighborFilesEnabled', previous.neighborFilesEnabled, vscode.ConfigurationTarget.Global);
            await config.update('lintOptions', previous.lintOptions, vscode.ConfigurationTarget.Global);
            await config.update('capabilities.limits.max_context_window_tokens', previous.maxContextWindowTokens, vscode.ConfigurationTarget.Global);
            await config.update('capabilities.limits.max_output_tokens', previous.maxOutputTokens, vscode.ConfigurationTarget.Global);
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    test('streams original NES messages through the local endpoint', async () => {
        let posted: Record<string, unknown> | undefined;
        const server = http.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(chunk));
            request.on('end', () => {
                posted = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.write('data: {"choices":[{"index":0,"delta":{"content":"line one\\n"},"finish_reason":null}]}\n\n');
                response.end('data: {"choices":[{"index":0,"delta":{"content":"line two"},"finish_reason":"stop"}]}\n\n');
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const address = server.address();
            assert.ok(address && typeof address !== 'string');
            const native = require('../../../dist/native-core.js') as {
                LocalNesEndpoint: new (model: string | undefined, options: () => unknown) => {
                    modelMaxPromptTokens: number;
                    makeChatRequest2(options: unknown, token: vscode.CancellationToken): Promise<{ type: string; value?: string }>;
                };
            };
            const endpoint = new native.LocalNesEndpoint(undefined, () => ({
                model: 'local-nes', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: '', endpoint: 'chat/completions',
                family: 'standard', maxOutputTokens: 128, maxContextWindowTokens: 8192,
                promptTemplate: '{system}\n{user}', presencePenalty: 0, frequencyPenalty: 0,
                stream: true, thinking: false, reasoningEffort: 'none',
                sendPrediction: true,
            }));
            assert.strictEqual(endpoint.modelMaxPromptTokens, 8192 - 128);
            const deltas: string[] = [];
            const response = await endpoint.makeChatRequest2({
                debugName: 'nes-test',
                messages: [
                    { role: 0, content: [{ type: 1, text: 'Edit code.' }] },
                    { role: 1, content: [{ type: 1, text: 'Current file.' }] },
                ],
                finishedCb: (fullText: string, _index: number, delta: { text: string }) => {
                    deltas.push(`${fullText}|${delta.text}`);
                },
                location: 6,
                requestOptions: { max_tokens: 64, temperature: 0,
                    prediction: { type: 'content', content: 'original edit window' } },
            }, new vscode.CancellationTokenSource().token);
            assert.strictEqual(response.type, 'success');
            assert.strictEqual(response.value, 'line one\nline two');
            assert.deepStrictEqual(deltas, ['line one\n|line one\n', 'line one\nline two|line two']);
            assert.strictEqual(posted?.model, 'local-nes');
            assert.strictEqual(posted?.max_tokens, 64);
            assert.deepStrictEqual(posted?.prediction, { type: 'content', content: 'original edit window' });
            assert.deepStrictEqual(posted?.messages, [
                { role: 'system', content: 'Edit code.' }, { role: 'user', content: 'Current file.' },
            ]);
            const early = await endpoint.makeChatRequest2({
                debugName: 'nes-finish-offset-test',
                messages: [{ role: 1, content: [{ type: 1, text: 'Current file.' }] }],
                finishedCb: async () => 4,
                location: 6,
                requestOptions: { max_tokens: 64, temperature: 0 },
            }, new vscode.CancellationTokenSource().token);
            assert.strictEqual(early.type, 'success');
            assert.strictEqual(early.value, 'line', 'the original callback finish offset should trim the local stream');
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    test('constructs the original inline edit provider without chat contributions', () => {
        const native = require('../../../dist/native-core.js') as {
            createLocalNesProvider(context: unknown): { provider: unknown; dispose(): void };
        };
        const extension = vscode.extensions.getExtension('mumingluan.localalot');
        assert.ok(extension);
        const context = {
            extension,
            extensionUri: extension.extensionUri,
            extensionPath: extension.extensionPath,
            extensionMode: vscode.ExtensionMode.Test,
            subscriptions: [] as vscode.Disposable[],
            globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
        };
        const instance = native.createLocalNesProvider(context);
        try {
            assert.strictEqual(typeof (instance.provider as { provideInlineCompletionItems?: unknown }).provideInlineCompletionItems, 'function');
        } finally {
            instance.dispose();
            vscode.Disposable.from(...context.subscriptions).dispose();
        }
    });

    test('reads the next edit language override through the original NES configuration service', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'services:\n  web:' });
        const config = vscode.workspace.getConfiguration('localalot.nextEditSuggestions', {
            uri: document.uri, languageId: document.languageId,
        });
        const previous = config.inspect<boolean>('enabled')?.globalLanguageValue;
        const extension = vscode.extensions.getExtension('mumingluan.localalot');
        assert.ok(extension);
        const subscriptions: vscode.Disposable[] = [];
        let instance: { provider: {
            _configurationService: {
                getExperimentBasedConfig(key: unknown, experimentationService: unknown, scope: unknown): boolean;
            };
            _expService: unknown;
        }; dispose(): void } | undefined;
        try {
            const native = require('../../../dist/native-core.js') as { createLocalNesProvider(context: unknown): typeof instance };
            instance = native.createLocalNesProvider({
                extension, extensionUri: extension.extensionUri, extensionPath: extension.extensionPath,
                extensionMode: vscode.ExtensionMode.Test, subscriptions,
                globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
            });
            assert.ok(instance);
            const setting = {
                id: 'nextEditSuggestions.enabled',
                fullyQualifiedId: 'localalot.nextEditSuggestions.enabled',
                defaultValue: true,
                experimentName: undefined,
            };
            const originalSetting = () => instance!.provider._configurationService.getExperimentBasedConfig(
                setting, instance!.provider._expService, { languageId: document.languageId },
            );
            await config.update('enabled', false, vscode.ConfigurationTarget.Global, true);
            assert.strictEqual(originalSetting(), false);
            await config.update('enabled', true, vscode.ConfigurationTarget.Global, true);
            assert.strictEqual(originalSetting(), true);
        } finally {
            instance?.dispose();
            vscode.Disposable.from(...subscriptions).dispose();
            await config.update('enabled', previous, vscode.ConfigurationTarget.Global, true);
        }
    });

    test('reads Localalot eagerness through the original NES provider options', async () => {
        const config = vscode.workspace.getConfiguration('localalot.nextEditSuggestions');
        const previous = config.inspect<string>('eagerness')?.globalValue;
        const extension = vscode.extensions.getExtension('mumingluan.localalot');
        assert.ok(extension);
        const subscriptions: vscode.Disposable[] = [];
        let instance: { provider: { providerOptions?: Array<{ id: string; currentValueId: string }> }; dispose(): void } | undefined;
        try {
            await config.update('eagerness', 'high', vscode.ConfigurationTarget.Global);
            const native = require('../../../dist/native-core.js') as { createLocalNesProvider(context: unknown): typeof instance };
            instance = native.createLocalNesProvider({
                extension, extensionUri: extension.extensionUri, extensionPath: extension.extensionPath,
                extensionMode: vscode.ExtensionMode.Test, subscriptions,
                globalStorageUri: vscode.Uri.joinPath(extension.extensionUri, '.test-storage'),
            });
            assert.strictEqual(instance?.provider.providerOptions?.find(option => option.id === 'eagerness')?.currentValueId, 'high');
        } finally {
            instance?.dispose();
            vscode.Disposable.from(...subscriptions).dispose();
            await config.update('eagerness', previous, vscode.ConfigurationTarget.Global);
        }
    });
});
