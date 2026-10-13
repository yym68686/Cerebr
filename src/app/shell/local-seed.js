import { storageAdapter, syncStorageAdapter, isExtensionEnvironment } from '../../utils/storage-adapter.js';
import { applyMcpSeed } from '../../mcp/mcp-config.js';

/**
 * One-time import of a private, git-ignored "cerebr.local.json" shipped next to manifest.json.
 * Optional user-owned JSON configuration. Each seedVersion is applied once; API cards with
 * the same id are replaced, other cards and existing MCP servers are kept.
 */
const SEED_FILE = 'cerebr.local.json';
const SEED_MARKER_KEY = 'cerebrLocalSeedVersion';
const DEFAULT_PLACEHOLDER_BASE_URL = 'https://api.0-0.pro/v1/chat/completions';

let seedCheckPromise = null;

function isUntouchedPlaceholder(config) {
    return !String(config?.apiKey || '').trim()
        && (!config?.baseUrl || config.baseUrl === DEFAULT_PLACEHOLDER_BASE_URL);
}

async function readSeed() {
    if (!isExtensionEnvironment || !chrome?.runtime?.getURL) return null;
    try {
        const response = await fetch(chrome.runtime.getURL(SEED_FILE), { cache: 'no-store' });
        if (!response.ok) return null;
        const seed = await response.json();
        return seed && typeof seed === 'object' && seed.seedVersion ? seed : null;
    } catch {
        return null;
    }
}

async function applySeed(deps) {
    const seed = await readSeed();
    if (!seed) return false;
    const version = String(seed.seedVersion);
    const marker = await storageAdapter.get(SEED_MARKER_KEY);
    if (marker?.[SEED_MARKER_KEY] === version) return false;

    if (Array.isArray(seed.apiConfigs) && seed.apiConfigs.length > 0) {
        const meta = await deps.readApiConfigMeta();
        const existing = (Array.isArray(meta?.apiConfigs) ? meta.apiConfigs : [])
            .filter((config) => !isUntouchedPlaceholder(config));
        const seedConfigs = seed.apiConfigs.map((config) => deps.normalizeApiConfig(config));
        const seedIds = new Set(seedConfigs.map((config) => config.id));
        const merged = [...seedConfigs, ...existing.filter((config) => !seedIds.has(config.id))];
        const selectedIndex = Math.max(0, merged.findIndex((config) => config.id === seed.selectedConfigId));

        const promptPayload = {};
        seedConfigs.forEach((config) => {
            promptPayload[deps.getSystemPromptKey(config.id)] = config.advancedSettings?.systemPrompt ?? '';
        });
        await storageAdapter.set(promptPayload);
        await deps.writeApiConfigMeta({
            apiConfigs: merged.map(deps.stripApiConfigForSync),
            selectedConfigIndex: selectedIndex,
        });
    }

    if (seed.mcp && typeof seed.mcp === 'object') {
        await applyMcpSeed(seed.mcp);
    }

    const preferences = {};
    if (['zh_CN', 'zh_TW', 'en', 'auto'].includes(seed.preferences?.uiLanguage)) {
        preferences.uiLanguage = seed.preferences.uiLanguage;
    }
    if (['light', 'dark', 'system'].includes(seed.preferences?.theme)) {
        preferences.theme = seed.preferences.theme;
    }
    if (Object.keys(preferences).length) await syncStorageAdapter.set(preferences);

    await storageAdapter.set({ [SEED_MARKER_KEY]: version });
    console.info('[Cerebr] Applied local seed', version);
    return true;
}

export function applyLocalSeedIfNeeded(deps) {
    if (!seedCheckPromise) {
        seedCheckPromise = applySeed(deps).catch((error) => {
            console.error('[Cerebr] Failed to apply local seed', error);
            return false;
        });
    }
    return seedCheckPromise;
}
