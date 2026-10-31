import { act } from 'react';
import { createRoot } from 'react-dom/client';
vi.mock('../src/runtime/sync/api-settings.js', () => ({ usesApiReplica: () => false, isApiRecord: () => false }));
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
vi.mock('../src/utils/i18n.js', () => ({ t: (key) => key }));
vi.mock('../src/domain/chat/chat-store.js', () => ({ chatManager: { flushNow: vi.fn(async () => {}) } }));
vi.mock('../src/utils/data-transfer.js', () => ({
    createDataBackupSnapshot: vi.fn(async () => ({ version: 1 })),
    downloadDataBackup: vi.fn(),
    parseDataBackupFile: vi.fn(),
    restoreDataBackup: vi.fn(),
}));
vi.mock('../src/app/state/preferences.js', async () => {
    const { createStore } = await import('../src/app/state/store.js');
    const preferencesStore = createStore({
        theme: 'system',
        language: 'auto',
        fontScale: 1,
        developerMode: false,
    });
    return {
        preferencesStore,
        changePreference: vi.fn(async (key, value) => preferencesStore.set({ [key]: value })),
    };
});
import { ApiSettings } from '../src/app/components/ApiSettings.jsx';
import { Preferences } from '../src/app/components/Preferences.jsx';
import { apiStore, loadApiConfigs, saveApiConfigs } from '../src/app/state/api-configs.js';
import { preferencesStore, changePreference } from '../src/app/state/preferences.js';
import { downloadDataBackup } from '../src/utils/data-transfer.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, back;
beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    for (const key of Object.keys(memory)) delete memory[key];
    memory.apiConfigs = [
        { id: 'a', modelName: 'gpt-5', apiKey: 'test-key', baseUrl: 'https://one.example/v1' },
        { id: 'b', modelName: 'gemini-4-argon', apiKey: '', baseUrl: 'https://two.example/v1' },
    ];
    await loadApiConfigs();
    preferencesStore.set({ theme: 'system', language: 'auto', fontScale: 1, developerMode: false });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    back = vi.fn();
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    await saveApiConfigs();
    apiStore.set({ ready: true, configs: [], modelLists: {} });
    vi.unstubAllGlobals();
});
const click = async (selector) => act(async () => host.querySelector(selector).click());
const fill = async (selector, value) =>
    act(async () => {
        const el = host.querySelector(selector);
        Object.getOwnPropertyDescriptor(
            el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
            'value'
        ).set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });

it('edits a connection independently from the active model and saves all settings', async () => {
    await act(async () => root.render(<ApiSettings visible onBack={back} />));
    expect(host.querySelector('.connection-fields [name="modelName"]')).toBeNull();
    expect(host.querySelector('[name="modelName"]').closest('.connection-advanced-fields').hidden).toBe(true);
    expect(host.querySelector('[name="apiKey"]').type).toBe('password');
    await click('[aria-label="api_show_key"]');
    expect(host.querySelector('[name="apiKey"]').type).toBe('text');
    await click('.connection-disclosure');
    await fill('[name="systemPrompt"]', 'Please be concise.');
    await act(async () => {
        const select = host.querySelector('[name="reasoningEffort"]');
        select.value = 'high';
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('.connection-item:nth-child(2)');
    expect(apiStore.getSnapshot().selected).toBe(0);
    expect(host.querySelector('[name="modelName"]').value).toBe('gemini-4-argon');
    await fill('[name="baseUrl"]', 'https://new.example/v1');
    await act(async () =>
        host.querySelector('[name="baseUrl"]').dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    );
    await click('.connection-editor-footer button');
    expect(apiStore.getSnapshot().selected).toBe(1);
    expect(back).not.toHaveBeenCalled();
    await saveApiConfigs();
    expect(memory.selectedConfigIndex).toBe(1);
    expect(memory.apiConfigs[1].baseUrl).toBe('https://new.example/v1/chat/completions');
    expect(memory.apiConfigs[0].advancedSettings.reasoningEffort).toBe('high');
    expect(memory.apiConfigSystemPrompt_a).toBe('Please be concise.');
});

it('only supplies model name suggestions when discovery succeeded, and permits arbitrary names', async () => {
    await act(async () => {
        apiStore.set({ modelLists: { a: ['gpt-5', 'gpt-5-mini', 'claude-test'] } });
        root.render(<ApiSettings visible onBack={back} />);
    });
    await click('.connection-disclosure');
    await act(async () => host.querySelector('[name="modelName"]').focus());
    expect([...host.querySelectorAll('[role="option"]')].map(node => node.textContent)).toEqual(['gpt-5', 'gpt-5-mini']);
    await fill('[name="modelName"]', 'MINI');
    expect([...host.querySelectorAll('[role="option"]')].map(node => node.textContent)).toEqual(['gpt-5-mini']);
    await click('[role="option"]');
    expect(host.querySelector('[name="modelName"]').value).toBe('gpt-5-mini');
    await fill('[name="modelName"]', 'private-model');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    await act(async () => host.querySelector('[name="modelName"]').blur());
    expect(apiStore.getSnapshot().defaultSelection.modelName).toBe('private-model');
    await click('.connection-item:nth-child(2)');
    await click('.connection-disclosure');
    await act(async () => host.querySelector('[name="modelName"]').focus());
    await fill('[name="modelName"]', 'manual-only');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(host.querySelector('[name="modelName"]').hasAttribute('aria-expanded')).toBe(false);
    await saveApiConfigs();
    expect(memory.apiConfigs[1].modelName).toBe('manual-only');
});

it('keeps reasoning settings available for an automatically selected GPT model', async () => {
    await act(async () => {
        apiStore.set({
            configs: [{...apiStore.getSnapshot().configs[0],modelName:''}],
            modelLists:{a:['gpt-discovered']},defaultSelection:{configId:'a',modelName:'gpt-discovered'},
        });
        root.render(<ApiSettings visible onBack={back} />);
    });
    await click('.connection-disclosure');
    expect(host.querySelector('[name="reasoningEffort"]')).not.toBeNull();
    expect(host.querySelector('[name="modelName"]').value).toBe('');
});

it('adds, duplicates and deletes connections without discarding the original configuration', async () => {
    await act(async () => root.render(<ApiSettings visible onBack={back} />));
    await click('[aria-label="api_add_connection"]');
    expect(apiStore.getSnapshot().configs).toHaveLength(3);
    await fill('[name="modelName"]', 'new-model');
    await click('[aria-label="api_duplicate_config_aria"]');
    expect(apiStore.getSnapshot().configs).toHaveLength(4);
    expect(host.querySelector('[name="modelName"]').value).toBe('new-model');
    await click('[aria-label="api_delete_config_aria"]');
    expect(apiStore.getSnapshot().configs).toHaveLength(3);
    expect(apiStore.getSnapshot().configs[0].apiKey).toBe('test-key');
});

it('updates appearance and developer settings and exports after saving the draft', async () => {
    const saveDraft = vi.fn(async () => {});
    await act(async () => root.render(<Preferences visible onBack={back} saveDraft={saveDraft} />));
    await click('.theme-choice:nth-child(2)');
    expect(changePreference).toHaveBeenCalledWith('theme', 'dark');
    expect(host.querySelector('.theme-choice:nth-child(2)').getAttribute('aria-checked')).toBe('true');
    await click('.settings-segmented button:nth-child(3)');
    expect(changePreference).toHaveBeenCalledWith('fontScale', 1.1);
    await click('#preferences-developer-mode');
    expect(changePreference).toHaveBeenCalledWith('developerMode', true);
    await act(async () => {
        const select = host.querySelector('#preferences-language');
        select.value = 'en';
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(changePreference).toHaveBeenCalledWith('language', 'en');
    await click('#preferences-export-data');
    expect(saveDraft).toHaveBeenCalledOnce();
    expect(downloadDataBackup).toHaveBeenCalledWith({ version: 1 });
    expect(host.querySelectorAll('.preferences-links a')).toHaveLength(3);
});
