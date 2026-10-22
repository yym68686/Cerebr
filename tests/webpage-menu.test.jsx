import { act, useRef, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ memory: {}, tabChange: null, extension: true }));
vi.mock('../src/utils/storage-adapter.js', () => ({
    get isExtensionEnvironment() {
        return state.extension;
    },
    browserAdapter: {
        getAllTabs: vi.fn(),
        getCurrentTab: vi.fn(),
        getTabGroupsByIds: vi.fn(async () => ({})),
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
        remove: vi.fn(async () => {}),
    },
}));
vi.mock('../src/domain/chat/chat-store.js', () => ({ chatManager: { getCurrentChat: () => ({ id: 'a' }) } }));
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

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, host, latest, actions, sizeCallbacks;
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
const tick = () => act(async () => vi.advanceTimersByTimeAsync(40));
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
beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    state.memory = {};
    state.extension = true;
    storageAdapter.set.mockImplementation(async (values) =>
        Object.assign(state.memory, structuredClone(values))
    );
    browserAdapter.getAllTabs.mockResolvedValue(tabs);
    browserAdapter.getCurrentTab.mockResolvedValue(tabs[0]);
    browserAdapter.getTabGroupsByIds.mockResolvedValue({});
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
    await act(async () => root.unmount());
    host.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Prompt Bar source picker', () => {
    it('automatically adds the current page to new chats, remembers removal and restores the default after selecting again', async () => {
        await render('first', true);
        expect(latest.selected.map((tab) => tab.id)).toEqual([1]);
        expect(host.querySelector('#input-container').classList.contains('is-expanded')).toBe(true);
        await click('.composer-source-remove');
        expect(latest.selected).toEqual([]);
        await act(async () => state.tabChange());
        await tick();
        expect(latest.selected).toEqual([]);
        await render('second', true);
        expect(latest.selected).toEqual([]);
        expect(host.querySelector('#input-container').classList.contains('is-expanded')).toBe(false);
        await click('#settings-button');
        await click('#composer-current-page');
        expect(latest.selected.map((tab) => tab.id)).toEqual([1]);
        await render('third', true);
        expect(latest.selected.map((tab) => tab.id)).toEqual([1]);
        await render('first', true);
        expect(latest.selected).toEqual([]);
    });
    it('remembers unchecked picker choices by URL after a tab is reopened, without suppressing another page', async () => {
        await render('first', true);
        await open();
        await check('Alpha');
        const reopened = { ...tabs[0], id: 91 };
        browserAdapter.getCurrentTab.mockResolvedValue(reopened);
        browserAdapter.getAllTabs.mockResolvedValue([reopened]);
        await render('reopened', true);
        expect(latest.selected).toEqual([]);
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
