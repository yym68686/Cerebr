import { publishProgress, publishLiveChat, subscribeRemoteProgress } from '../runtime/sync/ui-sync.js';
import { createMessageActions } from './message-actions.js';
import { chatManager } from '../domain/chat/chat-store.js';
import { createChatPipeline } from '../runtime/chat/chat-pipeline.js';
import { createEditorController } from '../runtime/input/editor-controller.js';
import {
    attachNativeEditor,
    addImageFilesToDraft,
    buildMessageContent,
    setMessageInputContent,
    setPlaceholder,
    setPlaceholderRestoreResolver,
} from '../runtime/input/native-editor.js';
import { storageAdapter, browserAdapter, isExtensionEnvironment } from '../utils/storage-adapter.js';
import { loadApiConfigs, getSelectedApiConfig, saveApiConfigs, selectConfig, apiStore } from './state/api-configs.js';
import { modelSelection } from '../domain/chat/model-selection.js';
import { uiStore, openPage, notify } from './state/ui-store.js';
import { getEnabledTabsContent } from '../runtime/webpage/webpage-context.js';
import { desktopBrowserStore } from '../platform/desktop-browser.js';
import { createReadingProgressManager } from '../utils/reading-progress.js';
import { syncChatBottomExtraPadding } from '../utils/scroll.js';
import { createShellPluginRuntime } from '../plugin/shell/shell-plugin-runtime.js';
import { loadPreferences } from './state/preferences.js';
import { attachSidebarDrag } from '../platform/sidebar-drag.js';
import { t } from '../utils/i18n.js';
import { attachDesktopUpdates } from '../platform/desktop-updates.js';
import { attachChatSelectAll } from './chat-selection.js';

export function createSession({ messageInput, chatContainer }) {
    const detachSidebarDrag = attachSidebarDrag(chatContainer);
    const detachSelectAll = attachChatSelectAll(
        chatContainer,
        () => !uiStore.getSnapshot().page && !uiStore.getSnapshot().navigationOpen
    );
    const events = new AbortController();
    const listen = (target, type, handler, options = {}) =>
        target.addEventListener(type, handler, { ...options, signal: events.signal });
    const uiConfig = {
        textarea: { maxHeight: 200 },
        imageTag: {
            onImageClick: (image) => uiStore.set({ image }),
            onDeleteClick: (node) => {
                node.remove();
                messageInput.dispatchEvent(new Event('input', { bubbles: true }));
            },
        },
    };
    const editor = createEditorController({ messageInput, uiConfig });
    const inputContainer = document.getElementById('input-container');
    const runtime = createShellPluginRuntime({
        messageInput,
        inputContainer,
        inputActionsContainer: document.getElementById('plugin-input-actions'),
        slashCommandsContainer: document.getElementById('plugin-slash-commands'),
        menuItemsContainer: document.getElementById('plugin-menu-items'),
        slotContainers: Object.fromEntries(
            [...document.querySelectorAll('[data-plugin-slot^="shell."]')].map((el) => [
                el.dataset.pluginSlot,
                el,
            ])
        ),
        pageElements: {
            root: document.getElementById('plugin-shell-page'),
            backButton: document.getElementById('plugin-shell-page-back'),
            titleElement: document.getElementById('plugin-shell-page-title'),
            subtitleElement: document.getElementById('plugin-shell-page-subtitle'),
            bodyElement: document.getElementById('plugin-shell-page-body'),
        },
    });
    const reading = createReadingProgressManager({
        chatContainer,
        getActiveChatId: () => chatManager.currentChatId,
        storage: storageAdapter,
    });
    let activeDraftId = chatManager.currentChatId;
    let draftTimer;
    let disposed = false;
    let restoreVersion = 0;
    let pendingReadingId = chatManager.currentChatId;
    const draftKey = (id) => `cerebr_draft_v1_${id}`;
    const draftSnapshots = new Map();
    const draftWrites = new Map();
    const reportStorageError = (error) => {
        console.error('[Cerebr] Failed to persist session data', error);
        notify(t('error_session_persistence'), { type: 'error', durationMs: 6000 });
    };
    const writeDraft = (id, content) => {
        // Keep an in-memory copy before navigating and serialize writes per chat
        // so a slow draft save cannot resurrect a draft after it was submitted.
        draftSnapshots.set(id, content);
        const previous = draftWrites.get(id) || Promise.resolve();
        const write = previous
            .catch(() => {})
            .then(() =>
                content === null
                    ? storageAdapter.remove(draftKey(id))
                    : storageAdapter.set({ [draftKey(id)]: content })
            );
        draftWrites.set(id, write);
        const clear = (saved) => {
            if (draftWrites.get(id) !== write) return;
            draftWrites.delete(id);
            if (saved) draftSnapshots.delete(id);
        };
        void write.then(
            () => clear(true),
            () => clear(false)
        );
        return write;
    };
    const saveDraft = async () => {
        clearTimeout(draftTimer);
        if (!activeDraftId || uiStore.getSnapshot().editing) return;
        const draft = editor.getDraftSnapshot();
        await writeDraft(
            activeDraftId,
            draft.empty
                ? null
                : { content: buildMessageContent(draft.text, draft.imageTags), quotes: draft.quotes || [] }
        );
    };
    const restoreDraft = async () => {
        const version = ++restoreVersion;
        const id = activeDraftId;
        const data = draftSnapshots.has(id)
            ? { [draftKey(id)]: draftSnapshots.get(id) }
            : await storageAdapter.get(draftKey(id));
        if (disposed || id !== activeDraftId || version !== restoreVersion || editor.hasDraft()) return;
        const draft = data[draftKey(id)];
        if (draft) {
            const snapshot = typeof draft === 'string' || Array.isArray(draft) ? { content: draft } : draft;
            setMessageInputContent(messageInput, snapshot.content, uiConfig, snapshot.quotes);
        }
    };
    const liveRequests = new Map();
    const syncActivePhase = () => {
        const active = uiStore.getSnapshot().localRequests?.[chatManager.currentChatId];
        uiStore.set({ phase: active?.phase || 'idle', requestChatId: active ? chatManager.currentChatId : null,
            requestStartedAt: active?.startedAt || null });
    };
    const sendLive = (chatId, phase, full = false) => {
        const chat = chatManager.chats.get(chatId), request = liveRequests.get(chatId);
        if (!chat?.messages.length || !request) return;
        const index = chat.messages.length - 1;
        publishLiveChat({
            chatId, requestId: request.id, sequence: ++request.sequence,
            phase, startedAt: request.startedAt,
            ...(full ? { chat } : { index, message: chat.messages[index] }),
        });
    };
    const pipeline = createChatPipeline({
        chatManager,
        editor,
        getSelectedApiConfig,
        getWebpageInfo: (id) =>
            isExtensionEnvironment || desktopBrowserStore.getSnapshot().session
                ? getEnabledTabsContent(id)
                : null,
        getUserLanguage: () => navigator.language,
        pluginRuntime: runtime,
        onPhase: (phase, requestChatId, { preserveReadingPosition = false } = {}) => {
            if (preserveReadingPosition && requestChatId === chatManager.currentChatId)
                chatContainer.__cerebrUserPausedAutoScroll = true;
            if (phase === 'thinking') liveRequests.set(requestChatId, {
                id: crypto.randomUUID(), sequence: 0, startedAt: Date.now(),
            });
            const request = liveRequests.get(requestChatId);
            if (requestChatId) {
                publishProgress({ phase, chatId: requestChatId, startedAt: request?.startedAt });
                sendLive(requestChatId, phase, phase !== 'replying');
            }
            uiStore.set(state => {
                if (phase !== 'idle' && state.localRequests?.[requestChatId]?.phase === phase) return state;
                const localRequests = { ...state.localRequests }, remoteProgress = { ...state.remoteProgress };
                if (phase === 'idle') { delete localRequests[requestChatId]; delete remoteProgress[requestChatId]; }
                else localRequests[requestChatId] = { phase, startedAt: request?.startedAt };
                return { ...state, localRequests, remoteProgress };
            });
            if (phase === 'idle') liveRequests.delete(requestChatId);
            syncActivePhase();
        },
        onSubmitted: (id, { preserveDraft = false, preserveReadingPosition = false } = {}) => {
            sendLive(id, 'thinking', true);
            if (!preserveReadingPosition && chatManager.currentChatId === id) {
                chatContainer.__cerebrUserPausedAutoScroll = false;
                requestAnimationFrame(() => {
                    if (chatManager.currentChatId === id && !chatContainer.__cerebrUserPausedAutoScroll)
                        chatContainer.scrollTop = chatContainer.scrollHeight;
                });
            }
            if (preserveDraft) return;
            if (activeDraftId === id) clearTimeout(draftTimer);
            void writeDraft(id, null).catch(reportStorageError);
        },
        onSettled: () => void reading.saveNow().catch(reportStorageError),
    });
    const detachProgress = subscribeRemoteProgress((progress) => {
        uiStore.set((state) => {
            const remoteProgress = progress.reset ? {} : { ...state.remoteProgress };
            const remoteStartedAt = progress.reset ? {} : { ...state.remoteStartedAt };
            if (progress.chatId && progress.startedAt) remoteStartedAt[progress.chatId] = progress.startedAt;
            if (progress.chatId) {
                if (progress.phase === 'idle') delete remoteProgress[progress.chatId];
                else remoteProgress[progress.chatId] = progress.phase;
            }
            return { ...state, remoteProgress, remoteStartedAt };
        });
    });
    runtime.attachChatRuntime(pipeline);
    const { startEdit, cancelEdit, confirmEdit, deleteMessage, regenerateMessage } = createMessageActions({
        chatManager,
        editor,
        pipeline,
        setInputContent: (content) => setMessageInputContent(messageInput, content, uiConfig),
    });
    const userQuestions = [];
    const syncQuestions = () => {
        syncActivePhase();
        userQuestions.splice(
            0,
            userQuestions.length,
            ...(chatManager.getCurrentChat()?.messages || [])
                .filter((m) => m.role === 'user' && !m.seedLocaleBound)
                .map((m) =>
                    typeof m.content === 'string'
                        ? m.content
                        : m.content
                              ?.filter((p) => p.type === 'text')
                              .map((p) => p.text)
                              .join('\n') || ''
                )
        );
    };
    syncQuestions();
    const unlistenChat = chatManager.subscribe(syncQuestions);
    const detachEditor = attachNativeEditor({
        messageInput,
        sendMessage: pipeline.sendMessage,
        onDropState: dropPhase => uiStore.set({ dropPhase }),
        dropEnabled: () => !uiStore.getSnapshot().page,
        confirmMessageEdit: confirmEdit,
        isEditingMessage: () => !!uiStore.getSnapshot().editing,
        cancelMessageEdit: cancelEdit,
        userQuestions,
        uiConfig,
        settingsMenu: document.getElementById('settings-menu'),
        onDismissMenus: () => {
            if (!uiStore.getSnapshot().webpageMenu) uiStore.set({ menu: false });
        },
        hideContextMenu: () => uiStore.set({ context: null }),
    });
    listen(messageInput, 'input', () => {
        clearTimeout(draftTimer);
        draftTimer = setTimeout(() => void saveDraft().catch(reportStorageError), 400);
    });
    const switchChat = async (id) => {
        cancelEdit();
        void saveDraft().catch(reportStorageError);
        void reading.saveNow().catch(reportStorageError);
        pendingReadingId = id;
        await chatManager.switchChat(id);
        syncActivePhase();
        // A completed reply may still be writing. Navigation must not join that
        // write queue; the store retains and retries any failed chat writes.
        void chatManager.flushNow().catch((error) => {
            console.error('[Cerebr] Failed to persist chat during navigation', error);
            notify(t('error_chat_persistence'), { type: 'error' });
        });
        activeDraftId = id;
        editor.clear();
        openPage(null);
        chatContainer.__cerebrUserPausedAutoScroll = true;
        void restoreDraft().catch(reportStorageError);
        document.dispatchEvent(new CustomEvent('cerebr:chatSwitched', { detail: { chatId: id } }));
        requestAnimationFrame(() => {
            if (
                chatContainer.querySelectorAll('.message').length >=
                    chatManager.getCurrentChat().messages.length &&
                pendingReadingId === id
            ) {
                pendingReadingId = null;
                void reading.restore(id);
            }
        });
    };
    let newChatTask;
    const newChat = () => {
        if (newChatTask) return newChatTask;
        newChatTask = (async () => {
            let chat = chatManager.createNewChat(t('chat_new_title'));
            if (liveRequests.has(chat.id))
                chat = chatManager.createChat({ title: t('chat_new_title'), persist: false });
            if (chatManager.currentChatId !== chat.id) await switchChat(chat.id);
            else openPage(null);
            editor.focus();
        })().finally(() => { newChatTask = null; });
        return newChatTask;
    };
    const removeChat = async (id) => {
        await pipeline.abortActiveReply(id);
        if (chatManager.currentChatId === id) {
            cancelEdit();
        }
        await chatManager.deleteChat(id);
        if (activeDraftId === id) {
            activeDraftId = chatManager.currentChatId;
            editor.clear();
            await restoreDraft();
        }
        await writeDraft(id, null);
        await reading.clear(id);
    };
    const flush = () => {
        void saveDraft().catch(reportStorageError);
        void reading.saveNow().catch(reportStorageError);
        void chatManager.flushNow().catch((error) => {
            console.error('[Cerebr] Failed to flush chat persistence', error);
            notify(t('error_chat_persistence'), { type: 'error', durationMs: 6000 });
        });
        void saveApiConfigs().catch(reportStorageError);
    };
    listen(
        document,
        'keydown',
        (event) => {
            if (isExtensionEnvironment || event.isComposing) return;
            const isMac = /mac|iphone|ipad|ipod/i.test(
                navigator.userAgentData?.platform || navigator.platform || ''
            );
            if (
                (event.code === 'KeyX' || event.key?.toLowerCase() === 'x') &&
                (isMac
                    ? event.ctrlKey && !event.metaKey && !event.altKey
                    : event.altKey && !event.ctrlKey && !event.metaKey)
            ) {
                event.preventDefault();
                event.stopPropagation();
                void newChat();
            }
        },
        { capture: true }
    );
    listen(window, 'pagehide', flush);
    listen(document, 'visibilitychange', () => {
        if (document.hidden) flush();
    });
    listen(window, 'message', (event) => {
        if (event.source !== window.parent || !isExtensionEnvironment) return;
        const data = event.data || {};
        if (data.type === 'NEW_CHAT') void newChat();
        if (data.type === 'FOCUS_INPUT') editor.focus();
        if (data.type === 'CEREBR_SELECTION_ACTION') {
            const token = new URLSearchParams(location.hash.slice(1)).get('selectionToken');
            if (!token || data.token !== token || typeof data.text !== 'string' || !data.text.trim()) return;
            openPage(null);
            if (data.action === 'add') {
                editor.addQuote(data.text);
                editor.focus();
            } else if (data.action === 'send' && typeof data.prompt === 'string' && data.prompt.trim())
                void pipeline.sendSelection(data.text, data.prompt);
        }
        if (data.type === 'UPDATE_PLACEHOLDER')
            setPlaceholder({ messageInput, placeholder: data.placeholder, timeout: data.timeout });
        if (data.type === 'DROP_IMAGE' && data.imageData?.data) {
            const draft = editor.getDraftSnapshot();
            const content = buildMessageContent(draft.text, draft.imageTags);
            const parts = Array.isArray(content) ? content : content ? [{ type: 'text', text: content }] : [];
            parts.push({
                type: 'image_url',
                image_url: {
                    url: data.imageData.data.startsWith('data:')
                        ? data.imageData.data
                        : `data:image/png;base64,${data.imageData.data}`,
                },
            });
            setMessageInputContent(messageInput, parts, uiConfig, draft.quotes);
            editor.focus();
        }
    });
    const unsubscribeTabs = browserAdapter.onTabActivated(async (info) => {
        if (document.hidden || liveRequests.size) return;
        const tab = await browserAdapter.getCurrentTab();
        if (info?.tabId && info.tabId !== tab?.id) return;
        await saveDraft();
        await chatManager.flushNow();
        await Promise.all([loadApiConfigs(), loadPreferences(), chatManager.initialize()]);
        if (activeDraftId !== chatManager.currentChatId) {
            activeDraftId = chatManager.currentChatId;
            editor.clear();
            await restoreDraft();
            pendingReadingId = activeDraftId;
            document.dispatchEvent(
                new CustomEvent('cerebr:chatSwitched', { detail: { chatId: activeDraftId } })
            );
        }
    });
    const observer = new ResizeObserver(() => syncChatBottomExtraPadding());
    observer.observe(inputContainer);
    listen(document, 'cerebr:chatContentLoaded', (event) => {
        if (pendingReadingId && event.detail.chatId === pendingReadingId) {
            const id = pendingReadingId;
            pendingReadingId = null;
            void reading.restore(id);
        }
    });
    reading.start();
    const detachUpdates = attachDesktopUpdates({
        uiStore,
        persist: async () => {
            await saveDraft();
            await Promise.all([...draftWrites.values()]);
            await reading.saveNow();
            await chatManager.flushNow();
            await saveApiConfigs();
        },
    });
    void restoreDraft();
    requestAnimationFrame(() => void reading.restore(chatManager.currentChatId));
    void runtime
        .start()
        .then(() => {
            if (disposed) return runtime.stop();
            if (isExtensionEnvironment && window.parent !== window)
                window.parent.postMessage({ type: 'CEREBR_IFRAME_READY' }, '*');
        })
        .catch((error) => notify(error.message, { type: 'error' }));
    return {
        editor,
        runtime,
        pipeline,
        switchChat,
        newChat,
        selectModel: async (index) => {
            const selection = modelSelection(apiStore.getSnapshot().configs[index]);
            const saved = chatManager.setChatModel(chatManager.currentChatId, selection);
            await selectConfig(index);
            await saved;
        },
        removeChat,
        startEdit,
        cancelEdit,
        confirmEdit,
        deleteMessage,
        regenerateMessage,
        saveDraft,
        addImages: (files) => addImageFilesToDraft(messageInput, files, uiConfig),
        dispose() {
            disposed = true;
            detachUpdates();
            detachSelectAll();
            for (const [chatId, request] of liveRequests)
                publishProgress({ phase: 'idle', chatId, startedAt: request.startedAt });
            flush();
            void pipeline.abortAll();
            events.abort();
            unsubscribeTabs();
            detachEditor();
            detachSidebarDrag?.();
            detachProgress();
            unlistenChat();
            observer.disconnect();
            reading.stop();
            clearTimeout(draftTimer);
            void runtime.stop();
            setPlaceholderRestoreResolver(null);
        },
    };
}
