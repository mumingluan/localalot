import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

let _wasmDirPath: string | undefined;

/** Set the WASM directory path. Called from extension activate() with context.extensionUri.fsPath. */
export function setWasmDirPath(extensionFsPath: string): void {
    _wasmDirPath = path.resolve(extensionFsPath, 'dist', 'wasm');
}

export function locateFile(filename: string): string {
    const candidates = _wasmDirPath
        ? [
            path.resolve(_wasmDirPath, filename),
            // Tests often pass the repository root while webpack builds use
            // the extension directory directly.
            path.resolve(_wasmDirPath, '..', 'dist', 'wasm', filename),
        ]
        : [
            // Packaged/bundled extension: __dirname is dist/.
            path.resolve(__dirname, 'wasm', filename),
            // Compiled tests: __dirname is out/.../treeSitter.
            path.resolve(__dirname, '../../../../..', 'dist', 'wasm', filename),
            path.resolve(process.cwd(), 'dist', 'wasm', filename),
        ];
    const existing = candidates.find(candidate => existsSync(candidate));
    if (existing) {
        return existing;
    }
    return candidates[0];
}

export async function readFile(filename: string): Promise<Uint8Array> {
    return await fs.readFile(locateFile(filename));
}
