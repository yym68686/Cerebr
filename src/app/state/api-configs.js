import { storageAdapter, syncStorageAdapter, isExtensionEnvironment } from '../../utils/storage-adapter.js';
import { normalizeChatCompletionsUrl } from '../../utils/api-url.js';
import { normalizeReasoningEffort } from '../../utils/reasoning-effort.js';
import { createStore } from './store.js';
import { notify } from './ui-store.js';
import { usesApiReplica, readApiReplica, writeApiReplica, projectApiSettingsToLegacy, isApiRecord } from '../../runtime/sync/api-settings.js';
import { subscribeRemoteChanges } from '../../runtime/sync/replica.js';
import { readModelPreferences, writeDefaultModel } from '../../runtime/sync/model-preferences.js';
import { configModelSelection, resolveChatApiConfig } from '../../domain/chat/model-selection.js';
import { fetchModelNames } from '../../runtime/chat/model-catalog.js';

const metaKeys = ['apiConfigs', 'selectedConfigIndex'];
const promptKey = (id) => `apiConfigSystemPrompt_${id}`;
const localKey = (id) => `apiConfigSystemPromptLocalOnly_${id}`;
const metadataStorage = isExtensionEnvironment ? syncStorageAdapter : storageAdapter;
export const apiStore = createStore({ configs: [], selected: 0, ready: false, modelLists: {} });

// Catalogs stay in memory, separate from saved/synced API configuration. Changing
// credentials invalidates the old list immediately and cancels its request.
const modelRequests = new Map();
apiStore.subscribe(() => {
    const state = apiStore.getSnapshot();
    if (!state.ready) return;
    let modelLists = state.modelLists;
    const clear = id => {
        if (!Object.hasOwn(modelLists, id)) return;
        modelLists = { ...modelLists };
        delete modelLists[id];
    };
    for (const [id, entry] of modelRequests) {
        const config = state.configs.find(config => config.id === id);
        if (config?.baseUrl === entry.baseUrl && config?.apiKey === entry.apiKey) continue;
        clearTimeout(entry.timer);
        clearTimeout(entry.timeout);
        entry.controller.abort();
        modelRequests.delete(id);
        clear(id);
    }
    for (const config of state.configs) {
        if (modelRequests.has(config.id) || !config.baseUrl || !config.apiKey.trim()) continue;
        const entry = { baseUrl: config.baseUrl, apiKey: config.apiKey, controller: new AbortController() };
        modelRequests.set(config.id, entry);
        entry.timer = setTimeout(async () => {
            entry.timeout = setTimeout(() => entry.controller.abort(), 10000);
            const models = await fetchModelNames(config, entry.controller.signal);
            clearTimeout(entry.timeout);
            if (modelRequests.get(config.id) !== entry) return;
            apiStore.set(s => ({ ...s, modelLists: { ...s.modelLists, [config.id]: models } }));
        }, 350);
    }
    if (modelLists !== state.modelLists) apiStore.set({ modelLists });
});
export function normalizeConfig(config = {}) {
    return {
        ...config,
        id: config.id || crypto.randomUUID(),
        apiKey: config.apiKey ?? '',
        baseUrl: normalizeChatCompletionsUrl(config.baseUrl ?? 'https://api.0-0.pro/v1/chat/completions'),
        modelName: config.modelName ?? '',
        advancedSettings: {
            ...config.advancedSettings,
            systemPrompt: config.advancedSettings?.systemPrompt ?? '',
            reasoningEffort: normalizeReasoningEffort(config.advancedSettings?.reasoningEffort),
            isExpanded: !!config.advancedSettings?.isExpanded,
        },
    };
}
export async function loadApiConfigs() {
    if(usesApiReplica()) {
        const shared=await readApiReplica();
        if(shared){apiStore.set({...shared,configs:shared.configs.map(normalizeConfig),ready:true});return;}
    }
    let meta = await metadataStorage.get(metaKeys);
    if (!isExtensionEnvironment && !meta.apiConfigs) {
        const previous = await syncStorageAdapter.get(metaKeys);
        if (previous.apiConfigs) {
            meta = previous;
            await metadataStorage.set(meta);
        }
    }
    const configs = (meta.apiConfigs?.length ? meta.apiConfigs : [{}]).map(normalizeConfig);
    const keys = configs.flatMap((c) => [promptKey(c.id), localKey(c.id)]);
    const local = await storageAdapter.get(keys);
    const synced = isExtensionEnvironment ? await syncStorageAdapter.get(keys) : {};
    for (const config of configs) {
        const key = promptKey(config.id);
        const onlyLocal = !!synced[localKey(config.id)];
        config.advancedSettings.systemPrompt =
            (!onlyLocal && typeof synced[key] === 'string' ? synced[key] : local[key]) ??
            config.advancedSettings.systemPrompt;
        config.advancedSettings.systemPromptLocalOnly = onlyLocal;
    }
    const preferences = await readModelPreferences(meta.apiConfigs?.length ? configs[Math.max(0, Math.min(Number(meta.selectedConfigIndex) || 0, configs.length - 1))] : undefined);
    apiStore.set({
        configs,
        ...preferences,
        selected: preferences.defaultSelection ? configs.findIndex(config => config.id === preferences.defaultSelection.configId) : 0,
        ready: true,
    });
}
let timer;
let dirty = false;
const dirtyIds = new Set(), removedIds = new Set();
let saveChain = Promise.resolve();
export function saveApiConfigs() {
    clearTimeout(timer);
    if (!dirty) return saveChain;
    dirty = false;
    const { configs, selected } = apiStore.getSnapshot();
    const snapshot = structuredClone(configs);
    const changed = [...dirtyIds], removed = [...removedIds];
    dirtyIds.clear(); removedIds.clear();
    saveChain = saveChain
        .catch(() => {})
        .then(async () => {
            if(usesApiReplica()) {
                await writeApiReplica(snapshot,undefined,{changedIds:changed,removedIds:removed});
                await projectApiSettingsToLegacy(await readApiReplica());
                return;
            }
            const prompts = {},
                syncPrompts = {};
            for (const config of snapshot) {
                const prompt = config.advancedSettings.systemPrompt;
                prompts[promptKey(config.id)] = prompt;
                const localOnly = new TextEncoder().encode(prompt).length > 6000;
                syncPrompts[promptKey(config.id)] = localOnly ? '' : prompt;
                syncPrompts[localKey(config.id)] = localOnly;
            }
            await storageAdapter.set(prompts);
            const payload = {
                apiConfigs: snapshot.map((c) => {
                    const copy = structuredClone(c);
                    delete copy.advancedSettings.systemPrompt;
                    return copy;
                }),
                selectedConfigIndex: selected,
            };
            await metadataStorage.set(payload);
            if (isExtensionEnvironment) {
                try {
                    await syncStorageAdapter.set(syncPrompts);
                } catch (error) {
                    if (!/kQuotaBytesPerItem|QuotaExceeded/.test(String(error?.message))) throw error;
                    const fallback = {};
                    for (const config of snapshot) {
                        fallback[promptKey(config.id)] = '';
                        fallback[localKey(config.id)] = true;
                    }
                    await syncStorageAdapter.set(fallback);
                }
            }
        });
    return saveChain;
}
export function changeConfig(id, patch) {
    dirty = true;
    dirtyIds.add(id);
    apiStore.set((s) => ({
        ...s,
        configs: s.configs.map((c) =>
            c.id === id
                ? { ...c, ...patch, advancedSettings: { ...c.advancedSettings, ...patch.advancedSettings } }
                : c
        ),
    }));
    clearTimeout(timer);
    timer = setTimeout(() => saveApiConfigs().catch((e) => notify(e.message, { type: 'error' })), 500);
}
export function selectConfig(index, modelName) {
    const state = apiStore.getSnapshot();
    const config = state.configs[index];
    if (!config) return Promise.resolve();
    const selection = configModelSelection(config, state, modelName);
    apiStore.set({ selected: index, defaultSelection: selection });
    // Selection alone must not rewrite every API record or publish a shared
    // selection revision. Only explicit configuration edits belong in sync.
    return writeDefaultModel({ ...config, modelName: selection.modelName }).then(async () => {
        await storageAdapter.set({ selectedConfigIndex: index });
        await saveApiConfigs();
    });
}
export function duplicateConfig(index) {
    dirty = true;
    const config = { ...structuredClone(apiStore.getSnapshot().configs[index]), id: crypto.randomUUID() };
    dirtyIds.add(config.id);
    apiStore.set((s) => ({
        ...s,
        configs: [...s.configs, config],
    }));
    return saveApiConfigs();
}
export async function addConfig() {
    const config = normalizeConfig({ baseUrl: '', modelName: '' });
    dirty = true;
    dirtyIds.add(config.id);
    apiStore.set((s) => ({ ...s, configs: [...s.configs, config] }));
    await saveApiConfigs();
    return config.id;
}
export function deleteConfig(index) {
    if (apiStore.getSnapshot().configs.length <= 1) return Promise.resolve();
    dirty = true;
    const removed = apiStore.getSnapshot().configs[index];
    removedIds.add(removed.id); dirtyIds.delete(removed.id);
    apiStore.set((s) => ({
        ...s,
        configs: s.configs.length > 1 ? s.configs.filter((_, i) => i !== index) : [normalizeConfig()],
        selected: s.selected > index ? s.selected - 1 : s.selected === index ? -1 : s.selected,
    }));
    return saveApiConfigs();
}
export function getSelectedApiConfig(chat) {
    return resolveChatApiConfig(chat, apiStore.getSnapshot());
}
let remoteRefresh=Promise.resolve();
subscribeRemoteChanges(keys=>{
    if(!usesApiReplica()||!keys.some(isApiRecord))return;
    remoteRefresh=remoteRefresh.catch(()=>{}).then(async()=>{await saveApiConfigs();await loadApiConfigs();}).catch(()=>notify('API configuration could not be synchronized.',{type:'error'}));
});
