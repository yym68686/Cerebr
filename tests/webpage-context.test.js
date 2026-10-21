import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ memory: new Map(), chatId: 'chat-a', messages: undefined, extension: true }));
vi.mock('../src/utils/storage-adapter.js', () => ({
    get isExtensionEnvironment() { return state.extension; },
    storageAdapter: {
        get: vi.fn(async (keys) =>
            Object.fromEntries(
                (Array.isArray(keys) ? keys : [keys]).map((key) => [
                    key,
                    structuredClone(state.memory.get(key)),
                ])
            )
        ),
        set: vi.fn(async (data) => {
            for (const [key, value] of Object.entries(data)) state.memory.set(key, structuredClone(value));
        }),
        remove: vi.fn(async () => {}),
    },
    browserAdapter: {
        getAllTabs: vi.fn(),
        getCurrentTab: vi.fn(),
        isTabConnected: vi.fn(),
        reloadTab: vi.fn(),
        sendMessage: vi.fn(),
    },
}));
vi.mock('../src/domain/chat/chat-store.js', () => ({
    chatManager: { getCurrentChat: () => ({ id: state.chatId, messages: state.messages }) },
}));
vi.mock('../src/utils/i18n.js', () => ({ t: (key, values = []) => `${key} ${values.join(' ')}`.trim() }));

import { browserAdapter, storageAdapter } from '../src/utils/storage-adapter.js';
import { getEnabledTabsContent } from '../src/runtime/webpage/webpage-context.js';
import {
    getWebpageSwitchesForChat,
    updateWebpageSwitchesForChat,
    setWebpageSwitchesForChat,
    webpagePreferenceKey,
    isNewWebpageConversation,
} from '../src/utils/webpage-switches.js';
import { callAPI } from '../src/runtime/chat/api-client.js';
import { desktopBrowserStore } from '../src/platform/desktop-browser.js';

it('desktop reads explicit choices without initializing the current page, including before sending', async () => {
    state.extension = false;
    state.messages = [];
    const selections = new Map();
    const browserRequest = vi.fn(async ({message}) => {
        if (message.type === 'UPDATE_WEBPAGE_SWITCHES') {
            selections.set(message.chatId, {...selections.get(message.chatId), ...message.patch});
            return true;
        }
        return selections.get(message.chatId) || {};
    });
    vi.stubGlobal('cerebrDesktop', {browserRequest});
    desktopBrowserStore.set({session:'test-browser'});
    try {
        expect(await getWebpageSwitchesForChat('desktop-new', {currentTab:papers[0],initialize:true})).toEqual({});
        expect(browserRequest).toHaveBeenLastCalledWith({session:'test-browser',message:{type:'GET_WEBPAGE_SWITCHES',chatId:'desktop-new',initialize:false}});
        expect(await getEnabledTabsContent()).toBeNull();
        expect(browserAdapter.sendMessage).not.toHaveBeenCalled();
        await updateWebpageSwitchesForChat('chat-a', {1:true}, {tabs:[papers[0]]});
        expect((await getEnabledTabsContent()).pages).toHaveLength(1);
        expect(await getWebpageSwitchesForChat('desktop-another', {currentTab:papers[0],initialize:true})).toEqual({});
    } finally { desktopBrowserStore.set({session:null}); }
});

it('web pages do not automatically initialize a source either', async () => {
    state.extension = false;
    expect(await getWebpageSwitchesForChat('web-new', {currentTab:papers[0],initialize:true})).toEqual({});
});

const papers = [
    { id: 1, title: 'YM_V5.pdf', url: 'https://example.org/YM_V5.pdf', lastAccessed: 2 },
    { id: 2, title: 'Math_Topology.pdf', url: 'https://example.org/Math_Topology.pdf', lastAccessed: 1 },
];
const textById = { 1: 'First PDF: mass gap analysis.', 2: 'Second PDF: topology analysis.' };
const key = (id) => `cerebr_webpage_switches_v1_${id}`;
const deferred = () => {
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
};

beforeEach(() => {
    vi.clearAllMocks();
    state.chatId = 'chat-a';
    state.messages = undefined;
    state.extension = true;
    state.memory.clear();
    state.memory.set(key('chat-a'), { 1: true, 2: true });
    browserAdapter.getAllTabs.mockResolvedValue(structuredClone(papers));
    browserAdapter.getCurrentTab.mockResolvedValue(papers[0]);
    browserAdapter.isTabConnected.mockResolvedValue(true);
    browserAdapter.sendMessage.mockImplementation(async ({ tabId }) => ({
        title: papers.find((tab) => tab.id === tabId).title,
        content: textById[tabId],
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('selected PDF context', () => {
    it('lets the background reconnect a selected page without reloading it', async () => {
        browserAdapter.isTabConnected.mockResolvedValue(false);
        const result = await getEnabledTabsContent();
        expect(result.pages).toHaveLength(2);
        expect(browserAdapter.reloadTab).not.toHaveBeenCalled();
        expect(browserAdapter.sendMessage).toHaveBeenCalledWith({
            type: 'GET_PAGE_CONTENT_FROM_SIDEBAR',
            tabId: 1,
            skipWaitContent: true,
        });
    });

    it('waits for both PDFs and serializes both texts in the outgoing model request', async () => {
        const second = deferred();
        browserAdapter.sendMessage.mockImplementation(async ({ tabId }) => {
            if (tabId === 2) await second.promise;
            return { title: papers.find((tab) => tab.id === tabId).title, content: textById[tabId] };
        });
        let settled = false;
        const gathering = getEnabledTabsContent().then((result) => {
            settled = true;
            return result;
        });
        await vi.waitFor(() => expect(browserAdapter.sendMessage).toHaveBeenCalledTimes(2));
        expect(settled).toBe(false);
        second.resolve();
        const webpageInfo = await gathering;
        expect(webpageInfo.pages.map((p) => p.content)).toEqual(Object.values(textById));
        expect(webpageInfo.pages.map((p) => p.isCurrent)).toEqual([true, false]);
        let request;
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url, init) => {
                request = JSON.parse(init.body);
                return new Response(
                    'data: {"choices":[{"delta":{"content":"Compared both PDFs"}}]}\n\ndata: [DONE]\n',
                    {
                        headers: { 'Content-Type': 'text/event-stream' },
                    }
                );
            })
        );
        const { processStream } = await callAPI({
            apiConfig: { baseUrl: 'https://model.test/v1', apiKey: 'test-only', modelName: 'test' },
            messages: [{ role: 'user', content: 'Compare both papers' }],
            userLanguage: 'zh-CN',
            webpageInfo,
        });
        await processStream();
        const system = request.messages.find((m) => m.role === 'system').content;
        for (const paper of papers) {
            expect(system).toContain(paper.title);
            expect(system).toContain(paper.url);
            expect(system).toContain(textById[paper.id]);
        }
    });

    it.each(['empty', 'error'])('rejects incomplete context when a selected PDF returns %s', async (kind) => {
        browserAdapter.sendMessage.mockImplementation(async ({ tabId }) => {
            if (tabId === 2) {
                if (kind === 'error') throw new Error('PDF unavailable');
                return { title: papers[1].title, content: '  ' };
            }
            return { title: papers[0].title, content: textById[1] };
        });
        await expect(getEnabledTabsContent()).rejects.toMatchObject({
            code: 'WEBPAGE_CONTEXT_INCOMPLETE',
            message: expect.stringContaining('Math_Topology.pdf'),
            failedTabs: [{ id: 2, title: papers[1].title, url: papers[1].url }],
        });
    });

    it('does not implicitly include the current page or explicitly disabled pages', async () => {
        state.memory.set(key('chat-a'), {});
        expect(await getEnabledTabsContent()).toBeNull();
        expect(browserAdapter.sendMessage).not.toHaveBeenCalled();
        state.memory.set(key('chat-a'), { 1: false, 2: false });
        browserAdapter.sendMessage.mockClear();
        expect(await getEnabledTabsContent()).toBeNull();
        expect(browserAdapter.sendMessage).not.toHaveBeenCalled();
    });

    it('keeps a selected page when a more recent unselected tab has the same URL', async () => {
        state.memory.set(key('chat-a'), { 1: true });
        browserAdapter.getAllTabs.mockResolvedValue([{ ...papers[0], id: 3, lastAccessed: 100 }, ...papers]);
        const result = await getEnabledTabsContent();
        expect(result.pages).toHaveLength(1);
        expect(browserAdapter.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ tabId: 1 }));
    });

    it('waits for rapid checkbox updates before reading the selected PDF set', async () => {
        state.memory.set(key('chat-a'), { 1: false, 2: false });
        const saving = deferred();
        storageAdapter.set.mockImplementationOnce(async (data) => {
            await saving.promise;
            for (const [name, value] of Object.entries(data)) state.memory.set(name, value);
        });
        const first = updateWebpageSwitchesForChat('chat-a', { 1: true });
        const second = updateWebpageSwitchesForChat('chat-a', { 2: true });
        const gathering = getEnabledTabsContent();
        await vi.waitFor(() => expect(storageAdapter.set).toHaveBeenCalledOnce());
        expect(browserAdapter.sendMessage).not.toHaveBeenCalled();
        saving.resolve();
        await Promise.all([first, second]);
        expect((await gathering).pages).toHaveLength(2);
        expect(await getWebpageSwitchesForChat('chat-a')).toEqual({ 1: true, 2: true });
    });

    it('does not mix writes for different chats and permits later updates after a failed save', async () => {
        const failure = new Error('Storage unavailable');
        storageAdapter.set.mockRejectedValueOnce(failure);
        await expect(updateWebpageSwitchesForChat('chat-a', { 1: false })).rejects.toBe(failure);
        await Promise.all([
            updateWebpageSwitchesForChat('chat-a', { 2: false }),
            setWebpageSwitchesForChat('chat-b', { 1: false, 2: true }),
        ]);
        expect(await getWebpageSwitchesForChat('chat-a')).toEqual({ 1: true, 2: false });
        expect(await getWebpageSwitchesForChat('chat-b')).toEqual({ 1: false, 2: true });
    });
});

describe('per-page default source choice', () => {
    const initialize = (id, currentTab = papers[0]) =>
        getWebpageSwitchesForChat(id, { currentTab, initialize: true });
    it('includes the current page even when sending before the composer has finished loading', async () => {
        state.messages = [];
        state.memory.delete(key('chat-a'));
        const result = await getEnabledTabsContent();
        expect(result.pages.map((page) => page.url)).toEqual([papers[0].url]);
        expect(state.memory.get(key('chat-a'))).toEqual({ 1: true });
    });
    it('waits for a pending removal before initializing another chat and lets a later choice restore inclusion', async () => {
        const gate = deferred();
        storageAdapter.set.mockImplementationOnce(async (values) => {
            await gate.promise;
            for (const [name, value] of Object.entries(values)) state.memory.set(name, value);
        });
        const removal = updateWebpageSwitchesForChat('chat-a', { 1: false }, { tabs: [papers[0]] });
        const nextChat = initialize('next');
        await vi.waitFor(() => expect(storageAdapter.set).toHaveBeenCalledOnce());
        expect(state.memory.has(key('next'))).toBe(false);
        gate.resolve();
        await removal;
        expect(await nextChat).toEqual({ 1: false });
        await updateWebpageSwitchesForChat('next', { 1: true }, { tabs: [papers[0]] });
        expect(await initialize('after-reenable', { ...papers[0], id: 91 })).toEqual({ 91: true });
        expect(await initialize('chat-a')).toEqual({ 1: false, 2: true });
    });
    it('orders opposite choices for the same page across conversations', async () => {
        const gate = deferred();
        storageAdapter.set.mockImplementationOnce(async (values) => {
            await gate.promise;
            for (const [name, value] of Object.entries(values)) state.memory.set(name, value);
        });
        const remove = updateWebpageSwitchesForChat('chat-a', { 1: false }, { tabs: [papers[0]] });
        const reenable = updateWebpageSwitchesForChat('chat-b', { 1: true }, { tabs: [papers[0]] });
        const next = initialize('next');
        await vi.waitFor(() => expect(storageAdapter.set).toHaveBeenCalledOnce());
        gate.resolve();
        await Promise.all([remove, reenable]);
        expect(await next).toEqual({ 1: true });
    });
    it('uses the full URL from the tab list when the current-tab adapter abbreviates local PDF paths', async () => {
        state.messages = [];
        state.memory.delete(key('chat-a'));
        const pdf = { ...papers[0], url: 'file:///Users/test/private.pdf' };
        browserAdapter.getAllTabs.mockResolvedValue([pdf]);
        browserAdapter.getCurrentTab.mockResolvedValue({ ...pdf, url: 'file://' });
        state.memory.set(webpagePreferenceKey(pdf.url), false);
        expect(await getEnabledTabsContent()).toBeNull();
        expect(browserAdapter.sendMessage).not.toHaveBeenCalled();
    });
    it('does not overwrite a manual change queued during default initialization', async () => {
        const first = initialize('first');
        const removal = updateWebpageSwitchesForChat('first', { 1: false }, { tabs: [papers[0]] });
        await Promise.all([first, removal]);
        expect(await initialize('first')).toEqual({ 1: false });
        expect(await initialize('second')).toEqual({ 1: false });
    });
    it('keeps choices for different pages independently and preserves the earlier preference on failed save', async () => {
        await updateWebpageSwitchesForChat('chat-a', { 1: false, 2: false }, { tabs: papers });
        expect(await initialize('paper-one')).toEqual({ 1: false });
        expect(await initialize('paper-two', papers[1])).toEqual({ 2: false });
        storageAdapter.set.mockRejectedValueOnce(new Error('storage failed'));
        await expect(
            updateWebpageSwitchesForChat('chat-a', { 1: true }, { tabs: [papers[0]] })
        ).rejects.toThrow('storage failed');
        expect(await initialize('after-error')).toEqual({ 1: false });
    });
    it('applies an opted-out preference to the outgoing first request, not just the source chips', async () => {
        state.messages = [];
        state.memory.delete(key('chat-a'));
        state.memory.set(webpagePreferenceKey(papers[0].url), false);
        expect(await getEnabledTabsContent()).toBeNull();
        expect(browserAdapter.sendMessage).not.toHaveBeenCalled();
    });
    it('distinguishes articles, query parameters, hash routes and local PDFs, while sharing ordinary anchors', () => {
        expect(webpagePreferenceKey('https://example.org/article#intro')).toBe(
            webpagePreferenceKey('https://example.org/article#end')
        );
        expect(webpagePreferenceKey('https://example.org/?id=1')).not.toBe(
            webpagePreferenceKey('https://example.org/?id=2')
        );
        expect(webpagePreferenceKey('https://example.org/#/one')).not.toBe(
            webpagePreferenceKey('https://example.org/#/two')
        );
        expect(webpagePreferenceKey('file:///one.pdf')).not.toBe(webpagePreferenceKey('file:///two.pdf'));
        expect(webpagePreferenceKey('chrome://extensions/')).toBeNull();
        expect(isNewWebpageConversation({ messages: [] })).toBe(true);
        expect(isNewWebpageConversation({ messages: [{ seedLocaleBound: true }] })).toBe(true);
        expect(isNewWebpageConversation({ messages: [{ role: 'user', content: 'Hi' }] })).toBe(false);
    });
});
