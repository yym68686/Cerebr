import { storageAdapter, isExtensionEnvironment } from './storage-adapter.js';
import { desktopBrowserRequest, onDesktopBrowserEvent } from '../platform/desktop-browser.js';

const WEBPAGE_SWITCHES_BY_CHAT_PREFIX = 'cerebr_webpage_switches_v1_';
const LEGACY_WEBPAGE_SWITCHES_KEY = 'webpageSwitches';
const WEBPAGE_PREFERENCE_PREFIX = 'cerebr_webpage_auto_include_v1_';
const WEBPAGE_CACHE_PREFIX = 'cerebr_webpage_cache_v1_';
const WEBPAGE_SELECTION_PREFIX = 'cerebr_webpage_selection_v1_';
const pendingPreferences = new Map();
const pendingCacheWrites = new Map();
const cacheClearRevisions = new Map();
const cachePageRevisions = new Map();

function cachePageRevisionKey(chatId, identity) {
    return `${chatId}\u0000${identity}`;
}

export function getWebpageCacheRevision(chatId, url) {
    const identity = webpageCacheIdentity(url);
    const pageRevision = identity ? cachePageRevisions.get(cachePageRevisionKey(chatId, identity)) || 0 : 0;
    return `${cacheClearRevisions.get(chatId) || 0}:${pageRevision}`;
}

// Remember a document, including query parameters and hash-router paths, while
// treating ordinary in-page anchors as the same document.
export function webpagePreferenceKey(value) {
    try {
        const url = new URL(value);
        if (!['https:', 'http:', 'file:'].includes(url.protocol)) return null;
        if (!/^#!?\//.test(url.hash)) url.hash = '';
        return WEBPAGE_PREFERENCE_PREFIX + encodeURIComponent(url.href);
    } catch {
        return null;
    }
}

export function webpageCacheIdentity(value) {
    const key = webpagePreferenceKey(value);
    return key ? key.slice(WEBPAGE_PREFERENCE_PREFIX.length) : null;
}

function webpageCacheKey(chatId) {
    return `${WEBPAGE_CACHE_PREFIX}${chatId}`;
}

function enqueueCacheWrite(chatId, write) {
    const pending = (pendingCacheWrites.get(chatId) || Promise.resolve()).catch(() => {}).then(write);
    pendingCacheWrites.set(chatId, pending);
    const clear = () => {
        if (pendingCacheWrites.get(chatId) === pending) pendingCacheWrites.delete(chatId);
    };
    pending.then(clear, clear);
    return pending;
}

export async function getCachedWebpagesForChat(chatId) {
    if (!chatId) return [];
    await pendingCacheWrites.get(chatId)?.catch(() => {});
    const key = webpageCacheKey(chatId);
    const result = await storageAdapter.get(key);
    return Array.isArray(result?.[key])
        ? result[key].filter((page) => page && webpageCacheIdentity(page.url) && typeof page.content === 'string')
        : [];
}

export async function saveCachedWebpagesForChat(chatId, pages, revisions = null) {
    if (!chatId || !Array.isArray(pages) || !pages.length) return;
    const expectedRevisions = revisions || new Map(
        pages.map((page) => [webpageCacheIdentity(page?.url), getWebpageCacheRevision(chatId, page?.url)])
    );
    return enqueueCacheWrite(chatId, async () => {
        // A source removed while extraction was running must not reappear when
        // that older extraction eventually completes.
        const key = webpageCacheKey(chatId);
        const result = await storageAdapter.get(key);
        const cached = Array.isArray(result?.[key]) ? result[key] : [];
        const byUrl = new Map(cached.flatMap((page) => {
            const identity = webpageCacheIdentity(page?.url);
            return identity && typeof page?.content === 'string' ? [[identity, page]] : [];
        }));
        for (const page of pages) {
            const identity = webpageCacheIdentity(page?.url);
            if (!identity || typeof page.content !== 'string') continue;
            if (expectedRevisions.get(identity) !== getWebpageCacheRevision(chatId, page.url)) continue;
            const observedAt = Number(page.observedAt) || Date.now();
            if (observedAt < (Number(byUrl.get(identity)?.updatedAt) || 0)) continue;
            byUrl.set(identity, { ...page, updatedAt: observedAt });
        }
        await storageAdapter.set({ [key]: [...byUrl.values()] });
    });
}

export async function removeCachedWebpagesForChat(chatId, urls) {
    if (!chatId || !Array.isArray(urls) || !urls.length) return;
    const identities = new Set(urls.map(webpageCacheIdentity).filter(Boolean));
    if (!identities.size) return;
    for (const identity of identities) {
        const key = cachePageRevisionKey(chatId, identity);
        cachePageRevisions.set(key, (cachePageRevisions.get(key) || 0) + 1);
    }
    return enqueueCacheWrite(chatId, async () => {
        const key = webpageCacheKey(chatId);
        const result = await storageAdapter.get(key);
        const cached = Array.isArray(result?.[key]) ? result[key] : [];
        const remaining = cached.filter((page) => !identities.has(webpageCacheIdentity(page?.url)));
        if (remaining.length === cached.length) return;
        if (remaining.length) await storageAdapter.set({ [key]: remaining });
        else await storageAdapter.remove(key);
    });
}

export async function clearCachedWebpagesForChat(chatId) {
    if (!chatId) return;
    cacheClearRevisions.set(chatId, (cacheClearRevisions.get(chatId) || 0) + 1);
    return enqueueCacheWrite(chatId, () => storageAdapter.remove(webpageCacheKey(chatId)));
}

export async function removeCachedWebpageSource(chatId, page) {
    if (!chatId || !page?.url) return false;
    if (Number.isSafeInteger(page.tabId)) {
        const tabId = String(page.tabId);
        try {
            if (globalThis.cerebrDesktop) {
                const switches = await desktopBrowserRequest({ type: 'GET_WEBPAGE_SWITCHES', chatId, initialize: false });
                await desktopBrowserRequest({
                    type: 'SET_WEBPAGE_SWITCHES',
                    chatId,
                    patch: { ...normalizeSwitches(switches), [tabId]: false },
                });
            } else {
                await updateWebpageSwitchesForChat(chatId, { [tabId]: false });
            }
        } catch {
            // A disconnected browser must not prevent removal of the local snapshot.
        }
    }
    await removeCachedWebpagesForChat(chatId, [page.url]);
    return true;
}

export function isNewWebpageConversation(chat) {
    return (
        Array.isArray(chat?.messages) && chat.messages.every((message) => message?.seedLocaleBound === true)
    );
}
const pendingWrites = new Map();
const listeners = new Set();

export function subscribeWebpageSwitches(listener) {
    listeners.add(listener);
    const unsubscribe=onDesktopBrowserEvent(event=>{if(event.type==='selection-changed')listener(event.chatId);});
    const storageChanged=(changes,area)=>{if(area==='local')for(const key of Object.keys(changes))if(key.startsWith(WEBPAGE_SWITCHES_BY_CHAT_PREFIX))listener(key.slice(WEBPAGE_SWITCHES_BY_CHAT_PREFIX.length));};
    globalThis.chrome?.storage?.onChanged?.addListener(storageChanged);
    return () => {listeners.delete(listener);unsubscribe();globalThis.chrome?.storage?.onChanged?.removeListener(storageChanged);};
}

function changed(chatId) {
    for (const listener of listeners) listener(chatId);
}

function keyForChatId(chatId) {
    return `${WEBPAGE_SWITCHES_BY_CHAT_PREFIX}${chatId}`;
}

function selectionKey(chatId) {
    return `${WEBPAGE_SELECTION_PREFIX}${chatId}`;
}

async function readSelection(chatId) {
    const key = selectionKey(chatId);
    const result = await storageAdapter.get(key);
    const selection = result?.[key];
    const urls = { ...selection?.urls };
    if (!selection) {
        for (const page of await getCachedWebpagesForChat(chatId)) {
            if (Number.isSafeInteger(page.tabId)) urls[page.tabId] = webpageCacheIdentity(page.url);
        }
    }
    return { ...selection, urls };
}

function bindSelectedTabs(selection, switches, tabs) {
    for (const tab of tabs) {
        if (!Object.hasOwn(switches, tab.id)) continue;
        const identity = webpageCacheIdentity(tab.url);
        const previous = selection.urls[tab.id];
        // Tab IDs survive navigation. A choice belongs to the document that
        // was selected, never the next document opened in that same tab.
        if (!identity || previous && previous !== identity) {
            delete switches[tab.id];
            delete selection.urls[tab.id];
        } else {
            selection.urls[tab.id] = identity;
        }
    }
}

function normalizeSwitches(value) {
    if (!value || typeof value !== 'object') return {};
    const result = {};
    for (const [tabId, enabled] of Object.entries(value)) {
        result[tabId] = !!enabled;
    }
    return result;
}

async function migrateLegacySwitchesIfNeeded(chatId) {
    if (!chatId) return;
    const chatKey = keyForChatId(chatId);

    const result = await storageAdapter.get([chatKey, LEGACY_WEBPAGE_SWITCHES_KEY]);
    const existing = result?.[chatKey];
    if (existing && typeof existing === 'object') return;

    const legacy = result?.[LEGACY_WEBPAGE_SWITCHES_KEY];
    const normalizedLegacy = normalizeSwitches(legacy);
    if (Object.keys(normalizedLegacy).length === 0) return;

    await storageAdapter.set({ [chatKey]: normalizedLegacy });
    await storageAdapter.remove(LEGACY_WEBPAGE_SWITCHES_KEY).catch(() => {});
}

async function readSwitchesRecord(chatId) {
    await migrateLegacySwitchesIfNeeded(chatId);
    const key = keyForChatId(chatId);
    const result = await storageAdapter.get(key);
    return result?.[key];
}

function enqueueWrite(chatId, write) {
    const pending = (pendingWrites.get(chatId) || Promise.resolve()).catch(() => {}).then(write);
    pendingWrites.set(chatId, pending);
    const clear = () => {
        if (pendingWrites.get(chatId) === pending) pendingWrites.delete(chatId);
    };
    pending.then(clear, clear);
    return pending;
}

export async function getWebpageSwitchesForChat(chatId, { currentTab, tabs = [], initialize = false } = {}) {
    if (!chatId) return {};
    // Desktop can select pages explicitly; only the extension auto-adds its current page.
    if(globalThis.cerebrDesktop)return desktopBrowserRequest({type:'GET_WEBPAGE_SWITCHES',chatId,initialize:false});
    const preferenceKey = currentTab && webpagePreferenceKey(currentTab.url);
    const knownTabs = tabs.length ? tabs : currentTab ? [currentTab] : [];
    if (isExtensionEnvironment && (knownTabs.length || initialize)) {
        // Capture earlier choices before joining the per-chat queue. Looking up
        // this promise inside the job could wait on a later write behind itself.
        const priorChoice = pendingPreferences.get(preferenceKey);
        return enqueueWrite(chatId, async () => {
            await priorChoice?.catch(() => {});
            const existing = await readSwitchesRecord(chatId);
            const switches = normalizeSwitches(existing);
            const selection = await readSelection(chatId);
            const previousSelection = JSON.stringify(selection);
            bindSelectedTabs(selection, switches, knownTabs);
            if (initialize && (selection.autoFollow || !existing)) {
                selection.autoFollow = true;
                const identity = preferenceKey && webpageCacheIdentity(currentTab.url);
                const previous = selection.automatic;
                if (previous && (previous.id !== currentTab?.id || previous.url !== identity)) {
                    delete switches[previous.id];
                    delete selection.urls[previous.id];
                }
                selection.automatic = null;
                if (identity && currentTab.id != null) {
                    const automatic = !Object.hasOwn(switches, currentTab.id) ||
                        previous?.id === currentTab.id && previous.url === identity;
                    if (!Object.hasOwn(switches, currentTab.id)) {
                        const preferences = await storageAdapter.get(preferenceKey);
                        switches[currentTab.id] = preferences[preferenceKey] !== false;
                    }
                    selection.urls[currentTab.id] = identity;
                    if (automatic) selection.automatic = { id: currentTab.id, url: identity };
                }
            }
            const switchesChanged = JSON.stringify(normalizeSwitches(existing)) !== JSON.stringify(switches);
            if (switchesChanged || previousSelection !== JSON.stringify(selection)) {
                await storageAdapter.set({
                    [keyForChatId(chatId)]: switches,
                    [selectionKey(chatId)]: selection,
                });
                if (switchesChanged) changed(chatId);
            }
            return switches;
        });
    }
    // Sending immediately after toggling must include all already queued changes.
    await pendingWrites.get(chatId);
    return normalizeSwitches(await readSwitchesRecord(chatId));
}

export async function setWebpageSwitchesForChat(chatId, switches) {
    if (!chatId) return false;
    if(globalThis.cerebrDesktop)return desktopBrowserRequest({type:'SET_WEBPAGE_SWITCHES',chatId,patch:normalizeSwitches(switches)});
    const value = normalizeSwitches(switches);
    return enqueueWrite(chatId, async () => {
        await storageAdapter.set({ [keyForChatId(chatId)]: value });
        changed(chatId);
        return true;
    });
}

export async function updateWebpageSwitchesForChat(chatId, patch, { tabs = [] } = {}) {
    if (!chatId) return false;
    const changes = normalizeSwitches(patch);
    const removedUrls = tabs.filter((tab) => changes[tab.id] === false).map((tab) => tab.url);
    if (globalThis.cerebrDesktop) {
        const result = await desktopBrowserRequest({ type: 'UPDATE_WEBPAGE_SWITCHES', chatId, patch: changes });
        if (removedUrls.length) await removeCachedWebpagesForChat(chatId, removedUrls);
        return result;
    }
    const preferences = Object.fromEntries(
        tabs.flatMap((tab) => {
            const key = webpagePreferenceKey(tab.url);
            return key && Object.hasOwn(changes, tab.id) ? [[key, changes[tab.id]]] : [];
        })
    );
    const previousChoices = Object.keys(preferences).map((key) => pendingPreferences.get(key));
    const saving = enqueueWrite(chatId, async () => {
        // The same URL can be changed from different conversations. Preserve
        // click order even if one chat's storage read takes longer than another.
        await Promise.all(previousChoices.map((pending) => pending?.catch(() => {})));
        const current = normalizeSwitches(await readSwitchesRecord(chatId));
        const selection = await readSelection(chatId);
        for (const tab of tabs) {
            if (Object.hasOwn(changes, tab.id)) selection.urls[tab.id] = webpageCacheIdentity(tab.url);
        }
        // One storage operation keeps the visible selection and future default
        // consistent, including when a save fails.
        await storageAdapter.set({
            [keyForChatId(chatId)]: { ...current, ...changes },
            [selectionKey(chatId)]: selection,
            ...preferences,
        });
        if (removedUrls.length) await removeCachedWebpagesForChat(chatId, removedUrls);
        changed(chatId);
        return true;
    });
    for (const key of Object.keys(preferences)) {
        pendingPreferences.set(key, saving);
        const clear = () => {
            if (pendingPreferences.get(key) === saving) pendingPreferences.delete(key);
        };
        saving.then(clear, clear);
    }
    return saving;
}
