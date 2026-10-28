import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const data = vi.hoisted(() => ({ memory: {} }));
vi.mock('../src/utils/storage-adapter.js', () => {
    const storage = {
        get: async (keys) =>
            Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, data.memory[key]])),
    };
    return { storageAdapter: storage, syncStorageAdapter: storage };
});

import { getActiveLocale, initI18n, reloadI18n, t } from '../src/utils/i18n.js';
import { mountPageSelectionActions } from '../src/host/content/page-selection-actions.jsx';

const labels = { en: 'Selection actions', zh_CN: '划词操作', zh_TW: '劃詞操作' };
let originalLang, unmount;
const setPageLanguage = (lang) => {
    if (lang === null) document.documentElement.removeAttribute('lang');
    else document.documentElement.setAttribute('lang', lang);
};

beforeEach(() => {
    originalLang = document.documentElement.getAttribute('lang');
    unmount = null;
    data.memory = { uiLanguage: 'zh_CN' };
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('chrome', {
        runtime: {
            getManifest: () => ({ background: { service_worker: 'dist/background.js' } }),
            getURL: (path) => `chrome-extension://test/${path}`,
        },
        i18n: { getUILanguage: () => 'zh-CN' },
        storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
    });
    vi.stubGlobal('matchMedia', () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    }));
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url) => {
            const locale = new URL(url).pathname.match(/\/_locales\/([^/]+)\/messages\.json$/)[1];
            return new Response(JSON.stringify({ selection_actions: { message: labels[locale] } }));
        })
    );
});

afterEach(async () => {
    if (unmount) await act(async () => unmount());
    setPageLanguage(originalLang);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it.each(['en', null])('loads and reloads translations without changing host html lang=%s', async (lang) => {
    setPageLanguage(lang);
    await initI18n();
    expect(getActiveLocale()).toBe('zh_CN');
    expect(t('selection_actions')).toBe(labels.zh_CN);
    expect(document.documentElement.getAttribute('lang')).toBe(lang);

    data.memory.uiLanguage = 'zh_TW';
    await reloadI18n();
    expect(t('selection_actions')).toBe(labels.zh_TW);
    expect(document.documentElement.getAttribute('lang')).toBe(lang);
});

it('updates the Cerebr document language on initialization and preference changes', async () => {
    const root = document.documentElement;
    await initI18n({ root });
    expect(root.lang).toBe('zh-CN');

    for (const [locale, lang] of [
        ['zh_TW', 'zh-TW'],
        ['en', 'en'],
    ]) {
        data.memory.uiLanguage = locale;
        await reloadI18n({ root });
        expect(root.lang).toBe(lang);
        expect(t('selection_actions')).toBe(labels[locale]);
    }
});

it('uses the fallback language on the specified root when locale loading fails', async () => {
    setPageLanguage('ja');
    fetch.mockImplementation(async (url) =>
        new URL(url).pathname.includes('/zh_CN/')
            ? new Response('', { status: 404 })
            : new Response(JSON.stringify({ selection_actions: { message: labels.en } }))
    );
    const root = document.createElement('div');
    await initI18n({ root });
    expect(root.lang).toBe('en');
    expect(t('selection_actions')).toBe(labels.en);
    expect(document.documentElement.lang).toBe('ja');
});

it.each([
    { pageLang: 'en', preference: 'zh_CN', locale: 'zh_CN', toolbarLang: 'zh-CN', enabled: true },
    { pageLang: 'ja', preference: 'zh_TW', locale: 'zh_TW', toolbarLang: 'zh-TW', enabled: true },
    { pageLang: null, preference: 'en', locale: 'en', toolbarLang: 'en', enabled: true },
    { pageLang: 'fr', preference: 'auto', locale: 'zh_CN', toolbarLang: 'zh-CN', enabled: true },
    { pageLang: 'en', preference: 'zh_CN', locale: 'zh_CN', toolbarLang: 'zh-CN', enabled: false },
])(
    'isolates injected toolbar language ($preference, page=$pageLang, enabled=$enabled)',
    async ({ pageLang, preference, locale, toolbarLang, enabled }) => {
        setPageLanguage(pageLang);
        data.memory.uiLanguage = preference;
        data.memory.selectionActionsOnWebpages = enabled;
        const mutations = [];
        const observer = new MutationObserver((records) => mutations.push(...records));
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
        try {
            await act(async () => {
                unmount = await mountPageSelectionActions({ onAction: vi.fn() });
            });
            expect(document.querySelector('cerebr-selection').lang).toBe(toolbarLang);
            expect(t('selection_actions')).toBe(labels[locale]);
            expect(document.documentElement.getAttribute('lang')).toBe(pageLang);

            await act(async () => unmount());
            unmount = null;
            expect(document.querySelector('cerebr-selection')).toBeNull();
            expect(document.documentElement.getAttribute('lang')).toBe(pageLang);
            expect(mutations).toEqual([]);
        } finally {
            observer.disconnect();
        }
    }
);
