import { storageAdapter, isExtensionEnvironment } from './storage-adapter.js';
import { desktopBrowserRequest, onDesktopBrowserEvent } from '../platform/desktop-browser.js';

const WEBPAGE_SWITCHES_BY_CHAT_PREFIX = 'cerebr_webpage_switches_v1_';
const LEGACY_WEBPAGE_SWITCHES_KEY = 'webpageSwitches';
const WEBPAGE_PREFERENCE_PREFIX = 'cerebr_webpage_auto_include_v1_';
const pendingPreferences = new Map();

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

export async function getWebpageSwitchesForChat(chatId, { currentTab, initialize = false } = {}) {
    if (!chatId) return {};
    // Desktop can select pages explicitly; only the extension auto-adds its current page.
    if(globalThis.cerebrDesktop)return desktopBrowserRequest({type:'GET_WEBPAGE_SWITCHES',chatId,initialize:false});
    const preferenceKey = currentTab && webpagePreferenceKey(currentTab.url);
    if (isExtensionEnvironment && initialize && preferenceKey && currentTab.id != null) {
        // Capture earlier choices before joining the per-chat queue. Looking up
        // this promise inside the job could wait on a later write behind itself.
        const priorChoice = pendingPreferences.get(preferenceKey);
        return enqueueWrite(chatId, async () => {
            await priorChoice?.catch(() => {});
            const existing = await readSwitchesRecord(chatId);
            if (existing && typeof existing === 'object') return normalizeSwitches(existing);
            const preferences = await storageAdapter.get(preferenceKey);
            const switches = { [currentTab.id]: preferences[preferenceKey] !== false };
            await storageAdapter.set({ [keyForChatId(chatId)]: switches });
            changed(chatId);
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
    if(globalThis.cerebrDesktop)return desktopBrowserRequest({type:'UPDATE_WEBPAGE_SWITCHES',chatId,patch:normalizeSwitches(patch)});
    const changes = normalizeSwitches(patch);
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
        // One storage operation keeps the visible selection and future default
        // consistent, including when a save fails.
        await storageAdapter.set({ [keyForChatId(chatId)]: { ...current, ...changes }, ...preferences });
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
