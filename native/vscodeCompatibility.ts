import { env } from 'vscode';

/** Custom extension IDs cannot read this proposed VS Code API without a launch flag. */
export function isMeteredConnectionSafe(): boolean {
    try { return env.isMeteredConnection === true; }
    catch { return false; }
}
