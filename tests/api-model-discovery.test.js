import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({}));
vi.mock('../src/utils/storage-adapter.js', () => {
    const adapter = {
        get: async (keys) =>
            Object.fromEntries(
                (Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(memory[key])])
            ),
        set: async (values) => Object.assign(memory, structuredClone(values)),
    };
    return { isExtensionEnvironment: false, storageAdapter: adapter, syncStorageAdapter: adapter };
});
vi.mock('../src/runtime/sync/api-settings.js', () => ({
    usesApiReplica: () => false,
    isApiRecord: () => false,
}));
vi.mock('../src/app/state/ui-store.js', () => ({ notify: vi.fn() }));
import {
    apiStore,
    normalizeConfig,
    changeConfig,
    saveApiConfigs,
    selectConfig,
    loadApiConfigs,
} from '../src/app/state/api-configs.js';
import { notify } from '../src/app/state/ui-store.js';
import { getChatModelSelection, resolveChatApiConfig } from '../src/domain/chat/model-selection.js';

const config = () =>
    normalizeConfig({ id: 'auto', baseUrl: 'https://auto.test/v1', apiKey: 'test-key', modelName: '' });
beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    for (const key of Object.keys(memory)) delete memory[key];
    apiStore.set({
        configs: [],
        ready: true,
        modelLists: {},
        selected: 0,
        defaultSelection: null,
        legacySelection: null,
    });
});
afterEach(async () => {
    await saveApiConfigs();
    apiStore.set({ configs: [], modelLists: {} });
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
const data = (models) => new Response(JSON.stringify({ data: models.map((id) => ({ id })) }));

it('automatically discovers models without a model name, and saves choices separately from the config', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => data(['first', 'second']))
    );
    apiStore.set({ configs: [config()] });
    await vi.advanceTimersByTimeAsync(350);
    expect(apiStore.getSnapshot().modelLists.auto).toEqual(['first', 'second']);
    expect(getChatModelSelection(null, apiStore.getSnapshot())).toEqual({
        configId: 'auto',
        modelName: 'first',
    });
    await selectConfig(0, 'second');
    expect(getChatModelSelection(null, apiStore.getSnapshot())).toEqual({
        configId: 'auto',
        modelName: 'second',
    });
    expect(apiStore.getSnapshot().configs[0].modelName).toBe('');
    changeConfig('auto', { advancedSettings: { systemPrompt: 'test' } });
    await saveApiConfigs();
    expect(memory.apiConfigs[0].modelName).toBe('');
    expect(JSON.stringify(memory)).not.toContain('modelLists');
    await loadApiConfigs();
    expect(resolveChatApiConfig(null, apiStore.getSnapshot()).modelName).toBe('second');
    expect(fetch).toHaveBeenCalledTimes(1);
});

it('debounces URL/key edits and never applies results from old credentials', async () => {
    let oldResponse;
    const fetch = vi
        .fn()
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    oldResponse = resolve;
                })
        )
        .mockImplementation(async () => data(['fresh']));
    vi.stubGlobal('fetch', fetch);
    apiStore.set({ configs: [config()] });
    await vi.advanceTimersByTimeAsync(350);
    const oldSignal = fetch.mock.calls[0][1].signal;
    changeConfig('auto', { apiKey: 'new-' });
    await vi.advanceTimersByTimeAsync(200);
    changeConfig('auto', { apiKey: 'new-key' });
    expect(oldSignal.aborted).toBe(true);
    expect(apiStore.getSnapshot().modelLists.auto).toBeUndefined();
    oldResponse(data(['stale']));
    await vi.advanceTimersByTimeAsync(350);
    expect(apiStore.getSnapshot().modelLists.auto).toEqual(['fresh']);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer new-key');
    apiStore.set({ configs: [] });
    expect(apiStore.getSnapshot().modelLists.auto).toBeUndefined();
});

it('does not request incomplete connections and silently handles failure and timeout', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('not supported', { status: 404 }))
    );
    apiStore.set({ configs: [{ ...config(), apiKey: '' }] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).not.toHaveBeenCalled();
    changeConfig('auto', { apiKey: 'test-key' });
    await vi.advanceTimersByTimeAsync(350);
    expect(apiStore.getSnapshot().modelLists.auto).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    vi.stubGlobal(
        'fetch',
        vi.fn(
            (url, { signal }) =>
                new Promise((resolve, reject) =>
                    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
                )
        )
    );
    changeConfig('auto', { apiKey: 'timeout-test' });
    await vi.advanceTimersByTimeAsync(10350);
    expect(apiStore.getSnapshot().modelLists.auto).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
});
