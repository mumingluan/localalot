import { IIgnoreService } from '../vendor/copilot/src/platform/ignore/common/ignoreService';
import { URI } from '../vendor/copilot/src/util/vs/base/common/uri';
import type { ServicesAccessor } from '../vendor/copilot/src/util/vs/platform/instantiation/common/instantiation';

/** Apply current ignore rules to both open tabs and cached related files. */
export async function filterIgnoredNeighbors<K, V, T extends {
    docs: Map<string, V>;
    neighborSource: Map<K, string[]>;
}>(accessor: ServicesAccessor, result: T): Promise<T> {
    if (result.docs.size === 0) return result;
    const ignoreService = accessor.get(IIgnoreService);
    const uris = [...result.docs.keys()];
    const excluded = await Promise.all(uris.map(async uri => {
        try {
            return await ignoreService.isCopilotIgnored(URI.parse(uri));
        } catch {
            return true;
        }
    }));
    for (let index = 0; index < uris.length; index++) {
        if (excluded[index]) result.docs.delete(uris[index]);
    }
    for (const [source, sourceUris] of result.neighborSource) {
        const allowed = sourceUris.filter(uri => result.docs.has(uri));
        if (allowed.length === 0) result.neighborSource.delete(source);
        else result.neighborSource.set(source, allowed);
    }
    return result;
}
