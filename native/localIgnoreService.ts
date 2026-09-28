import * as vscode from 'vscode';
import { isUriExcludedByConfiguration } from '../src/completions/shared/documentEligibility';
import type { IIgnoreService } from '../vendor/copilot/src/platform/ignore/common/ignoreService';
import { IgnoreFile } from '../vendor/copilot/src/platform/ignore/node/ignoreFile';
import { URI } from '../vendor/copilot/src/util/vs/base/common/uri';
import { advanceRelatedFilesIgnoreRevision } from './relatedFilesCacheRevision';

/** Keeps Localalot exclusions and the original Copilot .copilotignore parser in one service. */
export class LocalIgnoreService implements IIgnoreService {
    declare _serviceBrand: undefined;

    private readonly ignoreFiles = new Map<string, IgnoreFile>();
    private readonly disposables: vscode.Disposable[] = [];
    private initialization: Promise<void> | undefined;
    private pendingUpdates: Promise<void> = Promise.resolve();
    private disposed = false;

    get isEnabled(): boolean { return true; }
    get isRegexExclusionsEnabled(): boolean { return false; }

    init(): Promise<void> {
        if (this.disposed) return Promise.resolve();
        return this.initialization ??= this.start();
    }

    async whenReady(): Promise<void> {
        await this.init();
        await this.pendingUpdates;
    }

    private async start(): Promise<void> {
        const watcher = vscode.workspace.createFileSystemWatcher('**/.copilotignore');
        this.disposables.push(watcher,
            watcher.onDidCreate(uri => this.queueUpdate(() => this.refreshFile(uri))),
            watcher.onDidChange(uri => this.queueUpdate(() => this.refreshFile(uri))),
            watcher.onDidDelete(uri => this.queueUpdate(async () => {
                this.ignoreFilesFor(uri)?.removeIgnoreFile(URI.parse(uri.toString()));
                advanceRelatedFilesIgnoreRevision();
            })),
            vscode.workspace.onDidRenameFiles(event => {
                for (const file of event.files) {
                    if (file.oldUri.path.endsWith('/.copilotignore')) {
                        this.queueUpdate(async () => {
                            this.ignoreFilesFor(file.oldUri)?.removeIgnoreFile(URI.parse(file.oldUri.toString()));
                            advanceRelatedFilesIgnoreRevision();
                        });
                    }
                    if (file.newUri.path.endsWith('/.copilotignore')) {
                        this.queueUpdate(() => this.refreshFile(file.newUri));
                    }
                }
            }),
            vscode.workspace.onDidSaveTextDocument(document => {
                if (document.uri.path.endsWith('/.copilotignore')) {
                    this.queueUpdate(() => this.refreshFile(document.uri));
                }
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(event => {
                for (const folder of event.removed) {
                    this.queueUpdate(async () => {
                        this.ignoreFilesFor(folder.uri)?.removeWorkspace(URI.parse(folder.uri.toString()));
                        advanceRelatedFilesIgnoreRevision();
                    });
                }
                for (const folder of event.added) this.queueUpdate(() => this.scanFolder(folder));
            }),
        );
        for (const folder of vscode.workspace.workspaceFolders ?? []) await this.scanFolder(folder);
    }

    private queueUpdate(update: () => Promise<void>): void {
        this.pendingUpdates = this.pendingUpdates.then(() => this.disposed ? undefined : update()).catch(error => {
            console.warn(`Localalot could not update .copilotignore rules: ${String(error)}`);
        });
    }

    private async scanFolder(folder: vscode.WorkspaceFolder): Promise<void> {
        if (this.disposed) return;
        try {
            const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/.copilotignore'));
            for (const file of files) await this.refreshFile(file);
        } catch (error) {
            console.warn(`Localalot could not scan .copilotignore in ${folder.uri.toString()}: ${String(error)}`);
        }
    }

    private async refreshFile(uri: vscode.Uri): Promise<void> {
        if (!uri.path.endsWith('/.copilotignore') || this.disposed) return;
        const originalUri = URI.parse(uri.toString());
        try {
            const contents = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
            if (this.disposed) return;
            const folder = vscode.workspace.getWorkspaceFolder(uri);
            if (folder) {
                this.ignoreFilesFor(uri, true)!.setIgnoreFile(URI.parse(folder.uri.toString()), originalUri, contents);
                advanceRelatedFilesIgnoreRevision();
            }
        } catch (error) {
            this.ignoreFilesFor(uri)?.removeIgnoreFile(originalUri);
            advanceRelatedFilesIgnoreRevision();
            console.warn(`Localalot could not read ${uri.toString()}: ${String(error)}`);
        }
    }

    async isCopilotIgnored(uri: URI): Promise<boolean> {
        await this.whenReady();
        const documentUri = vscode.Uri.parse(uri.toString());
        return isUriExcludedByConfiguration(documentUri)
            || (this.ignoreFilesFor(documentUri)?.isIgnored(uri) ?? false);
    }

    async asMinimatchPattern(): Promise<string | undefined> {
        await this.whenReady();
        const patterns = [...this.ignoreFiles.values()].flatMap(files => files.asMinimatchPatterns());
        return patterns.length === 0 ? undefined : patterns.length === 1 ? patterns[0] : `{${patterns.join(',')}}`;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        vscode.Disposable.from(...this.disposables).dispose();
        this.disposables.length = 0;
        this.ignoreFiles.clear();
    }

    private ignoreFilesFor(uri: vscode.Uri, create = false): IgnoreFile | undefined {
        const origin = `${uri.scheme}://${uri.authority}`;
        let files = this.ignoreFiles.get(origin);
        if (!files && create) {
            files = new IgnoreFile();
            this.ignoreFiles.set(origin, files);
        }
        return files;
    }
}
