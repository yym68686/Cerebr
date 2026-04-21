import { syncStorageAdapter, isExtensionEnvironment } from '../../utils/storage-adapter.js';

export const DEVELOPER_MODE_STORAGE_KEY = 'pluginDeveloperMode';

function getLocalStorageKey() {
    return `sync_${DEVELOPER_MODE_STORAGE_KEY}`;
}

export async function readDeveloperModePreference() {
    try {
        const result = await syncStorageAdapter.get(DEVELOPER_MODE_STORAGE_KEY);
        return !!result?.[DEVELOPER_MODE_STORAGE_KEY];
    } catch (error) {
        console.error('[Cerebr] Failed to read developer mode preference', error);
        return false;
    }
}

export async function writeDeveloperModePreference(enabled) {
    await syncStorageAdapter.set({
        [DEVELOPER_MODE_STORAGE_KEY]: !!enabled,
    });
    return !!enabled;
}

export function subscribeDeveloperModePreference(callback) {
    if (typeof callback !== 'function') {
        return () => {};
    }

    if (isExtensionEnvironment && chrome?.storage?.onChanged) {
        const handleStorageChange = (changes, areaName) => {
            if (areaName !== 'sync' || !changes?.[DEVELOPER_MODE_STORAGE_KEY]) {
                return;
            }

            callback(!!changes[DEVELOPER_MODE_STORAGE_KEY].newValue);
        };

        chrome.storage.onChanged.addListener(handleStorageChange);
        return () => chrome.storage.onChanged.removeListener(handleStorageChange);
    }

    const storageKey = getLocalStorageKey();
    const handleStorage = (event) => {
        if (event.key !== storageKey) return;

        try {
            callback(!!JSON.parse(event.newValue || 'false'));
        } catch (error) {
            console.error('[Cerebr] Failed to parse developer mode storage event', error);
        }
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
}
