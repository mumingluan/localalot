// These exports intentionally point at the unmodified upstream implementation.
// Localalot's configuration and transport adapters live outside vendor/copilot.
export { GhostText } from '../vendor/copilot/src/extension/completions-core/vscode-node/lib/src/inlineCompletion';
export { GhostTextProvider } from '../vendor/copilot/src/extension/completions-core/vscode-node/extension/src/ghostText/ghostTextProvider';
export { XtabProvider } from '../vendor/copilot/src/extension/xtab/node/xtabProvider';
export { XtabNextCursorPredictor } from '../vendor/copilot/src/extension/xtab/node/xtabNextCursorPredictor';
export { NextEditProvider } from '../vendor/copilot/src/extension/inlineEdits/node/nextEditProvider';
export { InlineCompletionProviderImpl } from '../vendor/copilot/src/extension/inlineEdits/vscode-node/inlineCompletionProvider';
export { isInlineSuggestionFromTextAfterCursor } from '../vendor/copilot/src/extension/xtab/common/inlineSuggestion';
export { NeighborSource } from '../vendor/copilot/src/extension/completions-core/vscode-node/lib/src/prompt/similarFiles/neighborFiles';
export { getRelatedFilesAndTraits } from '../vendor/copilot/src/extension/completions-core/vscode-node/lib/src/prompt/similarFiles/relatedFiles';
export { advanceRelatedFilesIgnoreRevision, currentRelatedFilesIgnoreRevision } from './relatedFilesCacheRevision';
export { InstantiationServiceBuilder } from '../vendor/copilot/src/util/common/services';
export { registerServices as registerCommonServices } from '../vendor/copilot/src/extension/extension/vscode/services';
export { createContext, setup } from '../vendor/copilot/src/extension/completions-core/vscode-node/completionsServiceBridges';
export { CopilotInlineCompletionItemProvider } from '../vendor/copilot/src/extension/completions-core/vscode-node/extension/src/vscodeInlineCompletionItemProvider';
export { LocalGhostTransport } from './localGhostTransport';
export { onDidChangeLocalRequestStatus, getLocalRequestStatuses } from './localRequestStatus';
export { LocalIgnoreService } from './localIgnoreService';
export { LocalModelManager } from './localGhostServices';
export { localRespectSelectedCompletionInfo } from './localGhostSettings';
export { createLocalGhostProvider } from './ghostBootstrap';
export { LocalNesModelService } from './localNesModelService';
export { createLocalNesProvider } from './nesBootstrap';
export { createLocalNesRenameContribution } from './nesRenameBootstrap';
export { LocalNesEndpoint } from './localNesEndpoint';
export { GitExtensionServiceImpl } from '../vendor/copilot/src/platform/git/vscode/gitExtensionServiceImpl';
export { ensureTokenizersLoaded, getTokenizer, TokenizerName, TTokenizer } from '../vendor/copilot/src/extension/completions-core/vscode-node/prompt/src/tokenization';
