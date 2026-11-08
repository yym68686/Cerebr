import { act, useRef, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBKeyRange } from 'fake-indexeddb';
import { setImmediate } from 'node:timers';
import { createTestSyncDatabase } from './helpers/sync-database.js';
const state = vi.hoisted(() => ({ memory: {}, tabChange: null, extension: true, messages: undefined, db: null }));
vi.mock('../src/utils/storage-adapter.js', () => ({
    getDb: async () => state.db,
    get isExtensionEnvironment() {
        return state.extension;
    },
    browserAdapter: {
        getAllTabs: vi.fn(),
        getCurrentTab: vi.fn(),
        getTabGroupsByIds: vi.fn(async () => ({})),
        sendMessage: vi.fn(),
        onTabActivated: () => () => {},
        onTabsChanged: (callback) => {
            state.tabChange = callback;
            return () => {
                state.tabChange = null;
            };
        },
        reloadTab: vi.fn(),
    },
    storageAdapter: {
        get: vi.fn(async (keys) =>
            Object.fromEntries(
                (Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(state.memory[key])])
            )
        ),
        set: vi.fn(async (values) => Object.assign(state.memory, structuredClone(values))),
        remove: vi.fn(async (keys) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete state.memory[key];
        }),
    },
}));
vi.mock('../src/domain/chat/chat-store.js', () => ({
    chatManager: { getCurrentChat: () => ({ id: 'a', messages: state.messages }) },
}));
vi.mock('../src/utils/i18n.js', () => ({ t: (key, values = []) => `${key} ${values.join(' ')}`.trim() }));
vi.mock('../src/app/components/PluginSurfaces.jsx', () => ({
    PluginMenuItems: () => (
        <div id="plugin-menu-items">
            <button role="menuitem">Plugin action</button>
        </div>
    ),
}));
import { browserAdapter, storageAdapter } from '../src/utils/storage-adapter.js';
import { ComposerMenu } from '../src/app/components/ComposerMenu.jsx';
import { ComposerSources } from '../src/app/components/ComposerSources.jsx';
import { useSettingsMenu } from '../src/app/hooks/useSettingsMenu.js';
import { useWebpageSources } from '../src/app/hooks/useWebpageSources.js';
import { useComposerDraft } from '../src/app/hooks/useComposerDraft.js';
import { uiStore } from '../src/app/state/ui-store.js';
import { desktopBrowserStore } from '../src/platform/desktop-browser.js';
import { getEnabledTabsContent } from '../src/runtime/webpage/webpage-context.js';
import { getCachedWebpagesForChat, webpagePreferenceKey } from '../src/utils/webpage-switches.js';
import { applyRemoteRecord, replicaRecord } from '../src/runtime/sync/replica.js';
import { webpageSourceKey } from '../src/runtime/sync/webpage-sources.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, host, latest, actions, sizeCallbacks, pendingIO;
const tabs = [
    { id: 1, title: 'Alpha', url: 'https://alpha.example', groupId: -1, lastAccessed: 2 },
    { id: 2, title: 'Beta', url: 'https://beta.example', groupId: -1, lastAccessed: 1 },
];
function Composer({ chatId = 'a', autoAddCurrentPage = false }) {
    const ui = useSyncExternalStore(uiStore.subscribe, uiStore.getSnapshot);
    const events = useSettingsMenu();
    const sources = useWebpageSources(chatId, ui.menu, autoAddCurrentPage);
    const inputRef = useRef(null),
        rowRef = useRef(null);
    const draft = useComposerDraft(inputRef, rowRef, sources.selected.length > 0 || sources.reserveSources);
    latest = sources;
    return (
        <div id="input-container" data-composer className={draft.expanded ? 'is-expanded' : ''}>
            <ComposerSources sources={sources} onManage={events.openSources} />
            <div data-composer-attachments />
            <div ref={rowRef}>
                <button id="settings-button" {...events.button} />
                <ComposerMenu
                    ui={ui}
                    sources={sources}
                    events={events}
                    onAddImages={actions.images}
                    onNewChat={actions.newChat}
                    onNavigate={actions.navigate}
                    developerMode
                />
                <div className="message-input-shell">
                    <div
                        id="message-input"
                        contentEditable
                        ref={inputRef}
                        suppressContentEditableWarning
                        data-empty={draft.textEmpty && !draft.composing}
                    />
                </div>
            </div>
        </div>
    );
}
const trackIO = (promise) => {
    pendingIO.add(promise);
    const finished = () => pendingIO.delete(promise);
    promise.then(finished, finished);
    return promise;
};
const settleIO = async () => {
    // IndexedDB and Web Crypto use real asynchronous work. A fixed number of
    // event-loop turns can finish before hashing completes on a faster host.
    do {
        await Promise.all([...pendingIO]);
        await new Promise(setImmediate);
    } while (pendingIO.size);
};
const advanceTimers = async (ms) => {
    await vi.advanceTimersByTimeAsync(ms);
    await settleIO();
};
const tick = () => act(async () => advanceTimers(40));
const render = async (chatId = 'a', autoAddCurrentPage = false) => {
    await act(async () => root.render(<Composer chatId={chatId} autoAddCurrentPage={autoAddCurrentPage} />));
    await tick();
};
const click = async (selector) => {
    await act(async () => host.querySelector(selector).click());
    await tick();
};
const open = async () => {
    await click('#settings-button');
    await click('#webpage-qa');
};
const check = (id) => click(`input[type="checkbox"][aria-label="${id}"]`);
const search = async (value) =>
    act(async () => {
        const input = host.querySelector('input[type="search"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
beforeEach(async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    state.db = await createTestSyncDatabase();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.clearAllMocks();
    pendingIO = new Set();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementation((...args) => trackIO(digest(...args)));
    const transaction = state.db.transaction.bind(state.db);
    vi.spyOn(state.db, 'transaction').mockImplementation((...args) => {
        const tx = transaction(...args);
        trackIO(new Promise((resolve) => {
            tx.addEventListener('complete', resolve, { once: true });
            tx.addEventListener('abort', resolve, { once: true });
        }));
        return tx;
    });
    state.memory = {};
    state.extension = true;
    state.messages = undefined;
    storageAdapter.set.mockImplementation(async (values) =>
        Object.assign(state.memory, structuredClone(values))
    );
    browserAdapter.getAllTabs.mockResolvedValue(tabs);
    browserAdapter.getCurrentTab.mockResolvedValue(tabs[0]);
    browserAdapter.getTabGroupsByIds.mockResolvedValue({});
    browserAdapter.sendMessage.mockImplementation(async ({ tabId }) => ({
        title: tabs.find((tab) => tab.id === tabId)?.title,
        content: `Page content for tab ${tabId}`,
    }));
    sizeCallbacks = new Map();
    vi.stubGlobal(
        'ResizeObserver',
        class {
            constructor(callback) {
                this.callback = callback;
            }
            observe(element) {
                sizeCallbacks.set(element, this.callback);
            }
            disconnect() {}
        }
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        measureText: (text) => ({ width: text.length * 7 }),
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    actions = { images: vi.fn(), newChat: vi.fn(), navigate: vi.fn() };
    uiStore.set({ menu: false, webpageMenu: false, page: null, toasts: [] });
});
afterEach(async () => {
    await act(async () => {
        root.unmount();
        await settleIO();
    });
    host.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    state.db.close();
});

describe('Prompt Bar source picker', () => {
    it('updates chips immediately on remote removals while the removed browser tabs stay open', async () => {
        state.memory.cerebr_webpage_cache_v1_a = tabs.map((tab) => ({ ...tab, tabId: tab.id, content: tab.title }));
        state.memory.cerebr_webpage_switches_v1_a = { 1: true, 2: true };
        await render();
        expect(latest.selected).toHaveLength(2);
        const key = await webpageSourceKey('a', tabs[1].url), old = await replicaRecord(state.db, key);
        await act(async () => {
            await applyRemoteRecord(state.db, { ...old, value: null, deleted: true, version: { clock: old.version.clock + 1, actor: 'desktop' } });
        });
        await tick(); await tick();
        expect(latest.selected.map((tab) => tab.title)).toEqual(['Alpha']);
        expect((await getCachedWebpagesForChat('a')).map((page) => page.title)).toEqual(['Alpha']);
    });
    it('follows only the current document in an empty chat without caching unasked pages', async () => {
        state.messages = [];
        await render('a', true);
        await act(async () => advanceTimers(400));
        expect(latest.selected.map((tab) => tab.title)).toEqual(['Alpha']);
        expect(state.memory.cerebr_webpage_cache_v1_a).toBeUndefined();
        expect(browserAdapter.sendMessage).not.toHaveBeenCalled();

        const article = { ...tabs[0], title: 'Another article', url: 'https://alpha.example/article' };
        browserAdapter.getAllTabs.mockResolvedValue([article, tabs[1]]);
        browserAdapter.getCurrentTab.mockResolvedValue(article);
        await act(async () => state.tabChange());
        await tick();
        expect(latest.selected.map((tab) => tab.title)).toEqual(['Another article']);

        browserAdapter.getCurrentTab.mockResolvedValue(tabs[1]);
        await act(async () => state.tabChange());
        await tick();
        expect(latest.selected.map((tab) => tab.title)).toEqual(['Beta']);
        browserAdapter.getAllTabs.mockResolvedValue([]);
        browserAdapter.getCurrentTab.mockResolvedValue(null);
        await act(async () => state.tabChange());
        await act(async () => advanceTimers(400));
        expect(latest.selected).toEqual([]);
        expect(state.memory.cerebr_webpage_cache_v1_a).toBeUndefined();
    });
    it('pins a page after asking about it and never appends newly visited documents', async () => {
        state.messages = [];
        await render('a', true);
        await act(async () => getEnabledTabsContent('a'));
        state.messages = [{ role: 'user', content: 'Explain Alpha' }];
        await render('a', false);

        const article = { ...tabs[0], title: 'Unasked article', url: 'https://alpha.example/unasked' };
        browserAdapter.getAllTabs.mockResolvedValue([article, tabs[1]]);
        browserAdapter.getCurrentTab.mockResolvedValue(article);
        await act(async () => state.tabChange());
        await act(async () => advanceTimers(400));
        expect(latest.selected.map((tab) => tab.title)).toEqual(['Alpha']);
        expect(latest.selected[0].cached).toBe(true);

        browserAdapter.getCurrentTab.mockResolvedValue(tabs[1]);
        await act(async () => state.tabChange());
        await act(async () => advanceTimers(400));
        expect(latest.selected.map((tab) => tab.title)).toEqual(['Alpha']);
        expect((await getCachedWebpagesForChat('a')).map((page) => page.url)).toEqual([tabs[0].url]);
        expect((await getEnabledTabsContent('a')).pages.map((page) => page.url)).toEqual([tabs[0].url]);
    });
    it('keeps manual additions available but waits for a question before caching them', async () => {
        await render();
        await act(async () => latest.toggle([tabs[1]], true));
        await act(async () => advanceTimers(400));
        expect(latest.selected.map((tab) => tab.title)).toEqual(['Beta']);
        expect(state.memory.cerebr_webpage_cache_v1_a).toBeUndefined();
        await act(async () => getEnabledTabsContent('a'));
        browserAdapter.getAllTabs.mockResolvedValue([]);
        browserAdapter.getCurrentTab.mockResolvedValue(null);
        await act(async () => state.tabChange());
        await tick();
        expect(latest.selected.map((tab) => tab.title)).toEqual(['Beta']);
        expect(latest.selected[0].cached).toBe(true);
    });
    it('automatically adds the current page in each new chat without inheriting another chat\'s removal', async () => {
        state.memory[webpagePreferenceKey(tabs[0].url)] = false;
        await render('first', true);
        expect(latest.selected.map((tab) => tab.id)).toEqual([1]);
        expect(host.querySelector('#input-container').classList.contains('is-expanded')).toBe(true);
        await click('.composer-source-remove');
        expect(latest.selected).toEqual([]);
        await act(async () => state.tabChange());
        await tick();
        expect(latest.selected).toEqual([]);
        await render('second', true);
        expect(latest.selected.map((tab) => tab.id)).toEqual([1]);
        expect(host.querySelector('#input-container').classList.contains('is-expanded')).toBe(true);
        await click('.composer-source-remove');
        await click('#settings-button');
        await click('#composer-current-page');
        expect(latest.selected.map((tab) => tab.id)).toEqual([1]);
        await render('third', true);
        expect(latest.selected.map((tab) => tab.id)).toEqual([1]);
        await render('first', true);
        expect(latest.selected).toEqual([]);
    });
    it('remembers removals when a tab reopens in the same chat while new chats include that page', async () => {
        await render('first', true);
        await open();
        await check('Alpha');
        const reopened = { ...tabs[0], id: 91 };
        browserAdapter.getCurrentTab.mockResolvedValue(reopened);
        browserAdapter.getAllTabs.mockResolvedValue([reopened]);
        await act(async () => state.tabChange());
        await tick();
        expect(latest.selected).toEqual([]);
        await render('reopened', true);
        expect(latest.selected.map((tab) => tab.id)).toEqual([91]);
        const other = { ...reopened, id: 92, url: 'https://alpha.example/other-article' };
        browserAdapter.getCurrentTab.mockResolvedValue(other);
        browserAdapter.getAllTabs.mockResolvedValue([other]);
        await render('other-page', true);
        expect(latest.selected.map((tab) => tab.id)).toEqual([92]);
    });
    it('does not enable a default for existing conversations or override a saved empty selection', async () => {
        await render('history');
        expect(latest.selected).toEqual([]);
        state.memory.cerebr_webpage_switches_v1_empty = {};
        await render('empty', true);
        expect(latest.selected).toEqual([]);
    });

    it('keeps the picker top stable as sources grow and restores editor focus after selecting', async () => {
        await render();
        const composer = host.querySelector('#input-container');
        const menu = host.querySelector('#settings-menu');
        let top = 500;
        vi.spyOn(composer, 'getBoundingClientRect').mockImplementation(() => ({ top, bottom: 600 }));
        Object.defineProperty(menu, 'offsetTop', { configurable: true, get: () => -300 });
        await open();
        expect(menu.style.top).toBe('calc(100% - 400px)');
        top = 400;
        await check('Alpha');
        // It must remain anchored before the observer runs, not merely recover afterward.
        expect(menu.style.top).toBe('calc(100% - 400px)');
        expect(menu.style.maxHeight).toBe('max(60px, calc(392px - 100%))');
        await act(async () => sizeCallbacks.get(composer)());
        expect(menu.style.top).toBe('calc(100% - 400px)');
        expect(document.activeElement.id).toBe('message-input');
        expect(uiStore.getSnapshot().webpageMenu).toBe(true);
        await check('Beta');
        expect(latest.selected).toHaveLength(2);
        await click('.composer-picker-footer button');
        expect(document.activeElement.id).toBe('message-input');
        expect(menu.style.top).toBe('');
    });
    it.each(['<br>', '<div><br></div>', '<div><br></div><div><br></div>', '<div>&nbsp;</div>'])(
        'returns to compact layout after deletion leaves %s behind',
        async (residue) => {
            await render();
            const input = host.querySelector('#message-input');
            await act(async () => {
                input.innerHTML = '第一行<div>第二行</div>';
            });
            await tick();
            expect(host.querySelector('#input-container').classList.contains('is-expanded')).toBe(true);
            await act(async () => {
                input.innerHTML = residue;
            });
            await tick();
            expect(host.querySelector('#input-container').classList.contains('is-expanded')).toBe(false);
            expect(input.dataset.empty).toBe('true');
            expect(input.innerHTML).toBe(residue);
        }
    );
    it('waits until composition ends to collapse without rewriting the native editor', async () => {
        await render();
        const input = host.querySelector('#message-input');
        await act(async () => {
            input.innerHTML = '第一行<div>第二行</div>';
        });
        await tick();
        await act(async () => {
            input.dispatchEvent(new CompositionEvent('compositionstart'));
            input.innerHTML = '<div><br></div>';
        });
        await tick();
        expect(host.querySelector('#input-container').classList.contains('is-expanded')).toBe(true);
        expect(input.dataset.empty).toBe('false');
        await act(async () => input.dispatchEvent(new CompositionEvent('compositionend')));
        await tick();
        expect(host.querySelector('#input-container').classList.contains('is-expanded')).toBe(false);
        expect(input.dataset.empty).toBe('true');
        expect(input.innerHTML).toBe('<div><br></div>');
    });
    it('has no source placeholder and stays compact until a page is explicitly added', async () => {
        await render();
        expect(latest.selected).toEqual([]);
        expect(host.querySelector('.composer-sources')).toBeNull();
        expect(host.querySelector('#input-container').classList.contains('is-expanded')).toBe(false);
        await click('#settings-button');
        await click('#composer-current-page');
        expect(host.querySelector('.composer-source-title').textContent).toBe('Alpha');
        expect(host.querySelector('#input-container').classList.contains('is-expanded')).toBe(true);
        expect(state.memory.cerebr_webpage_switches_v1_a).toEqual({ 1: true });
        await click('.composer-source-remove');
        expect(host.querySelector('.composer-sources')).toBeNull();
        expect(host.querySelector('#input-container').classList.contains('is-expanded')).toBe(false);
    });
    it('keeps the same popover and plugin nodes, focuses search, and returns with Escape', async () => {
        await render();
        await click('#settings-button');
        const menu = host.querySelector('#settings-menu'),
            plugins = host.querySelector('#plugin-menu-items');
        await click('#webpage-qa');
        expect(menu.contains(host.querySelector('#webpage-content-menu'))).toBe(true);
        expect(host.querySelector('.composer-menu-primary').hidden).toBe(true);
        expect(document.activeElement.type).toBe('search');
        expect(host.querySelector('#plugin-menu-items')).toBe(plugins);
        await act(async () =>
            document.activeElement.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
            )
        );
        expect(document.activeElement.getAttribute('aria-label')).toBe('Alpha');
        await act(async () =>
            document.activeElement.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
            )
        );
        await tick();
        expect(host.querySelector('#settings-menu')).toBe(menu);
        expect(host.querySelector('#webpage-content-menu')).toBeNull();
        expect(document.activeElement.id).toBe('webpage-qa');
    });
    it('searches URLs, selects multiple pages, and keeps them after closing the picker', async () => {
        await render();
        await open();
        await check('Alpha');
        await check('Beta');
        await search('beta.example');
        expect(host.querySelectorAll('.composer-picker-item')).toHaveLength(1);
        expect(host.querySelector('.composer-picker-title').textContent).toBe('Beta');
        await click('.composer-picker-footer button');
        expect(uiStore.getSnapshot()).toMatchObject({ menu: false, webpageMenu: false });
        expect(host.querySelectorAll('.composer-source-tag')).toHaveLength(2);
        expect(browserAdapter.reloadTab).not.toHaveBeenCalled();
        await click('.composer-source-title');
        expect(host.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(2);
    });
    it('supports tab-group selection and searching within collapsed groups', async () => {
        browserAdapter.getAllTabs.mockResolvedValue(tabs.map((tab) => ({ ...tab, groupId: 7 })));
        browserAdapter.getTabGroupsByIds.mockResolvedValue({ 7: { title: 'Research', collapsed: true } });
        await render();
        await open();
        expect(host.querySelector('.composer-picker-group [hidden]')).not.toBeNull();
        await search('Beta');
        await click('.composer-picker-group-heading input');
        expect(latest.selected.map((tab) => tab.id)).toEqual([2]);
        expect(host.querySelectorAll('.composer-picker-item')).toHaveLength(1);
    });
    it('keeps selections per chat and does not replace them when the active browser tab changes', async () => {
        state.memory.cerebr_webpage_switches_v1_a = { 1: true };
        state.memory.cerebr_webpage_switches_v1_b = { 2: true };
        await render();
        browserAdapter.getCurrentTab.mockResolvedValue(tabs[1]);
        await act(async () => state.tabChange());
        await tick();
        expect(latest.current.id).toBe(2);
        expect(latest.selected.map((tab) => tab.id)).toEqual([1]);
        await render('b');
        expect(latest.selected.map((tab) => tab.id)).toEqual([2]);
        await render('a');
        expect(latest.selected.map((tab) => tab.id)).toEqual([1]);
    });
    it('keeps a cached page in the composer after its browser tab is closed until the user removes it', async () => {
        state.memory.cerebr_webpage_cache_v1_a = [
            {
                title: 'Archived article',
                url: 'https://archive.example/article',
                content: 'The page text remains available.',
                updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
                tabId: 77,
            },
        ];
        state.memory.cerebr_webpage_switches_v1_a = { 77: true };
        browserAdapter.getAllTabs.mockResolvedValue([]);
        browserAdapter.getCurrentTab.mockResolvedValue(null);
        await render();
        expect(latest.selected.map((source) => source.title)).toEqual(['Archived article']);
        expect(host.querySelector('.composer-source-title').textContent).toBe('Archived article');
        await click('.composer-source-remove');
        expect(host.querySelector('.composer-sources')).toBeNull();
        expect(await getCachedWebpagesForChat('a')).toEqual([]);
    });
    it('refreshes previously used pages and restores their chips after the tab and composer are closed', async () => {
        state.memory.cerebr_webpage_switches_v1_a = { 1: true };
        state.memory.cerebr_webpage_cache_v1_a = [
            { title: tabs[0].title, url: tabs[0].url, content: 'Earlier content', tabId: 1 },
        ];
        await render();
        await act(async () => advanceTimers(350));
        expect(await getCachedWebpagesForChat('a')).toEqual([
            expect.objectContaining({ url: tabs[0].url, content: 'Page content for tab 1' }),
        ]);
        browserAdapter.getAllTabs.mockResolvedValue([]);
        browserAdapter.getCurrentTab.mockResolvedValue(null);
        await act(async () => root.unmount());
        root = createRoot(host);
        await render();
        expect(host.querySelector('.composer-source-title').textContent).toBe('Alpha');
        await click('.composer-source-remove');
        expect(await getCachedWebpagesForChat('a')).toEqual([]);
        expect(host.querySelector('.composer-sources')).toBeNull();
    });
    it('ignores an old load completing after a chat switch', async () => {
        let resolve;
        browserAdapter.getAllTabs.mockImplementationOnce(
            () =>
                new Promise((r) => {
                    resolve = r;
                })
        );
        state.memory.cerebr_webpage_switches_v1_a = { 1: true };
        state.memory.cerebr_webpage_switches_v1_b = { 2: true };
        await render('a');
        await render('b');
        await act(async () => resolve(tabs));
        await tick();
        expect(latest.selected.map((tab) => tab.id)).toEqual([2]);
    });
    it('rolls back failed saves and lets later selections succeed', async () => {
        await render();
        await open();
        storageAdapter.set.mockRejectedValueOnce(new Error('disk unavailable'));
        await check('Alpha');
        expect(host.querySelector('.composer-sources')).toBeNull();
        expect(uiStore.getSnapshot().toasts.at(-1).message).toBe('composer_sources_save_error');
        await check('Beta');
        expect(latest.selected.map((tab) => tab.id)).toEqual([2]);
    });
    it('retains images and text expansion when the last webpage is removed', async () => {
        state.memory.cerebr_webpage_switches_v1_a = { 1: true };
        await render();
        await act(async () => {
            host.querySelector('[data-composer-attachments]').innerHTML = '<span class="image-tag" />';
            host.querySelector('#message-input').dispatchEvent(new Event('input'));
        });
        await tick();
        await click('.composer-source-remove');
        expect(host.querySelector('.composer-sources')).toBeNull();
        expect(host.querySelector('#input-container').classList.contains('is-expanded')).toBe(true);
    });
    it('keeps all management actions in the plus menu and hides webpage actions on the Web', async () => {
        state.extension = false;
        await render();
        await click('#settings-button');
        expect(host.querySelector('#composer-current-page')).toBeNull();
        expect(host.querySelector('#webpage-qa')).toBeNull();
        await click('#new-chat');
        expect(actions.newChat).toHaveBeenCalledOnce();
        await click('#chat-list');
        expect(actions.navigate).toHaveBeenLastCalledWith('history');
        await click('#api-settings-toggle');
        expect(actions.navigate).toHaveBeenLastCalledWith('api');
        await click('#preferences-toggle');
        expect(actions.navigate).toHaveBeenLastCalledWith('preferences');
        await click('#plugins-toggle');
        expect(actions.navigate).toHaveBeenLastCalledWith('plugins');
        expect(browserAdapter.getAllTabs).not.toHaveBeenCalled();
    });
    it('reveals browser sources on desktop connection and hides the open picker and chips on disconnect',async()=>{
        state.extension=false;
        await render();await click('#settings-button');
        expect(host.querySelector('#webpage-qa')).toBeNull();
        await act(async()=>desktopBrowserStore.set({session:'paired-browser'}));await tick();
        expect(host.querySelector('#webpage-qa')).not.toBeNull();
        await click('#webpage-qa');
        expect(host.querySelector('#webpage-content-menu')).not.toBeNull();
        await act(async()=>latest.toggle([tabs[0]],true));await tick();
        expect(host.querySelector('.composer-source-tag')).not.toBeNull();
        await act(async()=>desktopBrowserStore.set({session:null}));await tick();
        expect(host.querySelector('#webpage-qa')).toBeNull();
        expect(host.querySelector('#webpage-content-menu')).toBeNull();
        expect(host.querySelector('.composer-source-tag')).toBeNull();
        expect(host.querySelector('.composer-menu-primary').hidden).toBe(false);
    });
});

it('keeps source geometry when switching between referenced chats, and reuses the target cache', async () => {
    state.memory.cerebr_webpage_switches_v1_a = { 1: true };
    state.memory.cerebr_webpage_switches_v1_b = { 2: true };
    await render('a');
    expect(host.querySelector('.composer-source-title').textContent).toBe('Alpha');
    let resolve;
    browserAdapter.getAllTabs.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await render('b');
    expect(latest.selected).toEqual([]);
    expect(host.querySelector('#input-container').classList.contains('is-expanded')).toBe(true);
    expect(host.querySelector('.composer-sources-loading')).not.toBeNull();
    await act(async () => resolve(tabs));
    await tick();
    expect(host.querySelector('.composer-source-title').textContent).toBe('Beta');
    browserAdapter.getAllTabs.mockReturnValueOnce(new Promise(() => {}));
    await render('a');
    expect(host.querySelector('.composer-source-title').textContent).toBe('Alpha');
    expect(host.querySelector('#input-container').classList.contains('is-expanded')).toBe(true);
});

it('opens source URLs in a separate browsing context without changing selection', async () => {
    await render(); await open();
    const link=host.querySelector('.composer-picker-detail a');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    const before=JSON.stringify(state.memory);
    await act(async()=>link.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})));
    expect(JSON.stringify(state.memory)).toBe(before);
});
