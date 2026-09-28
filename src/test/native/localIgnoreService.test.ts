import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerIgnoreContextInvalidation } from '../../native/ignoreContextInvalidation';

suite('Local Copilot ignore bridge', () => {
    test('waits for a queued rule update before checking a file', async function () {
        this.timeout(10000);
        const native = require('../../../dist/native-core.js') as {
            LocalIgnoreService: new () => {
                init(): Promise<void>;
                whenReady(): Promise<void>;
                queueUpdate(update: () => Promise<void>): void;
                isCopilotIgnored(uri: unknown): Promise<boolean>;
                ignoreFilesFor(uri: vscode.Uri, create: boolean): {
                    setIgnoreFile(root: unknown, rule: unknown, contents: string): void;
                } | undefined;
                dispose(): void;
            };
        };
        const service = new native.LocalIgnoreService();
        try {
            await service.init();
            const root = vscode.Uri.parse('vscode-remote://ssh-remote+queued/workspace');
            const rule = vscode.Uri.joinPath(root, '.copilotignore');
            const secret = vscode.Uri.joinPath(root, 'private.secret');
            let release!: () => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            service.queueUpdate(async () => {
                await gate;
                service.ignoreFilesFor(root, true)?.setIgnoreFile(root, rule, '*.secret\n');
            });
            let settled = false;
            const check = service.isCopilotIgnored(secret).then(value => {
                settled = true;
                return value;
            });
            let ready = false;
            const readiness = service.whenReady().then(() => { ready = true; });
            await Promise.resolve();
            await Promise.resolve();
            assert.strictEqual(settled, false);
            assert.strictEqual(ready, false);
            release();
            await readiness;
            assert.strictEqual(await check, true);
        } finally {
            service.dispose();
        }
    });

    test('refreshes prompt state when .copilotignore changes', async function () {
        this.timeout(10000);
        const extension = vscode.extensions.getExtension('mumingluan.localalot');
        assert.ok(extension);
        const folder = vscode.workspace.getWorkspaceFolder(extension.extensionUri);
        assert.ok(folder?.uri.scheme === 'file');
        const directory = await fs.mkdtemp(path.join(folder.uri.fsPath, 'localalot-invalidation-'));
        const ignoreFile = path.join(directory, '.copilotignore');
        let invalidations = 0;
        const registration = registerIgnoreContextInvalidation(() => invalidations++);
        try {
            await fs.writeFile(ignoreFile, '*.secret\n');
            await eventually(() => invalidations > 0);
            const afterCreate = invalidations;
            await fs.writeFile(ignoreFile, '*.private\n');
            await eventually(() => invalidations > afterCreate);
        } finally {
            registration.dispose();
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    test('keeps original ignore rules scoped to a remote URI origin', async () => {
        const native = require('../../../dist/native-core.js') as {
            LocalIgnoreService: new () => {
                isCopilotIgnored(uri: unknown): Promise<boolean>;
                dispose(): void;
                ignoreFilesFor(uri: vscode.Uri, create: boolean): {
                    setIgnoreFile(root: unknown, rule: unknown, contents: string): void;
                } | undefined;
            };
        };
        const service = new native.LocalIgnoreService();
        try {
            const root = vscode.Uri.parse('vscode-remote://ssh-remote+host-a/workspace');
            const rule = vscode.Uri.joinPath(root, '.copilotignore');
            const ignored = vscode.Uri.joinPath(root, 'private.secret');
            const otherHost = vscode.Uri.parse('vscode-remote://ssh-remote+host-b/workspace/private.secret');
            service.ignoreFilesFor(root, true)?.setIgnoreFile(root, rule, '*.secret\n');
            assert.strictEqual(await service.isCopilotIgnored(ignored), true);
            assert.strictEqual(await service.isCopilotIgnored(otherHost), false);
        } finally {
            service.dispose();
        }
    });

    test('loads and refreshes original .copilotignore rules', async function () {
        this.timeout(20000);
        const extension = vscode.extensions.getExtension('mumingluan.localalot');
        assert.ok(extension);
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(extension.extensionUri);
        assert.ok(workspaceFolder?.uri.scheme === 'file', 'This test needs the extension project as a workspace');
        const directory = await fs.mkdtemp(path.join(workspaceFolder.uri.fsPath, 'localalot-ignore-'));
        const folderUri = vscode.Uri.file(directory);
        const ignoreUri = vscode.Uri.joinPath(folderUri, '.copilotignore');
        const ignoredUri = vscode.Uri.joinPath(folderUri, 'private.secret');
        const allowedUri = vscode.Uri.joinPath(folderUri, 'allowed.secret');
        await fs.writeFile(ignoreUri.fsPath, '*.secret\n!allowed.secret\n');
        let service: {
            init(): Promise<void>;
            isCopilotIgnored(uri: unknown): Promise<boolean>;
            dispose(): void;
        } | undefined;
        try {
            const native = require('../../../dist/native-core.js') as {
                LocalIgnoreService: new () => typeof service;
                currentRelatedFilesIgnoreRevision(): number;
            };
            service = new native.LocalIgnoreService();
            await service!.init();
            assert.strictEqual(await service!.isCopilotIgnored(ignoredUri), true);
            assert.strictEqual(await service!.isCopilotIgnored(allowedUri), false);

            const oldRevision = native.currentRelatedFilesIgnoreRevision();
            await fs.writeFile(ignoreUri.fsPath, '*.ts\n');
            await eventually(async () => !await service!.isCopilotIgnored(ignoredUri));
            assert.ok(native.currentRelatedFilesIgnoreRevision() > oldRevision);
            assert.strictEqual(await service!.isCopilotIgnored(vscode.Uri.joinPath(folderUri, 'index.ts')), true);

            const renamedUri = vscode.Uri.joinPath(folderUri, 'rules.bak');
            await fs.rename(ignoreUri.fsPath, renamedUri.fsPath);
            await eventually(async () => !await service!.isCopilotIgnored(vscode.Uri.joinPath(folderUri, 'index.ts')));
        } finally {
            service?.dispose();
            await fs.rm(directory, { recursive: true, force: true });
        }
    });
});

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!await predicate()) {
        if (Date.now() >= deadline) assert.fail('Timed out waiting for ignore rules to refresh');
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}
