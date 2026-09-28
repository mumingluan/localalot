import * as vscode from 'vscode';
import { getLocalRespectSelectedCompletionInfo } from '../src/config/compatConfiguration';

/** Keep Copilot's dynamic IntelliSense default when Localalot has no explicit override. */
export function localRespectSelectedCompletionInfo(defaultValue: boolean): boolean {
    return getLocalRespectSelectedCompletionInfo(undefined, defaultValue);
}

/** Resolve the same setting for an editor resource, including language overrides. */
export function localRespectSelectedCompletionInfoForScope(
    scope: vscode.ConfigurationScope | undefined,
    defaultValue: boolean,
): boolean {
    return getLocalRespectSelectedCompletionInfo(scope, defaultValue);
}
