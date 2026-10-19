import { createStore } from './store.js';
import { syncStorageAdapter, browserAdapter } from '../../utils/storage-adapter.js';
import { applyThemePreference, normalizeThemePreference } from '../../utils/theme.js';
import { getLanguagePreference, setLanguagePreference, reloadI18n } from '../../utils/i18n.js';
import {
    readDeveloperModePreference,
    writeDeveloperModePreference,
} from '../../plugin/dev/developer-mode.js';
import { SITE_KEY_PLUS, getSiteKeyFromHostname, pruneSiteOverridesInPlace } from '../../platform/site-key.js';
import { chatManager } from '../../domain/chat/chat-store.js';
import {
    isDefaultChat,
    syncDefaultChatForLocale,
    resolveDefaultChatLocale,
} from '../../utils/default-chat.js';

export const preferencesStore = createStore({
    theme: 'system',
    language: 'auto',
    fontScale: 1,
    developerMode: false,
});
let siteKey = null;
function applyFontScale(scale) {
    for (const px of [12, 13, 14, 16])
        document.documentElement.style.setProperty(
            `--cerebr-fs-${px}`,
            `${Math.round(px * scale * 10) / 10}px`
        );
}
export async function loadPreferences() {
    const [settings, language, developerMode, tab] = await Promise.all([
        syncStorageAdapter.get(['theme', 'fontScale', 'panelSiteOverridesV1']),
        getLanguagePreference(),
        readDeveloperModePreference(),
        browserAdapter.getCurrentTab().catch(() => null),
    ]);
    siteKey = getSiteKeyFromHostname(tab?.hostname, SITE_KEY_PLUS);
    const oldKey = getSiteKeyFromHostname(tab?.hostname, 1);
    const scale = Number(
        settings.panelSiteOverridesV1?.[siteKey]?.fontScale ??
            settings.panelSiteOverridesV1?.[oldKey]?.fontScale ??
            settings.fontScale ??
            1
    );
    const fontScale = [0.9, 1, 1.1, 1.2].includes(scale) ? scale : 1;
    const theme = normalizeThemePreference(settings.theme);
    applyThemePreference(theme);
    applyFontScale(fontScale);
    preferencesStore.set({ theme, language, fontScale, developerMode });
}
export async function changePreference(key, value) {
    if (key === 'theme') {
        applyThemePreference(value);
        await syncStorageAdapter.set({ theme: value });
    }
    if (key === 'fontScale') {
        value = Number(value);
        applyFontScale(value);
        if (siteKey) {
            const data = await syncStorageAdapter.get('panelSiteOverridesV1');
            const overrides = data.panelSiteOverridesV1 || {};
            overrides[siteKey] = { ...overrides[siteKey], fontScale: value, updatedAt: Date.now() };
            pruneSiteOverridesInPlace(overrides);
            await syncStorageAdapter.set({ panelSiteOverridesV1: overrides });
        } else await syncStorageAdapter.set({ fontScale: value });
    }
    if (key === 'developerMode') await writeDeveloperModePreference(value);
    if (key === 'language') {
        await setLanguagePreference(value);
        await reloadI18n();
        await syncLocalizedChats();
    }
    preferencesStore.set({ [key]: value });
}

export async function syncLocalizedChats() {
    const locale = await resolveDefaultChatLocale();
    let changed = false;
    for (const chat of chatManager.getAllChats()) {
        if (
            isDefaultChat(chat) &&
            syncDefaultChatForLocale(chat, locale, { insertSeedsWhenEmpty: !chat.messages.length })
        ) {
            chatManager.markChatDirty(chat.id, { touchUpdatedAt: false });
            changed = true;
        }
    }
    if (changed) await chatManager.saveChats({ touchCurrentChat: false });
}
