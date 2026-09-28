import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function replaceOnce(source, from, to) {
    if (source.split(from).length !== 2) throw new Error(`Upstream service registration changed: ${from}`);
    return source.replace(from, to);
}

function replaceSection(source, start, end, replacement) {
    if (source.split(start).length !== 2 || source.split(end).length !== 2) {
        throw new Error(`Upstream NES bridge changed: ${start}`);
    }
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    if (to < 0) throw new Error(`Upstream NES bridge end changed: ${end}`);
    return source.slice(0, from) + replacement + source.slice(to);
}

await build({
    entryPoints: ['native/entry.ts'],
    outfile: 'dist/native-core.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['vscode'],
    plugins: [{
        name: 'bundle-jsonc-parser',
        setup(build) {
            build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
                path: path.resolve('node_modules/jsonc-parser/lib/esm/main.js'),
            }));
        },
    }, {
        name: 'omit-copilot-panel',
        setup(build) {
            build.onResolve({ filter: /copilotPanel\/common$/ }, () => ({ path: 'panel', namespace: 'localalot-omitted' }));
            build.onLoad({ filter: /.*/, namespace: 'localalot-omitted' }, () => ({
                contents: 'export const registerPanelSupport = () => ({ dispose() {} });',
                loader: 'js',
            }));
        },
    }, {
        name: 'local-model-services',
        setup(build) {
            build.onLoad({ filter: /extension[\\/]inlineEdits[\\/]vscode-node[\\/]unifiedCompletions\.ts$/ }, async args => {
                let source = await readFile(args.path, 'utf8');
                source = replaceOnce(source,
                    'DebugOwner, derived, IObservable',
                    'DebugOwner, constObservable, derived, IObservable');
                source = replaceOnce(source,
                    'const unificationState = unificationStateObservable(owner);',
                    'const unificationState = constObservable(undefined);');
                return { contents: source, loader: 'ts' };
            });
            build.onLoad({ filter: /completions-core[\\/]vscode-node[\\/]lib[\\/]src[\\/]prompt[\\/]similarFiles[\\/]neighborFiles\.ts$/ }, async args => {
                let source = await readFile(args.path, 'utf8');
                const relative = path.relative(path.dirname(args.path), path.resolve('native/filterIgnoredNeighbors.ts')).replaceAll('\\', '/');
                source = `import { filterIgnoredNeighbors } from '${relative.startsWith('.') ? relative : `./${relative}`}';\n` + source;
                // The standalone Ghost and NES providers own separate, restartable
                // service containers. OpenTabFiles has no state beyond its document
                // manager, so resolve it from the current container for each call.
                source = replaceOnce(source,
                    '\t\tif (NeighborSource.instance === undefined) {\n\t\t\tNeighborSource.instance = instantiationService.createInstance(OpenTabFiles);\n\t\t}',
                    '\t\tconst neighborSource = instantiationService.createInstance(OpenTabFiles);');
                source = replaceOnce(source,
                    '...(await NeighborSource.instance.getNeighborFiles(uri, fileType, NeighborSource.MAX_NEIGHBOR_FILES))',
                    '...(await neighborSource.getNeighborFiles(uri, fileType, NeighborSource.MAX_NEIGHBOR_FILES))');
                if (source.split('return result;').length !== 6) throw new Error('Upstream neighbor return paths changed');
                source = source.replaceAll('return result;', 'return await filterIgnoredNeighbors(accessor, result);');
                return { contents: source, loader: 'ts' };
            });
            build.onLoad({ filter: /completions-core[\\/]vscode-node[\\/]lib[\\/]src[\\/]prompt[\\/]similarFiles[\\/]relatedFiles\.ts$/ }, async args => {
                let source = await readFile(args.path, 'utf8');
                const relative = path.relative(path.dirname(args.path), path.resolve('native/relatedFilesCacheRevision.ts')).replaceAll('\\', '/');
                source = `import { currentRelatedFilesIgnoreRevision } from '${relative.startsWith('.') ? relative : `./${relative}`}';\n` + source;
                // The original module-level cache is shared by every standalone
                // Ghost/NES service container. Keep its 2-minute behavior, but
                // isolate providers and refresh after .copilotignore changes.
                source = replaceOnce(source,
                    'const lruCache: PromiseExpirationCacheMap<RelatedFiles> = new PromiseExpirationCacheMap(lruCacheSize);',
                    'const relatedFilesCaches = new WeakMap<ICompletionsRelatedFilesProviderService, PromiseExpirationCacheMap<RelatedFiles>>();\n'
                        + 'function cacheFor(provider: ICompletionsRelatedFilesProviderService): PromiseExpirationCacheMap<RelatedFiles> {\n'
                        + '\tlet cache = relatedFilesCaches.get(provider);\n'
                        + '\tif (!cache) { cache = new PromiseExpirationCacheMap<RelatedFiles>(lruCacheSize); relatedFilesCaches.set(provider, cache); }\n'
                        + '\treturn cache;\n'
                        + '}');
                source = replaceOnce(source,
                    'async function getRelatedFiles(\n\taccessor: ServicesAccessor,\n\tdocInfo: RelatedFilesDocumentInfo,\n\ttelemetryData: TelemetryWithExp,\n\tcancellationToken: ICancellationToken | undefined,\n\trelatedFilesProvider: ICompletionsRelatedFilesProviderService\n): Promise<RelatedFiles> {',
                    'async function getRelatedFiles(\n\taccessor: ServicesAccessor,\n\tdocInfo: RelatedFilesDocumentInfo,\n\ttelemetryData: TelemetryWithExp,\n\tcancellationToken: ICancellationToken | undefined,\n\trelatedFilesProvider: ICompletionsRelatedFilesProviderService,\n\tcacheKey: string = `${docInfo.uri}@${currentRelatedFilesIgnoreRevision()}`\n): Promise<RelatedFiles> {');
                source = replaceOnce(source,
                    'const retryCount = lruCache.bumpRetryCount(docInfo.uri);',
                    'const retryCount = cacheFor(relatedFilesProvider).bumpRetryCount(cacheKey);');
                source = replaceOnce(source,
                    'const id = `${docInfo.uri}`;\n\tif (lruCache.has(id)) {\n\t\treturn lruCache.get(id)!;\n\t}\n\tlet result = getRelatedFiles(accessor, docInfo, telemetryData, cancellationToken, relatedFilesProvider);',
                    'const id = `${docInfo.uri}@${currentRelatedFilesIgnoreRevision()}`;\n'
                        + '\tconst lruCache = cacheFor(relatedFilesProvider);\n'
                        + '\tif (lruCache.has(id)) {\n\t\treturn lruCache.get(id)!;\n\t}\n'
                        + '\tlet result = getRelatedFiles(accessor, docInfo, telemetryData, cancellationToken, relatedFilesProvider, id);');
                return { contents: source, loader: 'ts' };
            });
            build.onLoad({ filter: /extension[\\/]inlineEdits[\\/]vscode-node[\\/]inlineCompletionProvider\.ts$/ }, async args => {
                let source = await readFile(args.path, 'utf8');
                const relative = path.relative(path.dirname(args.path), path.resolve('native/vscodeCompatibility.ts')).replaceAll('\\', '/');
                source = `import { isMeteredConnectionSafe } from '${relative.startsWith('.') ? relative : `./${relative}`}';\n` + source;
                source = replaceOnce(source, 'env.isMeteredConnection', 'isMeteredConnectionSafe()');
                return { contents: source, loader: 'ts' };
            });
            build.onLoad({ filter: /extension[\\/]inlineEdits[\\/]node[\\/]nextEditProvider\.ts$/ }, async args => {
                let source = await readFile(args.path, 'utf8');
                source = replaceOnce(source,
                    "return Result.error(new NoNextEditReason.Unexpected(new Error('DocumentMissingInHistoryContext')));",
                    "return Result.error(new NoNextEditReason.GotCancelled('documentHistoryNotReady'));"
                );
                return { contents: source, loader: 'ts' };
            });
            build.onLoad({ filter: /extension[\\/]diagnosticsContext[\\/]vscode[\\/]diagnosticsContextProvider\.ts$/ }, async args => {
                let source = await readFile(args.path, 'utf8');
                const relative = path.relative(path.dirname(args.path), path.resolve('native/localNesSettings.ts')).replaceAll('\\', '/');
                source = `import { localNesDiagnosticContextEnabled } from '${relative.startsWith('.') ? relative : `./${relative}`}';\n` + source;
                source = replaceOnce(source,
                    'if (this._enableDiagnosticsContextProvider.read(reader)) {',
                    'if (localNesDiagnosticContextEnabled()) {');
                source = replaceOnce(source,
                    'const languageEnablement = this.experimentationService.getTreatmentVariable<boolean>(`config.github.copilot.chat.inlineEdits.diagnosticsContextProvider.${languageId}`);',
                    'const languageEnablement = localNesDiagnosticContextEnabled();');
                return { contents: source, loader: 'ts' };
            });
            build.onLoad({ filter: /extension[\\/]xtab[\\/]node[\\/]xtabProvider\.ts$/ }, async args => {
                let source = await readFile(args.path, 'utf8');
                const relative = path.relative(path.dirname(args.path), path.resolve('native/localNesEndpoint.ts')).replaceAll('\\', '/');
                const settingsRelative = path.relative(path.dirname(args.path), path.resolve('native/localNesSettings.ts')).replaceAll('\\', '/');
                const budgetRelative = path.relative(path.dirname(args.path), path.resolve('native/localNesTokenBudget.ts')).replaceAll('\\', '/');
                source = `import { LocalNesEndpoint } from '${relative.startsWith('.') ? relative : `./${relative}`}';\n`
                    + `import { localNesSemanticContextEnabled, localNesNeighborFilesEnabled, localNesContextBudgetMs, localNesAllowWhitespaceOnlyChanges, localNesImportChanges } from '${settingsRelative.startsWith('.') ? settingsRelative : `./${settingsRelative}`}';\n`
                    + `import { localNesGlobalBudget } from '${budgetRelative.startsWith('.') ? budgetRelative : `./${budgetRelative}`}';\n`
                    + source;
                source = replaceOnce(source,
                    'this.configService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsXtabLanguageContextEnabled, this.expService)',
                    'localNesSemanticContextEnabled()');
                source = replaceOnce(source,
                    'this.configService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsXtabIncludeNeighborFiles, this.expService)',
                    'localNesNeighborFilesEnabled()');
                source = replaceOnce(source,
                    'this.configService.getExperimentBasedConfig(ConfigKey.InlineEditsAllowWhitespaceOnlyChanges, this.expService)',
                    'localNesAllowWhitespaceOnlyChanges(activeDoc.id.uri)');
                source = replaceOnce(source,
                    'editStreamCtx.modelServiceConfig.allowImportChanges ?? ImportChanges.None',
                    'localNesImportChanges(request.getActiveDocument().id.uri)');
                source = replaceOnce(source,
                    'this.similarFilesContextService.getSnippetsForPrompt(activeDocument.id.uri, activeDocument.languageId, activeDocument.documentAfterEdits.value, currentDocument.cursorOffset, promptOptions.neighborFiles.includeRelatedFiles),\n\t\t\t\t\tdelaySession.getDebounceTime()',
                    'this.similarFilesContextService.getSnippetsForPrompt(activeDocument.id.uri, activeDocument.languageId, activeDocument.documentAfterEdits.value, currentDocument.cursorOffset, promptOptions.neighborFiles.includeRelatedFiles),\n\t\t\t\t\tlocalNesContextBudgetMs(delaySession.getDebounceTime())');
                source = replaceOnce(source,
                    'const debounceTime = delaySession.getDebounceTime();\n\n\t\t\tconst cursorPositionVscode',
                    'const debounceTime = localNesContextBudgetMs(delaySession.getDebounceTime());\n\n\t\t\tconst cursorPositionVscode');
                source = replaceOnce(source,
                    'globalBudget: this.getGlobalBudget(),',
                    'globalBudget: localNesGlobalBudget(this.getGlobalBudget()),');
                source = replaceOnce(source,
                    '\t\t\t\t...xtabPromptOptions.DEFAULT_OPTIONS,\n\t\t\t};',
                    '\t\t\t\t...xtabPromptOptions.DEFAULT_OPTIONS,\n\t\t\t\tglobalBudget: localNesGlobalBudget(xtabPromptOptions.DEFAULT_OPTIONS.globalBudget),\n\t\t\t};');
                source = replaceSection(source,
                    '\tprivate getEndpoint(configuredModelName: string | undefined): ChatEndpoint {',
                    '\n\tprivate getPredictedOutput',
                    '\tprivate getEndpoint(configuredModelName: string | undefined): ChatEndpoint {\n'
                        + '\t\treturn new LocalNesEndpoint(configuredModelName) as unknown as ChatEndpoint;\n'
                        + '\t}\n');
                // A disconnected local model is an ordinary missing suggestion, not an
                // extension-host exception from Copilot's remote-service error path.
                source = replaceOnce(source,
                    '\t\tcase ChatFetchResponseType.RateLimited:\n',
                    '\t\tcase ChatFetchResponseType.RateLimited:\n\t\tcase ChatFetchResponseType.Failed:\n');
                source = replaceOnce(source,
                    '\t\tcase ChatFetchResponseType.BadRequest:\n\t\tcase ChatFetchResponseType.NotFound:\n\t\tcase ChatFetchResponseType.Failed:\n',
                    '\t\tcase ChatFetchResponseType.BadRequest:\n\t\tcase ChatFetchResponseType.NotFound:\n');
                return { contents: source, loader: 'ts' };
            });
            build.onLoad({ filter: /extension[\\/]xtab[\\/]node[\\/]xtabNextCursorPredictor\.ts$/ }, async args => {
                let source = await readFile(args.path, 'utf8');
                const relative = path.relative(path.dirname(args.path), path.resolve('native/localNesEndpoint.ts')).replaceAll('\\', '/');
                const settingsRelative = path.relative(path.dirname(args.path), path.resolve('native/localNesSettings.ts')).replaceAll('\\', '/');
                source = `import { LocalNesEndpoint } from '${relative.startsWith('.') ? relative : `./${relative}`}';\n`
                    + `import { localNextCursorPredictionEnabled, localNextCursorPredictionModel } from '${settingsRelative.startsWith('.') ? settingsRelative : `./${settingsRelative}`}';\n`
                    + source;
                source = replaceOnce(source,
                    'const originalNextCursorLinePrediction = this.configService.getExperimentBasedConfig(ConfigKey.InlineEditsNextCursorPredictionEnabled, this.expService) as (NextCursorLinePrediction | boolean | undefined);',
                    'const originalNextCursorLinePrediction = localNextCursorPredictionEnabled() ? NextCursorLinePrediction.OnlyWithEdit : undefined;');
                source = replaceSection(source,
                    '\tprivate async resolveEndpoint(modelName: string, tracer: ILogger): Promise<{ endpoint: IChatEndpoint; usesResponsesApi: boolean } | undefined> {',
                    '\n\tprivate determineModelName',
                    '\tprivate async resolveEndpoint(modelName: string, _tracer: ILogger): Promise<{ endpoint: IChatEndpoint; usesResponsesApi: boolean } | undefined> {\n'
                        + '\t\tconst endpoint = new LocalNesEndpoint(modelName);\n'
                        + "\t\treturn { endpoint: endpoint as unknown as IChatEndpoint, usesResponsesApi: endpoint.apiType === 'responses' };\n"
                        + '\t}\n');
                source = replaceSection(source,
                    '\tprivate determineModelName(): string {',
                    '\n\tprivate determineLintOptions',
                    '\tprivate determineModelName(): string {\n'
                        + '\t\treturn localNextCursorPredictionModel();\n'
                        + '\t}\n');
                return { contents: source, loader: 'ts' };
            });
            // Localalot rebuilds Ghost when settings change. The upstream Git
            // service lives for the whole Copilot extension, so give its event
            // subscriptions the same lifetime as each standalone provider.
            build.onLoad({ filter: /platform[\\/]git[\\/]vscode[\\/]gitExtensionServiceImpl\.ts$/ }, async args => {
                let source = await readFile(args.path, 'utf8');
                source = replaceOnce(source,
                    'private readonly _disposables: vscode.Disposable[] = [];',
                    'private readonly _disposables: vscode.Disposable[] = [];\n\tprivate _disposed = false;');
                source = replaceOnce(source,
                    'this._disposables.push(...this._initializeExtensionApi());',
                    'this._initializeExtensionApi();');
                source = replaceOnce(source,
                    'private _initializeExtensionApi(): vscode.Disposable[] {\n\t\tconst disposables: vscode.Disposable[] = [];',
                    'private _initializeExtensionApi(): void {\n\t\tconst disposables = this._disposables;');
                source = replaceOnce(source,
                    'extension = await gitExtension!.activate();',
                    'extension = await gitExtension!.activate();\n\t\t\t\tif (this._disposed) return;');
                source = replaceOnce(source,
                    '\t\t\t});\n\t\t}\n\n\t\treturn disposables;\n\t}\n\n}',
                    '\t\t\t});\n\t\t\tdisposables.push(listener);\n\t\t}\n\t}\n\n\tdispose(): void {\n'
                        + '\t\tif (this._disposed) return;\n'
                        + '\t\tthis._disposed = true;\n'
                        + '\t\tfor (const disposable of this._disposables) disposable.dispose();\n'
                        + '\t\tthis._disposables.length = 0;\n'
                        + '\t\tthis._onDidChange.dispose();\n'
                        + '\t}\n}');
                return { contents: source, loader: 'ts' };
            });
            build.onLoad({ filter: /platform[\\/]configuration[\\/]vscode[\\/]configurationServiceImpl\.ts$/ }, async args => {
                let source = await readFile(args.path, 'utf8');
                source = replaceOnce(source,
                    'ConfigTarget, CopilotConfigPrefix, ExperimentBasedConfig',
                    'ConfigTarget, ExperimentBasedConfig');
                source = `const CopilotConfigPrefix = 'localalot';\n` + source;
                return { contents: source, loader: 'ts' };
            });
            build.onLoad({ filter: /completions-core[\\/]vscode-node[\\/]extension[\\/]src[\\/]config\.ts$/ }, async args => {
                let source = await readFile(args.path, 'utf8');
                source = replaceOnce(source,
                    "import { CopilotConfigPrefix } from '../../lib/src/constants';",
                    "const CopilotConfigPrefix = 'localalot';");
                source = replaceOnce(source,
                    "event.affectsConfiguration('github.copilot')",
                    "event.affectsConfiguration(CopilotConfigPrefix)");
                return { contents: source, loader: 'ts' };
            });
            build.onLoad({ filter: /vscodeInlineCompletionItemProvider\.ts$/ }, async args => {
                let source = await readFile(args.path, 'utf8');
                const relative = path.relative(path.dirname(args.path), path.resolve('native/vscodeCompatibility.ts')).replaceAll('\\', '/');
                const settingsRelative = path.relative(path.dirname(args.path), path.resolve('native/localGhostSettings.ts')).replaceAll('\\', '/');
                source = `import { isMeteredConnectionSafe } from '${relative.startsWith('.') ? relative : `./${relative}`}';\n`
                    + `import { localRespectSelectedCompletionInfo } from '${settingsRelative.startsWith('.') ? settingsRelative : `./${settingsRelative}`}';\n`
                    + source;
                source = replaceOnce(source, 'env.isMeteredConnection', 'isMeteredConnectionSafe()');
                source = replaceOnce(source,
                    "import { CopilotConfigPrefix } from '../../lib/src/constants';\n",
                    '');
                source = replaceOnce(source,
                    '\t\tconst copilotConfig = workspace.getConfiguration(CopilotConfigPrefix);\n',
                    '');
                source = replaceOnce(source,
                    "copilotConfig.get('respectSelectedCompletionInfo', quickSuggestionsDisabled() || BuildInfo.isPreRelease())",
                    'localRespectSelectedCompletionInfo(quickSuggestionsDisabled() || BuildInfo.isPreRelease())');
                source = replaceOnce(source,
                    'this.copilotCompletionFeedbackTracker = this._register(this.instantiationService.createInstance(CopilotCompletionFeedbackTracker));',
                    'this.copilotCompletionFeedbackTracker = { trackItem() {}, dispose() {} } as CopilotCompletionFeedbackTracker;');
                return { contents: source, loader: 'ts' };
            });
            build.onLoad({ filter: /completionsServiceBridges\.ts$/ }, async args => {
                let source = await readFile(args.path, 'utf8');
                const relative = (file) => {
                    const result = path.relative(path.dirname(args.path), path.resolve(file)).replaceAll('\\', '/');
                    return result.startsWith('.') ? result : `./${result}`;
                };
                source = `import { LocalGhostTransport } from '${relative('native/localGhostTransport.ts')}';\n`
                    + `import { LocalTokenManager, LocalModelManager } from '${relative('native/localGhostServices.ts')}';\n`
                    + `import { LocalGhostFeatures } from '${relative('native/localGhostFeatures.ts')}';\n`
                    + source;
                source = replaceOnce(source,
                    'export function createContext(serviceAccessor: ServicesAccessor, store: DisposableStore): IInstantiationService {',
                    'export function createContext(serviceAccessor: ServicesAccessor, store: DisposableStore, readOptions?: () => import("'
                        + relative('native/localGhostTransport.ts') + '").LocalGhostTransportOptions): IInstantiationService {');
                source = replaceOnce(source, 'new SyncDescriptor(CopilotTokenManagerImpl, [false])', 'new LocalTokenManager()');
                source = replaceOnce(source, 'new SyncDescriptor(AvailableModelsManager, [true])', 'new LocalModelManager()');
                source = replaceOnce(source, 'new SyncDescriptor(LiveOpenAIFetcher)', 'new LocalGhostTransport(readOptions)');
                source = replaceOnce(source, 'new SyncDescriptor(Features)', 'new SyncDescriptor(LocalGhostFeatures)');
                source = replaceOnce(source,
                    "import { ICompletionsStatusReporter } from './lib/src/progress';",
                    "import { ICompletionsStatusReporter, NoOpStatusReporter } from './lib/src/progress';");
                source = replaceOnce(source,
                    "new SyncDescriptor(CopilotStatusBar, ['github.copilot.languageStatus'])",
                    'new NoOpStatusReporter()');
                return { contents: source, loader: 'ts' };
            });
        },
    }],
    tsconfig: 'vendor/copilot/tsconfig.base.json',
    logLevel: 'info',
});

// DiffServiceImpl loads this worker beside native-core.js after NES acceptance.
await build({
    entryPoints: ['vendor/copilot/src/platform/diff/node/diffWorkerMain.ts'],
    outfile: 'dist/diffWorker.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    tsconfig: 'vendor/copilot/tsconfig.base.json',
    logLevel: 'info',
});

// VS Code loads TypeScript server plugins from the extension's node_modules.
// Build the original plugin source locally so both development and VSIX installs
// can use the same TypeScript semantic context without a private npm package.
const tsPluginDirectory = 'node_modules/@vscode/copilot-typescript-server-plugin';
await mkdir(`${tsPluginDirectory}/dist`, { recursive: true });
await build({
    entryPoints: ['vendor/copilot/src/extension/typescriptContext/serverPlugin/src/node/main.ts'],
    outfile: `${tsPluginDirectory}/dist/main.js`,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['typescript', 'typescript/lib/tsserverlibrary'],
    logLevel: 'info',
});
await writeFile(`${tsPluginDirectory}/package.json`, JSON.stringify({
    name: '@vscode/copilot-typescript-server-plugin',
    version: '1.0.0',
    private: true,
    main: './dist/main.js',
    license: 'MIT',
}, null, 2) + '\n');

await mkdir('resources/typescript-native', { recursive: true });
await Promise.all(['LICENSE', 'NOTICE.txt'].map(name =>
    copyFile(`node_modules/@typescript/native/${name}`, `resources/typescript-native/${name}`)));
