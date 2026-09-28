# Localalot

Localalot is a VS Code extension project for inline completions, next edits, and next cursor predictions using locally configured model endpoints. It does not register Agent, chat, or sidebar features.

## What It Provides

- Original Copilot Ghost inline completion logic, including prefix/suffix prompts, multiline decisions, streaming, caching, IntelliSense selection context, semantic context, and YAML/JSON multiline handling.
- Original Copilot NES next edit workflow, including edit history, diagnostics and imports context, neighbor files, cross-file edits, cursor prediction, acceptance tracking, and the bottom-right completion menu.
- Local model transport for OpenAI Completions, FIM Completions, Chat Completions, OpenAI Responses, and Anthropic Messages.
- No Agent, Copilot chat panel, inline chat, or sidebar contribution.

The model and prompt logic is kept in `vendor/copilot/src`. Localalot's code supplies configuration, VS Code lifecycle bridges, and local endpoint adapters. It does not require GitHub Copilot or GitHub Copilot Chat to be installed, signed in, or active. VS Code's `chat.disableAIFeatures` setting only disables built-in GitHub Copilot AI contributions; it does not disable Localalot.

## Quick Start

1. Install Node.js 22 or newer.
2. Run `npm ci` in this directory.
3. Open the directory in VS Code and run `npm run compile`.
4. Launch the extension with **Run Extension**, or package it with your own VSIX workflow.
5. Configure `localalot.ghost.baseUrl` and `localalot.nes.baseUrl`, then set the model names.

Existing `cc-completion.*` settings are read as a compatibility fallback. A value explicitly set under `localalot.*` takes precedence; menu edits write the new `localalot.*` namespace.

For local testing, the endpoint value is relative to each configured base URL. For example, with `localalot.ghost.baseUrl` set to `http://127.0.0.1:8000/v1`, `localalot.ghost.endpoint` can be `chat/completions`, `responses`, or `messages`.

Ghost and NES can use different models and endpoints. Ghost is the short inline continuation request; NES is the larger edit and predicted-cursor request. A model server should return the protocol's normal OpenAI or Anthropic JSON/SSE response shape.

## Development Commands

```powershell
npm ci
npm run compile       # native Copilot core plus extension bundle
npm run build:native  # rebuild only the original-core bundle
npm run compile-tests
npm test              # complete VS Code integration suite
```

The `build.bat` helper packages a VSIX when Node.js 22 and npm are available. It does not alter model configuration.

## Source layout

- `vendor/copilot/src`: unmodified VS Code Copilot source snapshot, with its MIT license in `vendor/copilot/LICENSE.txt`.
- `native/entry.ts`: exports the original Ghost, NES, and cursor prediction classes from that snapshot.
- `native/localGhostTransport.ts` and `native/localNesEndpoint.ts`: send original Ghost and NES requests to the configured local model endpoints.
- `scripts/build-native.mjs`: bundles the original core and its diff worker with local model, configuration, and VS Code compatibility bridges.
- `src`: Localalot's configuration, status menu, and stable VS Code editor API bridges. Older fallback provider sources remain in the tree but are not registered in the running extension.

The original Ghost and NES providers are active by default. If either fails to start, the bottom-right menu shows the startup error. Original Ghost keeps its prompt, cache, multiline decision, and streaming response logic. Original NES keeps its edit history, trigger timing, prompt, response parser, and cache. Localalot supplies the local model transport and reads its own `localalot` settings independently of GitHub Copilot's settings. Ghost context from neighboring files is included in the local request by default; set `localalot.ghost.contextPlacement` to `extra` if the endpoint understands Copilot's `extra.context` field. Ghost and NES use language-server definitions and cursor facts by default; NES also uses relevant neighboring files. The `localalot.ghost.semanticContextEnabled`, `localalot.nes.semanticContextEnabled`, and `localalot.nes.neighborFilesEnabled` settings control these prompt sources. `localalot.ghost.capabilities.limits.max_context_window_tokens` sets the original Ghost prompt budget; its default is 8192 tokens, and larger values should match the local model's actual context capacity. `MICROSOFT-LICENSE.txt` carries the upstream license for the bundled code.
For a model exposing `/chat/completions`, `/responses`, or Anthropic `/messages`, set `localalot.ghost.endpoint` to `chat/completions`, `responses`, or `messages`. Localalot sends the original Ghost prefix, suffix, and context as code-insertion messages and accepts streamed or complete responses. These endpoint settings do not add a chat window.
For an OpenAI reasoning model on `/responses`, set `localalot.ghost.family` to `openai-o` or `openai-gpt5`. `localalot.ghost.capabilities.supports.reasoning_effort` defaults to `low` and can be adjusted for the model. This keeps Ghost's short completion requests compatible with reasoning endpoints.
The original Ghost prompt builder loads exact `o200k_base` and `cl100k_base` token dictionaries from the extension bundle. Set `localalot.ghost.tokenizer` to match the local completion model; the default is `o200k_base`.
Workspace `.copilotignore` files use the original Copilot rule parser for Ghost, NES, and prompt context. `localalot.exclude` also applies; either rule can exclude a file. Saved, created, deleted, and renamed ignore files are refreshed during the session.
Ghost also registers the original SCM context provider for Git commit message inputs, including staged diffs and commit message guidelines when the built-in Git extension has an active repository.

Original NES diagnostic fixes are enabled by default, including import and async fixes. Set `localalot.nes.diagnosticFixesEnabled` to `false` to turn them off.
The original NES diagnostics context provider also includes nearby errors and warnings in edit prompts by default. Set `localalot.nes.diagnosticContextEnabled` to `false` to disable it. When `localalot.nes.lintOptions` is configured, the diagnostics context provider stays off so the same diagnostics are not included twice.
`localalot.nes.allowImportChanges` is applied per language when the original NES model filters suggested edits. A language-specific override can disable import edits without affecting other languages.
The bottom-right completion menu also exposes the original NES eagerness setting (`localalot.nextEditSuggestions.eagerness`: auto, low, medium, or high). The original provider uses it to adjust suggestion timing.
The original NES language override is available as `localalot.nextEditSuggestions.enabled`. The bottom-right menu can enable or disable next edits for the current language without changing Ghost completions in other languages.
`localalot.nextEditSuggestions.extendedRange` provides the matching language override for predicted cursor jumps. When it is not explicitly set for the language, the bottom-right workspace toggle controls the fallback.
`localalot.nextEditSuggestions.triggerOnEditorChangeAfterSeconds` keeps the original editor-switch trigger (default `10` seconds after an edit); set it to `null` to disable that trigger. `localalot.nes.nextCursorPrediction.currentFileMaxTokens` controls the current-file budget for predicted-cursor requests (default `3000`), and `localalot.nes.renameSymbolSuggestions` enables the original rename-symbol suggestions (default `true`).
The Command Palette also provides Localalot's enable, disable, and toggle inline suggestion commands, plus a completion model picker; these use the same settings as the bottom-right menu. The picker lists models from a local OpenAI-compatible `/models` endpoint when available and also permits manual model IDs.
When a local Ghost or NES endpoint fails, the bottom-right indicator shows the request error in its tooltip and menu. A later successful request clears that endpoint's error.

NES uses the original `xtab275` prompt and response format by default. If a local model expects another original Copilot format, select it with `localalot.nes.promptingStrategy`. `localalot.nes.lintOptions` enables original NES lint context when set to a nonempty object; `localalot.nes.includeTagsInCurrentFile` and `localalot.nes.includePostScript` control the surrounding prompt. Strategy-specific settings from the original source take precedence over these generic values.

The original `patchBased02Unified` strategies let NES handle both inline completions and next edits. When one is selected and the NES endpoint is available, Localalot lets that original NES provider answer completion requests and suppresses its separate Ghost provider. The two strategies require a local model trained to return their patch format.

When VS Code does not expose the proposed inline-completion lifecycle API, Localalot uses the stable API bridge. An item command reports confirmed full acceptance back to the original provider after insertion and preserves the item's existing action. Distant and multi-line NES edits and cursor jumps cannot be shown by the stable inline completion API; a short, non-inserting hint appears beside the cursor, with a CodeLens action and an entry in the bottom-right Localalot menu. The status bar displays "Next Edit" while one is pending; hovering over it or the CodeLens shows the original text and proposed replacement. Tab also accepts a pending next edit when the editor has focus and no Ghost suggestion, IntelliSense menu, snippet, selection, or focus-navigation mode is active. When the hint or CodeLens is visible, Localalot reports that display to the original NES provider so its subsequent request can start early. The action disappears when the cursor moves or either document changes, reports the suggestion as ignored to the original provider, and applies the original edit only while the source and target documents still match the versions used for the suggestion. The original NES change event also refreshes the active editor after a cursor move or document switch. Enable `editor.codeLens` to see the CodeLens action. Stable VS Code still does not report display, partial acceptance, rejection, or supersession of native ghost text, so those lifecycle details require the API proposal.
The stable next-edit action loads a cross-file target document when needed before checking its version, so a predicted cursor jump can reach a file that was not already open.

When VS Code exposes the `inlineCompletionsAdditions` proposal, Localalot registers the original provider directly. This preserves Copilot's native multi-line and cross-file NES rendering, display lifecycle, partial acceptance, rejection, provider options, model picker, and change hints. Hosts without the proposal automatically use the stable bridge above, so Ghost and NES remain usable without proposed API access.

For a `chat/completions` server that supports predicted output, `localalot.nes.sendPrediction` passes through the original NES edit-window prediction. It is off by default because many local OpenAI-compatible endpoints reject that request field.
`localalot.nes.nextCursorPrediction.model` can select a separate local model for the original predicted-cursor request; an empty value uses the NES model.
Next cursor prediction starts enabled, matching the original default. The bottom-right menu remembers an explicit on or off choice for the workspace.
Set `localalot.nes.capabilities.limits.max_context_window_tokens` to the local model's total context window. For small windows, Localalot uses the original NES global-budget allocator to trim prompt context and caps output tokens to leave room for the prompt. This is an approximate budget because system text, edit-window markup, and model tokenizers add overhead.

## Develop

```powershell
npm ci
npm run compile
```

Open this directory in VS Code and launch **Run Extension**. Settings and commands use the `localalot` prefix, so this extension can be tested alongside `copilot-completion` without sharing command IDs. To run it standalone, disable GitHub Copilot and Copilot Chat (for example, keep `chat.disableAIFeatures: true` and disable the GitHub extensions in the Extensions view). Localalot has no `extensionDependencies`, activates on `onStartupFinished`, and continues to register its own Ghost, NES, context, diagnostics, cursor prediction, and rename providers. Existing `cc-completion.*` endpoint/model settings remain valid while Copilot is disabled; `localalot.*` values take precedence when both are present.
