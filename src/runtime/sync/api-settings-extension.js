import {
    ensureApiReplica,
    isApiRecord,
    readApiReplica,
    readLegacyApiSettings,
    writeApiReplica,
    projectApiSettingsToLegacy,
} from './api-settings.js';
import { subscribeRemoteChanges } from './replica.js';

export function startApiSettingsExtensionBridge() {
    let queue = ensureApiReplica(),
        timer;
    const expected = new Map();
    const remember = (payload) => {
        for (const [key, value] of Object.entries(payload)) {
            if (!expected.has(key)) expected.set(key, new Set());
            expected.get(key).add(JSON.stringify(value));
        }
    };
    const schedule = (task) => {
        queue = queue
            .catch(() => {})
            .then(task)
            .catch(() => console.error('[Cerebr] Could not synchronize API configuration.'));
    };
    const unsubscribe = subscribeRemoteChanges((keys) => {
        if (keys.some(isApiRecord))
            schedule(async () => projectApiSettingsToLegacy(await readApiReplica(), remember));
    });
    const changed = (changes, area) => {
        if (area !== 'sync') return;
        let external = false;
        for (const [key, change] of Object.entries(changes)) {
            if (
                key !== 'apiConfigs' &&
                key !== 'selectedConfigIndex' &&
                !key.startsWith('apiConfigSystemPrompt')
            )
                continue;
            const encoded = JSON.stringify(change.newValue);
            if (expected.get(key)?.has(encoded)) {
                expected.get(key).delete(encoded);
                continue;
            }
            external = true;
        }
        if (external) {
            clearTimeout(timer);
            timer = setTimeout(
                () =>
                    schedule(async () => {
                        const settings = await readLegacyApiSettings();
                        if (settings) await writeApiReplica(settings.configs, settings.selected);
                    }),
                100
            );
        }
    };
    chrome.storage.onChanged.addListener(changed);
    return () => {
        clearTimeout(timer);
        unsubscribe();
        chrome.storage.onChanged.removeListener(changed);
    };
}
