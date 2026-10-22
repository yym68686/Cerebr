import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    extension: false,
    start: null,
    pipelineOptions: null,
    saveReading: vi.fn(async () => {}),
}));
vi.mock('../src/utils/storage-adapter.js', () => ({
    get isExtensionEnvironment() {
        return state.extension;
    },
    storageAdapter: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
    },
    browserAdapter: { onTabActivated: () => () => {}, getCurrentTab: async () => ({ id: 7 }) },
}));
vi.mock('../src/domain/chat/chat-store.js', () => ({
    chatManager: {
        currentChatId: 'old',
        chats: new Map(),
        subscribe: () => () => {},
        getCurrentChat: () => ({ messages: [] }),
        createNewChat: vi.fn(() => ({ id: 'new' })),
        switchChat: vi.fn(async () => {}),
        flushNow: vi.fn(async () => {}),
        setChatModel: vi.fn(async () => {}),
    },
}));
vi.mock('../src/runtime/chat/chat-pipeline.js', () => ({
    createChatPipeline: (options) => {
        state.pipelineOptions = options;
        return { abortAll: async () => {}, abortActiveReply: vi.fn(async () => {}), sendSelection: vi.fn(async () => true) };
    },
}));
vi.mock('../src/runtime/input/native-editor.js', async (importOriginal) => ({
    ...(await importOriginal()),
    attachNativeEditor: () => () => {},
}));
vi.mock('../src/app/state/api-configs.js', () => ({
    loadApiConfigs: async () => {},
    getSelectedApiConfig: () => null,
    saveApiConfigs: async () => {},
    selectConfig: async () => {},
    apiStore: { getSnapshot: () => ({ configs: [], defaultSelection: null }) },
}));
vi.mock('../src/app/state/preferences.js', () => ({ loadPreferences: async () => {} }));
vi.mock('../src/runtime/webpage/webpage-context.js', () => ({ getEnabledTabsContent: async () => null }));
vi.mock('../src/utils/reading-progress.js', () => ({
    createReadingProgressManager: () => ({
        saveNow: state.saveReading,
        restore: async () => {},
        start() {},
        stop() {},
    }),
}));
vi.mock('../src/utils/webpage-switches.js', () => ({ setWebpageSwitchesForChat: vi.fn(async () => {}) }));
vi.mock('../src/plugin/shell/shell-plugin-runtime.js', () => ({
    createShellPluginRuntime: () => ({ attachChatRuntime() {}, start: () => state.start, stop: vi.fn() }),
}));
vi.mock('../src/utils/i18n.js', () => ({ t: (key) => key }));
vi.mock('../src/platform/sidebar-drag.js', () => ({ attachSidebarDrag: () => () => {} }));
vi.mock('../src/runtime/sync/ui-sync.js',()=>({publishProgress:vi.fn(),publishLiveChat:vi.fn(),subscribeRemoteProgress:()=>()=>{}}));

import { createSession } from '../src/app/session.js';
import { chatManager } from '../src/domain/chat/chat-store.js';
import { storageAdapter } from '../src/utils/storage-adapter.js';
import { setWebpageSwitchesForChat } from '../src/utils/webpage-switches.js';
import { uiStore } from '../src/app/state/ui-store.js';
import { publishProgress } from '../src/runtime/sync/ui-sync.js';

let session, ready, parent, input;
beforeEach(() => {
    vi.clearAllMocks();
    chatManager.flushNow.mockResolvedValue(undefined);
    storageAdapter.get.mockResolvedValue({});
    storageAdapter.set.mockResolvedValue(undefined);
    storageAdapter.remove.mockResolvedValue(undefined);
    state.saveReading.mockResolvedValue(undefined);
    state.extension = false;
    state.start = new Promise((resolve) => {
        ready = resolve;
    });
    parent = { postMessage: vi.fn() };
    vi.stubGlobal('parent', parent);
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            disconnect() {}
        }
    );
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    document.body.innerHTML =
        '<div id="chat-container"></div><div id="input-container"><div id="message-input" contenteditable="true" tabindex="0"></div></div>';
    input = document.getElementById('message-input');
    uiStore.set({ page: null, menu: false, editing: null, phase: 'idle' });
});
afterEach(() => {
    session?.dispose();
    session = null;
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
function start() {
    session = createSession({
        messageInput: input,
        chatContainer: document.getElementById('chat-container'),
    });
}
function key(options) {
    const event = new KeyboardEvent('keydown', {
        key: 'x',
        code: 'KeyX',
        bubbles: true,
        cancelable: true,
        ...options,
    });
    input.dispatchEvent(event);
    return event;
}
function message(source, type) {
    window.dispatchEvent(new MessageEvent('message', { source, data: { type } }));
}

describe('new chat shortcut delivery', () => {
    it('coalesces rapid new-chat clicks into one navigation', async () => {
        start();
        await Promise.all([session.newChat(),session.newChat(),session.newChat()]);
        expect(chatManager.createNewChat).toHaveBeenCalledOnce();
        expect(chatManager.switchChat).toHaveBeenCalledOnce();
    });
    it('accepts page selection actions only through the current sidebar token', async () => {
        state.extension = true;
        window.history.replaceState(null, '', '#selectionToken=private-channel');
        start();
        const dispatch = (source, token, action = 'add') =>
            window.dispatchEvent(
                new MessageEvent('message', {
                    source,
                    data: {
                        type: 'CEREBR_SELECTION_ACTION',
                        token,
                        text: 'Page passage',
                        prompt: 'Explain',
                        action,
                    },
                })
            );
        dispatch(parent, 'incorrect');
        dispatch({}, 'private-channel');
        expect(session.editor.getDraftSnapshot().quotes).toEqual([]);
        dispatch(parent, 'private-channel');
        expect(session.editor.getDraftSnapshot().quotes).toEqual(['Page passage']);
        dispatch(parent, 'private-channel', 'send');
        expect(session.pipeline.sendSelection).toHaveBeenCalledWith('Page passage', 'Explain');
        window.history.replaceState(null, '', '/');
    });
    it('preserves an unsaved draft across navigation when storage is stalled', async () => {
        start();
        session.editor.setDraft('unsaved question');
        session.editor.addQuote('A passage to keep');
        let release;
        storageAdapter.set.mockReturnValue(
            new Promise((resolve) => {
                release = resolve;
            })
        );
        state.saveReading.mockReturnValue(new Promise(() => {}));
        let finished = false;
        const navigation = session.switchChat('existing').then(() => {
            finished = true;
        });
        try {
            // Storage remains unresolved throughout this assertion. Allow the
            // parallel suite enough scheduling time without weakening that check.
            await vi.waitFor(() => expect(finished).toBe(true), { timeout: 1000 });
            expect(session.editor.getDraft()).toBe('');
            await session.switchChat('old');
            expect(session.editor.getDraft()).toBe('unsaved question');
            expect(session.editor.getDraftSnapshot().quotes).toEqual(['A passage to keep']);
        } finally {
            release();
            await navigation;
        }
    });
    it('publishes idle for the completed chat before the pipeline clears the local request ID',()=>{
        start();
        state.pipelineOptions.onPhase('thinking','request-chat');
        state.pipelineOptions.onPhase('replying','request-chat');
        state.pipelineOptions.onPhase('idle','request-chat');
        expect(publishProgress).toHaveBeenLastCalledWith(expect.objectContaining({phase:'idle',chatId:'request-chat'}));
        expect(uiStore.getSnapshot().requestChatId).toBeNull();
        expect(uiStore.getSnapshot().phase).toBe('idle');
    });

    it('clears submitted drafts in order without blocking a model request on storage', async () => {
        start();
        session.editor.setDraft('question');
        let release;
        storageAdapter.set.mockReturnValueOnce(
            new Promise((resolve) => {
                release = resolve;
            })
        );
        const saved = session.saveDraft();
        await Promise.resolve();
        await state.pipelineOptions.onSubmitted('old');
        expect(storageAdapter.remove).not.toHaveBeenCalled();
        release();
        await saved;
        await vi.waitFor(() => expect(storageAdapter.remove).toHaveBeenCalledWith('cerebr_draft_v1_old'));
    });

    it('keeps the reading position from thinking through completion for selection questions', async () => {
        start();
        const container = document.getElementById('chat-container');
        Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 4000 });
        container.scrollTop = 720;
        container.__cerebrUserPausedAutoScroll = false;
        // Model the React layout effect: each phase update may follow the tail.
        const unsubscribe = uiStore.subscribe(() => {
            if (!container.__cerebrUserPausedAutoScroll) container.scrollTop = container.scrollHeight;
        });
        requestAnimationFrame.mockClear();
        try {
            state.pipelineOptions.onPhase('thinking', 'old', { preserveReadingPosition: true });
            expect(container.scrollTop).toBe(720);
            await state.pipelineOptions.onSubmitted('old', { preserveDraft: true, preserveReadingPosition: true });
            state.pipelineOptions.onPhase('replying', 'old');
            state.pipelineOptions.onPhase('idle', 'old');
            expect(container.scrollTop).toBe(720);
            expect(container.__cerebrUserPausedAutoScroll).toBe(true);
            expect(requestAnimationFrame).not.toHaveBeenCalled();
            expect(storageAdapter.remove).not.toHaveBeenCalled();

            // A later normal composer submission resumes following as before.
            await state.pipelineOptions.onSubmitted('old');
            requestAnimationFrame.mock.calls.at(-1)[0]();
            expect(container.scrollTop).toBe(4000);
            expect(container.__cerebrUserPausedAutoScroll).toBe(false);
        } finally { unsubscribe(); }
    });

    it('does not let a queued send scroll override a new reading pause', async () => {
        start();
        const container = document.getElementById('chat-container');
        Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 4000 });
        await state.pipelineOptions.onSubmitted('old');
        const scroll = requestAnimationFrame.mock.calls.at(-1)[0];
        container.scrollTop = 720;
        state.pipelineOptions.onPhase('thinking', 'old', { preserveReadingPosition: true });
        scroll();
        expect(container.scrollTop).toBe(720);
    });

    it('still navigates when ancillary storage writes reject', async () => {
        start();
        session.editor.setDraft('keep this draft');
        const failure = new Error('Quota exceeded');
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        storageAdapter.set.mockRejectedValue(failure);
        state.saveReading.mockRejectedValue(failure);
        await session.switchChat('existing');
        expect(uiStore.getSnapshot().page).toBe(null);
        await session.switchChat('old');
        expect(session.editor.getDraft()).toBe('keep this draft');
        await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(expect.any(String), failure));
        storageAdapter.set.mockResolvedValue(undefined);
        state.saveReading.mockResolvedValue(undefined);
    });

    it.each(['new', 'existing'])(
        'opens %s chat without waiting for pending message persistence',
        async (id) => {
            start();
            let release;
            chatManager.flushNow.mockReturnValue(
                new Promise((resolve) => {
                    release = resolve;
                })
            );
            uiStore.set({ page: 'chat-list' });
            let finished = false;
            const navigation = (id === 'new' ? session.newChat() : session.switchChat(id)).then(() => {
                finished = true;
            });
            try {
                await vi.waitFor(() => expect(finished).toBe(true), { timeout: 1000 });
                expect(chatManager.switchChat).toHaveBeenCalledWith(id);
                expect(chatManager.setChatModel).not.toHaveBeenCalled();
                expect(uiStore.getSnapshot().page).toBe(null);
            } finally {
                release();
                await navigation;
            }
        }
    );

    it.each([
        ['MacIntel', { ctrlKey: true }],
        ['Win32', { altKey: true }],
        ['Linux x86_64', { altKey: true }],
    ])('creates a chat and restores input focus on %s', async (platform, modifiers) => {
        vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
        start();
        expect(key(modifiers).defaultPrevented).toBe(true);
        await vi.waitFor(() => expect(document.activeElement).toBe(input));
        expect(chatManager.createNewChat).toHaveBeenCalledOnce();
        expect(chatManager.switchChat).toHaveBeenCalledWith('new');
        session.dispose();
        session = null;
        key(modifiers);
        expect(chatManager.createNewChat).toHaveBeenCalledOnce();
    });

    it('does not take over Command+X or IME composition', () => {
        start();
        expect(key({ metaKey: true }).defaultPrevented).toBe(false);
        expect(key({ ctrlKey: true, isComposing: true }).defaultPrevented).toBe(false);
        expect(chatManager.createNewChat).not.toHaveBeenCalled();
    });

    it('announces iframe readiness so the host can deliver a queued extension command', async () => {
        state.extension = true;
        // The existing content-script host waits for this protocol message before
        // forwarding NEW_CHAT or FOCUS_INPUT to the iframe.
        const queued = ['NEW_CHAT', 'FOCUS_INPUT'];
        parent.postMessage.mockImplementation(({ type }) => {
            if (type === 'CEREBR_IFRAME_READY') {
                for (const command of queued.splice(0)) message(parent, command);
            }
        });
        start();
        key({ ctrlKey: true });
        message(window, 'NEW_CHAT');
        expect(chatManager.createNewChat).not.toHaveBeenCalled();
        expect(parent.postMessage).not.toHaveBeenCalled();
        ready();
        await vi.waitFor(() => expect(document.activeElement).toBe(input));
        expect(setWebpageSwitchesForChat).not.toHaveBeenCalled();
        expect(queued).toEqual([]);
        expect(chatManager.createNewChat).toHaveBeenCalledOnce();
        expect(document.activeElement).toBe(input);
        session.dispose();
        session = null;
        message(parent, 'NEW_CHAT');
        expect(chatManager.createNewChat).toHaveBeenCalledOnce();
    });

    it('does not announce a disposed session when asynchronous startup completes', async () => {
        state.extension = true;
        start();
        session.dispose();
        session = null;
        ready();
        await state.start;
        expect(parent.postMessage).not.toHaveBeenCalled();
    });
});

it('navigation leaves other requests running and completion clears only its own phase',async()=>{
 start();
 chatManager.currentChatId='old';
 state.pipelineOptions.onPhase('thinking','old');
 await session.switchChat('new');
 expect(session.pipeline.abortActiveReply).not.toHaveBeenCalled();
 chatManager.currentChatId='new';
 state.pipelineOptions.onPhase('thinking','new');
 state.pipelineOptions.onPhase('replying','old');
 expect(uiStore.getSnapshot().phase).toBe('thinking');
 expect(Object.keys(uiStore.getSnapshot().localRequests)).toEqual(expect.arrayContaining(['old','new']));
 state.pipelineOptions.onPhase('idle','old');
 expect(uiStore.getSnapshot().localRequests.old).toBeUndefined();
 expect(uiStore.getSnapshot().localRequests.new.phase).toBe('thinking');
 state.pipelineOptions.onPhase('idle','new');
 expect(uiStore.getSnapshot().phase).toBe('idle');
});
