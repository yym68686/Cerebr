import { storageAdapter } from './storage-adapter.js';

const WEBPAGE_SWITCHES_BY_CHAT_PREFIX = 'cerebr_webpage_switches_v1_';
const LEGACY_WEBPAGE_SWITCHES_KEY = 'webpageSwitches';

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

export async function getWebpageSwitchesForChat(chatId) {
    if (!chatId) return {};
    await migrateLegacySwitchesIfNeeded(chatId);
    const key = keyForChatId(chatId);
    const result = await storageAdapter.get(key);
    return normalizeSwitches(result?.[key]);
}

export async function setWebpageSwitchesForChat(chatId, switches) {
    if (!chatId) return false;
    const key = keyForChatId(chatId);
    await storageAdapter.set({ [key]: normalizeSwitches(switches) });
    return true;
}

