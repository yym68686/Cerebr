import { webpageCacheIdentity } from '../../utils/webpage-identity.js';

const KEY = 'cerebr_webpage_tab_instances_v1';

// A second tab at the same URL can show a different document (for example a
// different chat). Give it an opaque identity shared by the extension and its
// desktop bridge. Session storage survives service-worker restarts, but avoids
// binding an old document to a reused tab ID after the browser restarts.
export function createWebpageTabRegistry(storage) {
    let entries, queue = Promise.resolve();
    return (tabs) => {
        const result = queue.then(async () => {
            entries ??= (await storage?.get(KEY))?.[KEY] || {};
            const previous = JSON.stringify(entries);
            const live = new Set(tabs.map((tab) => String(tab.id)));
            for (const id of Object.keys(entries)) if (!live.has(id)) delete entries[id];
            const primary = new Set();
            for (const tab of tabs) {
                const entry = entries[tab.id];
                if (entry?.url === webpageCacheIdentity(tab.url) && !entry.sourceId) primary.add(entry.url);
            }
            const result = [...tabs].sort((a, b) => a.id - b.id).map((tab) => {
                const url = webpageCacheIdentity(tab.url);
                if (!url) return tab;
                let entry = entries[tab.id];
                if (entry?.url !== url) {
                    entry = entries[tab.id] = { url, sourceId: primary.has(url) ? crypto.randomUUID() : null };
                    if (!entry.sourceId) primary.add(url);
                }
                return entry.sourceId ? { ...tab, sourceId: entry.sourceId } : tab;
            });
            if (previous !== JSON.stringify(entries)) await storage?.set({ [KEY]: entries });
            return result;
        });
        queue = result.catch(() => {});
        return result;
    };
}
