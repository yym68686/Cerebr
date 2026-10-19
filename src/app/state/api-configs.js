import { storageAdapter, syncStorageAdapter, isExtensionEnvironment } from '../../utils/storage-adapter.js';
import { normalizeChatCompletionsUrl } from '../../utils/api-url.js';
import { normalizeReasoningEffort } from '../../utils/reasoning-effort.js';
import { createStore } from './store.js';
import { notify } from './ui-store.js';
import { usesApiReplica, readApiReplica, writeApiReplica, projectApiSettingsToLegacy, isApiRecord } from '../../runtime/sync/api-settings.js';
import { subscribeRemoteChanges } from '../../runtime/sync/replica.js';

const metaKeys = ['apiConfigs', 'selectedConfigIndex'];
const promptKey = (id) => `apiConfigSystemPrompt_${id}`;
const localKey = (id) => `apiConfigSystemPromptLocalOnly_${id}`;
const metadataStorage = isExtensionEnvironment ? syncStorageAdapter : storageAdapter;
export const apiStore = createStore({ configs: [], selected: 0, ready: false });
export function normalizeConfig(config = {}) {
    return {
        ...config,
        id: config.id || crypto.randomUUID(),
        apiKey: config.apiKey ?? '',
        baseUrl: normalizeChatCompletionsUrl(config.baseUrl ?? 'https://api.0-0.pro/v1/chat/completions'),
        modelName: config.modelName ?? 'gpt-4o',
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
        if(shared){apiStore.set({configs:shared.configs.map(normalizeConfig),selected:shared.selected,ready:true});return;}
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
    apiStore.set({
        configs,
        selected: Math.max(0, Math.min(Number(meta.selectedConfigIndex) || 0, configs.length - 1)),
        ready: true,
    });
}
let timer;
let dirty = false;
let saveChain = Promise.resolve();
export function saveApiConfigs() {
    clearTimeout(timer);
    if (!dirty) return saveChain;
    dirty = false;
    const { configs, selected } = apiStore.getSnapshot();
    const snapshot = structuredClone(configs);
    saveChain = saveChain
        .catch(() => {})
        .then(async () => {
            if(usesApiReplica()) {
                await writeApiReplica(snapshot,selected);
                await projectApiSettingsToLegacy({configs:snapshot,selected});
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
export function selectConfig(index) {
    dirty = true;
    apiStore.set({ selected: index });
    return saveApiConfigs();
}
export function duplicateConfig(index) {
    dirty = true;
    apiStore.set((s) => ({
        ...s,
        configs: [...s.configs, { ...structuredClone(s.configs[index]), id: crypto.randomUUID() }],
    }));
    return saveApiConfigs();
}
export async function addConfig() {
    const config = normalizeConfig({ baseUrl: '', modelName: '' });
    dirty = true;
    apiStore.set((s) => ({ ...s, configs: [...s.configs, config] }));
    await saveApiConfigs();
    return config.id;
}
export function deleteConfig(index) {
    if (apiStore.getSnapshot().configs.length <= 1) return Promise.resolve();
    dirty = true;
    apiStore.set((s) => ({
        ...s,
        configs: s.configs.length > 1 ? s.configs.filter((_, i) => i !== index) : [normalizeConfig()],
        selected: Math.max(0, s.selected > index ? s.selected - 1 : s.selected === index ? 0 : s.selected),
    }));
    return saveApiConfigs();
}
export function getSelectedApiConfig() {
    const s = apiStore.getSnapshot();
    return s.configs[s.selected];
}
let remoteRefresh=Promise.resolve();
subscribeRemoteChanges(keys=>{
    if(!usesApiReplica()||!keys.some(isApiRecord))return;
    remoteRefresh=remoteRefresh.catch(()=>{}).then(async()=>{await saveApiConfigs();await loadApiConfigs();}).catch(()=>notify('API configuration could not be synchronized.',{type:'error'}));
});
