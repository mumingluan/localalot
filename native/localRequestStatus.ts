import * as vscode from 'vscode';

export type LocalRequestComponent = 'ghost' | 'nes';
export interface LocalRequestStatus {
    component: LocalRequestComponent;
    message: string;
}

const statuses = new Map<LocalRequestComponent, string>();
const latestRequests = new Map<LocalRequestComponent, number>();
const changed = new vscode.EventEmitter<void>();

export const onDidChangeLocalRequestStatus = changed.event;

export function getLocalRequestStatuses(): LocalRequestStatus[] {
    return [...statuses].map(([component, message]) => ({ component, message }));
}

export function beginLocalRequest(component: LocalRequestComponent): number {
    const request = (latestRequests.get(component) ?? 0) + 1;
    latestRequests.set(component, request);
    return request;
}

/** Transport errors need to reach the standalone status menu without replacing the original providers. */
export function reportLocalRequestStatus(component: LocalRequestComponent, message?: string, request?: number): void {
    if (request !== undefined && request !== latestRequests.get(component)) return;
    if (request === undefined) beginLocalRequest(component);
    const previous = statuses.get(component);
    if (message) statuses.set(component, message.slice(0, 500));
    else statuses.delete(component);
    if (previous !== statuses.get(component)) changed.fire();
}
