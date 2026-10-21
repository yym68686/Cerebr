import {
    getDb,
    storageAdapter,
    syncStorageAdapter,
    isExtensionEnvironment,
} from '../../utils/storage-adapter.js';
import { API_CONFIG_PREFIX, API_SELECTION } from './protocol.js';
import { replicaRecord, replicaRecordsWithPrefix, seedReplica, writeLocal } from './replica.js';
import { readModelPreferences, writeDefaultModel } from './model-preferences.js';

const marker = 'cerebr_api_replica_initialized_v1';
const promptKey = (id) => `apiConfigSystemPrompt_${id}`;
const onlyLocalKey = (id) => `apiConfigSystemPromptLocalOnly_${id}`;
const seeds = new WeakMap();
const req = (request) =>
    new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
const complete = (tx) =>
    new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
    });
export const usesApiReplica = () => true;
export const isApiRecord = (key) => key === API_SELECTION || key.startsWith(API_CONFIG_PREFIX);
function sharedConfig(config) {
    const result = {
        ...structuredClone(config),
        apiKey: config.apiKey ?? '',
        baseUrl: config.baseUrl ?? '',
        modelName: config.modelName ?? '',
        advancedSettings: {
            ...config.advancedSettings,
            systemPrompt: config.advancedSettings?.systemPrompt ?? '',
        },
    };
    delete result.advancedSettings.isExpanded;
    delete result.advancedSettings.systemPromptLocalOnly;
    return result;
}
export async function readLegacyApiSettings() {
    const metadata = isExtensionEnvironment ? syncStorageAdapter : storageAdapter;
    let saved = await metadata.get(['apiConfigs', 'selectedConfigIndex']);
    if (!isExtensionEnvironment && !saved.apiConfigs)
        saved = await syncStorageAdapter.get(['apiConfigs', 'selectedConfigIndex']);
    if (!Array.isArray(saved.apiConfigs) || !saved.apiConfigs.length) return null;
    const configs = saved.apiConfigs.map((config) =>
        sharedConfig({ ...config, id: config.id || crypto.randomUUID() })
    );
    const keys = configs.flatMap((config) => [promptKey(config.id), onlyLocalKey(config.id)]);
    const [local, synced] = await Promise.all([
        storageAdapter.get(keys),
        isExtensionEnvironment ? syncStorageAdapter.get(keys) : {},
    ]);
    for (const config of configs)
        config.advancedSettings.systemPrompt =
            (!synced[onlyLocalKey(config.id)] && typeof synced[promptKey(config.id)] === 'string'
                ? synced[promptKey(config.id)]
                : local[promptKey(config.id)]) ?? config.advancedSettings.systemPrompt;
    return {
        configs,
        selected: Math.max(0, Math.min(Number(saved.selectedConfigIndex) || 0, configs.length - 1)),
    };
}
export async function ensureApiReplica(db) {
    db ||= await getDb();
    if (!seeds.has(db))
        seeds.set(
            db,
            (async () => {
                const initial = await readLegacyApiSettings();
                // Capture the device's choice BEFORE cloud/local bridge records
                // arrive. Importing API settings is not a model-switch action.
                await readModelPreferences(initial?.configs[initial.selected]);
                if (await req(db.transaction('keyValueStore').objectStore('keyValueStore').get(marker)))
                    return;
                const tx = db.transaction('keyValueStore', 'readwrite'),
                    done = complete(tx),
                    store = tx.objectStore('keyValueStore');
                const created = [];
                if (!(await req(store.get(marker)))) {
                    for (const [order, config] of (initial?.configs || []).entries()) {
                        const key = API_CONFIG_PREFIX + config.id;
                        if (!(await req(store.get(key)))) {
                            store.put({ config, order }, key);
                            created.push(key);
                        }
                    }
                    store.put(true, marker);
                }
                await done;
                // Baseline versions allow two existing installations to merge config IDs.
                // An untouched placeholder is never seeded, and cannot replace real APIs.
                await seedReplica(db, created);
            })().catch((error) => {
                seeds.delete(db);
                throw error;
            })
        );
    return seeds.get(db);
}
export async function readApiReplica() {
    const db = await getDb();
    await ensureApiReplica(db);
    const records = (await replicaRecordsWithPrefix(db, API_CONFIG_PREFIX)).filter(
        (record) => !record.deleted
    );
    records.sort((a, b) => (a.value.order ?? 0) - (b.value.order ?? 0) || a.key.localeCompare(b.key));
    if (!records.length) return null;
    const configs = records.map((record) => record.value.config);
    // The old shared selection is only a bootstrap hint for an empty device.
    // It never overrides an existing local choice, even on manual sync.
    const selectedId = (await replicaRecord(db, API_SELECTION))?.value;
    const preferences = await readModelPreferences(configs.find(config => config.id === selectedId) || configs[0]);
    return {
        configs,
        ...preferences,
        selected: configs.findIndex(config => config.id === preferences.defaultSelection?.configId),
    };
}
export async function writeApiReplica(configs, selected, { changedIds, removedIds } = {}) {
    const db = await getDb();
    await ensureApiReplica(db);
    const values = Object.fromEntries(
        configs.flatMap((config, order) => changedIds && !changedIds.includes(config.id) ? [] : [[
            API_CONFIG_PREFIX + config.id,
            { config: sharedConfig(config), order },
        ]])
    );
    const records = await replicaRecordsWithPrefix(db, API_CONFIG_PREFIX);
    const removed = removedIds ? removedIds.map(id => API_CONFIG_PREFIX + id) : records
        .filter((record) => !record.deleted && !Object.hasOwn(values, record.key))
        .map((record) => record.key);
    await writeLocal(db, values, removed);
    if (configs[selected]) await writeDefaultModel(configs[selected]);
}

// Preserve the existing Chrome-sync representation for other extension installs.
export async function projectApiSettingsToLegacy(settings, beforeSyncWrite = () => {}) {
    if (!settings) return;
    const { configs, selected } = settings;
    const prompts = Object.fromEntries(
        configs.map((config) => [promptKey(config.id), config.advancedSettings.systemPrompt])
    );
    await storageAdapter.set(prompts);
    const metadata = {
        apiConfigs: configs.map((config) => {
            const copy = structuredClone(config);
            delete copy.advancedSettings.systemPrompt;
            return copy;
        }),
    };
    if (!isExtensionEnvironment) {
        await storageAdapter.set({ ...metadata, selectedConfigIndex: selected });
        return;
    }
    await storageAdapter.set({ selectedConfigIndex: selected });
    const syncPrompts = {};
    for (const config of configs) {
        const prompt = config.advancedSettings.systemPrompt;
        const localOnly = new TextEncoder().encode(prompt).length > 6000;
        syncPrompts[promptKey(config.id)] = localOnly ? '' : prompt;
        syncPrompts[onlyLocalKey(config.id)] = localOnly;
    }
    const payload = { ...metadata, ...syncPrompts };
    beforeSyncWrite(payload);
    await syncStorageAdapter.set(payload);
}
