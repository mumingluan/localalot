// Related-file results are cached inside the bundled upstream implementation.
// Ignore rule changes must invalidate those results without rebuilding Ghost or NES.
let ignoreRevision = 0;

export function currentRelatedFilesIgnoreRevision(): number {
    return ignoreRevision;
}

export function advanceRelatedFilesIgnoreRevision(): void {
    ignoreRevision++;
}
