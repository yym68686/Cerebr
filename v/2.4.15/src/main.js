import { setTheme } from './utils/theme.js';
import { callAPI } from './services/chat.js';
import { chatManager } from './utils/chat-manager.js';
import { appendMessage } from './handlers/message-handler.js';
import { hideContextMenu } from './components/context-menu.js';
import { initChatContainer } from './components/chat-container.js';
import { showImagePreview, hideImagePreview, showToast } from './utils/ui.js';
import { renderAPICards, createCardCallbacks, selectCard } from './components/api-card.js';
import { storageAdapter, syncStorageAdapter, browserAdapter, isExtensionEnvironment } from './utils/storage-adapter.js';
import { initMessageInput, getFormattedMessageContent, buildMessageContent, clearMessageInput, handleWindowMessage, moveCaretToEnd, setPlaceholder } from './components/message-input.js';
import './utils/viewport.js';
import {
    hideChatList,
    initChatListEvents,
    loadChatContent,
    initializeChatList
} from './components/chat-list.js';
import { initWebpageMenu, getEnabledTabsContent } from './components/webpage-menu.js';
import { normalizeChatCompletionsUrl } from './utils/api-url.js';
import { ensureChatElementVisible, syncChatBottomExtraPadding } from './utils/scroll.js';
import { createReadingProgressManager } from './utils/reading-progress.js';
import { applyI18n, initI18n, getLanguagePreference, setLanguagePreference, reloadI18n, t } from './utils/i18n.js';
import { setWebpageSwitchesForChat } from './utils/webpage-switches.js';

// 存储用户的问题历史
let userQuestions = [];

// 将 API 配置提升到模块作用域，以确保在异步事件中状态的稳定性
// 加载保存的 API 配置
let apiConfigs = [];
let selectedConfigIndex = 0;

const onDomReady = async () => {
    try {
        await initI18n();
        applyI18n(document);

        const chatContainer = document.getElementById('chat-container');
        const messageInput = document.getElementById('message-input');
        const contextMenu = document.getElementById('context-menu');
        const copyMessageButton = document.getElementById('copy-message');
        const copyCodeButton = document.getElementById('copy-code');
        const copyImageButton = document.getElementById('copy-image');
        const stopUpdateButton = document.getElementById('stop-update');
        const settingsButton = document.getElementById('settings-button');
        const settingsMenu = document.getElementById('settings-menu');
        const preferencesToggle = document.getElementById('preferences-toggle');
        const previewModal = document.querySelector('.image-preview-modal');
        const previewImage = previewModal?.querySelector('img') || null;
        const chatListPage = document.getElementById('chat-list-page');
        const newChatButton = document.getElementById('new-chat');
        const chatListButton = document.getElementById('chat-list');
        const apiSettings = document.getElementById('api-settings');
        const preferencesSettings = document.getElementById('preferences-settings');
        const deleteMessageButton = document.getElementById('delete-message');
        const regenerateMessageButton = document.getElementById('regenerate-message');
        const webpageQAContainer = document.getElementById('webpage-qa');
        const webpageContentMenu = document.getElementById('webpage-content-menu');
        const preferencesVersion = document.getElementById('preferences-version');
        const preferencesFontScale = document.getElementById('preferences-font-scale');
        const preferencesFeedback = document.getElementById('preferences-feedback');
        const preferencesLanguage = document.getElementById('preferences-language');
        const scrollToBottomButton = document.getElementById('scroll-to-bottom');

        if (!chatContainer || !messageInput || !contextMenu) {
            console.error('[Cerebr] 初始化失败：缺少 #chat-container / #message-input / #context-menu');
            return;
        }

        const isNearBottom = (container, thresholdPx = 120) => {
            if (!container) return false;
            const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
            return remaining < thresholdPx;
        };

        const shouldStickToBottom = (container, thresholdPx = 120) => {
            if (!container) return false;
            return !container.__cerebrUserPausedAutoScroll && isNearBottom(container, thresholdPx);
        };

        const setThinkingPlaceholder = () => {
            setPlaceholder({ messageInput, placeholder: t('message_input_placeholder_thinking') });
        };

        const setReplyingPlaceholder = () => {
            setPlaceholder({ messageInput, placeholder: t('message_input_placeholder_replying') });
        };

        const restoreDefaultPlaceholder = () => {
            setPlaceholder({ messageInput, placeholder: t('message_input_placeholder') });
        };

        syncChatBottomExtraPadding();
        window.addEventListener('resize', () => syncChatBottomExtraPadding());

        const initScrollToBottomButton = () => {
            if (!scrollToBottomButton) return;

            const VISIBILITY_THRESHOLD_PX = 24;
            const PADDING_CACHE_TTL_MS = 240;
            let rafId = 0;
            let cachedPaddingBottomPx = null;
            let paddingCachedAt = 0;

            const invalidatePaddingCache = () => {
                cachedPaddingBottomPx = null;
                paddingCachedAt = 0;
            };

            const getPaddingBottomPx = () => {
                const now = performance.now();
                if (cachedPaddingBottomPx == null || now - paddingCachedAt > PADDING_CACHE_TTL_MS) {
                    cachedPaddingBottomPx = Number.parseFloat(getComputedStyle(chatContainer).paddingBottom) || 0;
                    paddingCachedAt = now;
                }
                return cachedPaddingBottomPx;
            };

            const update = () => {
                rafId = 0;
                if (!chatContainer?.isConnected || !scrollToBottomButton.isConnected) return;

                const remaining = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight;
                const threshold = getPaddingBottomPx() + VISIBILITY_THRESHOLD_PX;
                const shouldShow = remaining > threshold;

                scrollToBottomButton.classList.toggle('visible', shouldShow);
                scrollToBottomButton.tabIndex = shouldShow ? 0 : -1;
                if (shouldShow) {
                    scrollToBottomButton.removeAttribute('aria-hidden');
                } else {
                    scrollToBottomButton.setAttribute('aria-hidden', 'true');
                }
            };

            const scheduleUpdate = () => {
                if (rafId) return;
                rafId = requestAnimationFrame(update);
            };

            const scrollToBottom = (behavior = 'smooth') => {
                chatContainer.__cerebrUserPausedAutoScroll = false;
                if (typeof chatContainer.scrollTo === 'function') {
                    chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior });
                } else {
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                }
                scheduleUpdate();
            };

            scrollToBottomButton.tabIndex = -1;
            scrollToBottomButton.setAttribute('aria-hidden', 'true');
            scrollToBottomButton.addEventListener('click', () => scrollToBottom('smooth'));

            chatContainer.addEventListener('scroll', scheduleUpdate, { passive: true });
            window.addEventListener('resize', () => {
                invalidatePaddingCache();
                scheduleUpdate();
            });

            document.addEventListener('cerebr:chatContentChunk', scheduleUpdate);
            document.addEventListener('cerebr:chatContentLoaded', scheduleUpdate);
            document.addEventListener('cerebr:chatSwitched', () => {
                invalidatePaddingCache();
                scheduleUpdate();
            });

            if (typeof MutationObserver !== 'undefined') {
                const observer = new MutationObserver(scheduleUpdate);
                observer.observe(chatContainer, { childList: true, subtree: true });
            }

            const inputContainer = document.getElementById('input-container');
            if (inputContainer && typeof ResizeObserver !== 'undefined') {
                const observer = new ResizeObserver(() => {
                    invalidatePaddingCache();
                    scheduleUpdate();
                });
                observer.observe(inputContainer);
            }

            scheduleUpdate();
        };

        initScrollToBottomButton();

    // 网页版“新的对话”快捷键：Windows/Default Alt+X，Mac Ctrl+X
    // 扩展环境下由浏览器 commands 统一处理，避免重复触发。
    if (!isExtensionEnvironment) {
        const platform = navigator.userAgentData?.platform || navigator.platform || '';
        const isMac = /mac|iphone|ipad|ipod/i.test(platform);

        const isNewChatShortcut = (event) => {
            if (event.isComposing) return false;
            const code = event.code;
            const key = (event.key || '').toLowerCase();
            const isX = code ? code === 'KeyX' : key === 'x';
            if (!isX) return false;

            if (isMac) {
                return !!(event.ctrlKey && !event.metaKey && !event.altKey);
            }
            return !!(event.altKey && !event.ctrlKey && !event.metaKey);
        };

        document.addEventListener('keydown', (event) => {
            if (!newChatButton) return;
            if (!isNewChatShortcut(event)) return;
            event.preventDefault();
            event.stopPropagation();
            newChatButton.click();
        }, { capture: true });
    }

    // 基础键盘可访问性：菜单可用 Enter/Space 触发，方向键切换
    document.addEventListener('keydown', (e) => {
        const active = document.activeElement;
        if (!active || active.getAttribute('role') !== 'menuitem') return;

        const menu = active.closest?.('[role="menu"]');
        if (menu && !menu.classList.contains('visible')) {
            // 菜单被隐藏时不抢键盘事件
            return;
        }

        const isVisible = (el) => {
            const style = getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden';
        };

        const getMenuItems = () => {
            if (!menu) return [];
            return Array.from(menu.querySelectorAll('[role="menuitem"]')).filter(isVisible);
        };

        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            active.click();
            return;
        }

        if (!menu) return;

        const items = getMenuItems();
        if (items.length === 0) return;

        const currentIndex = Math.max(0, items.indexOf(active));

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const next = items[(currentIndex + 1) % items.length];
            next?.focus?.({ preventScroll: true });
            return;
        }

        if (e.key === 'ArrowUp') {
            e.preventDefault();
            const next = items[(currentIndex - 1 + items.length) % items.length];
            next?.focus?.({ preventScroll: true });
            return;
        }

        if (e.key === 'Home') {
            e.preventDefault();
            items[0]?.focus?.({ preventScroll: true });
            return;
        }

        if (e.key === 'End') {
            e.preventDefault();
            items[items.length - 1]?.focus?.({ preventScroll: true });
            return;
        }
    });

    // 桌面端折中体验：点击聊天背景可聚焦输入框（移动端避免误触弹键盘）
    const isFinePointer = () => {
        try {
            return window.matchMedia('(any-pointer: fine)').matches || window.matchMedia('(pointer: fine)').matches;
        } catch {
            return false;
        }
    };

    chatContainer.addEventListener('click', (e) => {
        if (!isFinePointer()) return;
        if (document.activeElement === messageInput) return;
        if (window.getSelection().toString()) return;
        if (e.target.closest('#settings-button, #settings-menu, #context-menu, a, button, input, textarea, select')) return;
        messageInput.focus();
        moveCaretToEnd(messageInput);
    });

    // 侧边栏（iframe）拖动：在“空白聊天背景”按住左键可拖动外层窗口
    const initSidebarBackgroundDrag = () => {
        // 仅在被嵌入（扩展侧边栏 iframe）时启用
        if (window.top === window) return;
        if (!chatContainer) return;

        const DRAG_THRESHOLD_PX = 4;
        let activePointerId = null;
        let startScreenX = 0;
        let startScreenY = 0;
        let lastScreenX = 0;
        let lastScreenY = 0;
        let dragging = false;
        let suppressClickUntil = 0;

        const canStartDragFromTarget = (target) => {
            const el = target instanceof Element ? target : target?.parentElement;
            if (!el) return false;
            if (el.closest('.message')) return false;
            if (el.closest('#scroll-to-bottom')) return false;
            if (el.closest('#settings-button, #settings-menu, #context-menu, a, button, input, textarea, select')) return false;
            return true;
        };

        const postToParent = (payload) => {
            try {
                window.parent?.postMessage?.(payload, '*');
            } catch {
                // ignore
            }
        };

        const endDrag = () => {
            if (activePointerId === null) return;
            if (dragging) {
                postToParent({ type: 'CEREBR_SIDEBAR_DRAG_END' });
            }
            activePointerId = null;
            dragging = false;
        };

        chatContainer.addEventListener('pointerdown', (e) => {
            if (e.pointerType && e.pointerType !== 'mouse') return;
            if (e.button !== 0) return;
            if (!canStartDragFromTarget(e.target)) return;

            activePointerId = e.pointerId;
            // 用 screenX/screenY：拖动窗口本身会改变 iframe 的 clientX 坐标系，导致反馈抖动
            startScreenX = e.screenX;
            startScreenY = e.screenY;
            lastScreenX = startScreenX;
            lastScreenY = startScreenY;
            dragging = false;

            try {
                chatContainer.setPointerCapture(activePointerId);
            } catch {
                // ignore
            }
        }, { passive: true });

        chatContainer.addEventListener('pointermove', (e) => {
            if (activePointerId === null || e.pointerId !== activePointerId) return;
            const totalDx = e.screenX - startScreenX;
            const totalDy = e.screenY - startScreenY;

            if (!dragging) {
                if (Math.hypot(totalDx, totalDy) < DRAG_THRESHOLD_PX) return;
                dragging = true;
                suppressClickUntil = Date.now() + 400;
                postToParent({ type: 'CEREBR_SIDEBAR_DRAG_START' });
            }

            const dx = e.screenX - lastScreenX;
            const dy = e.screenY - lastScreenY;
            lastScreenX = e.screenX;
            lastScreenY = e.screenY;

            if (dx || dy) {
                postToParent({ type: 'CEREBR_SIDEBAR_DRAG_MOVE', dx, dy });
            }

            e.preventDefault();
        }, { passive: false });

        chatContainer.addEventListener('pointerup', (e) => {
            if (activePointerId === null || e.pointerId !== activePointerId) return;
            endDrag();
        }, { passive: true });

        chatContainer.addEventListener('pointercancel', (e) => {
            if (activePointerId === null || e.pointerId !== activePointerId) return;
            endDrag();
        }, { passive: true });

        // 拖动结束时抑制一次“点击聚焦输入框”等副作用
        chatContainer.addEventListener('click', (e) => {
            if (Date.now() < suppressClickUntil) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, { capture: true });
    };

    initSidebarBackgroundDrag();

    // 修改: 创建一个对象引用来保存当前控制器
    // pendingAbort 用于处理“首 token 前”用户立刻点停止的情况
    const abortControllerRef = { current: null, pendingAbort: false };
    let currentController = null;

    // 创建UI工具配置
    const uiConfig = {
        textarea: {
            maxHeight: 200
        },
        imagePreview: {
            previewModal,
            previewImage
        },
        imageTag: {
            onImageClick: (base64Data) => {
                if (!uiConfig.imagePreview.previewModal || !uiConfig.imagePreview.previewImage) return;
                showImagePreview({
                    base64Data,
                    config: uiConfig.imagePreview
                });
            },
            onDeleteClick: (container) => {
                container.remove();
                messageInput.dispatchEvent(new Event('input'));
            }
        }
    };

    const OSS_URL = 'https://github.com/yym68686/Cerebr';
    const FEEDBACK_URL = `${OSS_URL}/issues/new`;

    const openExternal = (url) => {
        window.open(url, '_blank', 'noopener,noreferrer');
    };

    // 初始化聊天容器
    const chatContainerManager = initChatContainer({
        chatContainer,
        messageInput,
        contextMenu,
        userQuestions,
        chatManager
    });

    // 设置按钮事件处理
    chatContainerManager.setupButtonHandlers({
        copyMessageButton,
        copyCodeButton,
        copyImageButton,
        stopUpdateButton,
        deleteMessageButton,
        regenerateMessageButton,
        abortController: abortControllerRef,
        regenerateMessage: regenerateMessage,
    });

    // 初始化消息输入组件
    initMessageInput({
        messageInput,
        sendMessage,
        userQuestions,
        contextMenu,
        hideContextMenu: hideContextMenu.bind(null, {
            contextMenu,
            onMessageElementReset: () => { /* 清空引用 */ },
            restoreFocus: false
        }),
        uiConfig,
        settingsMenu,
        webpageContentMenu // 传递二级菜单
    });

    // 初始化ChatManager
    await chatManager.initialize();

    // 将“默认/新对话”这类未改名且无消息的对话标题同步为当前语言
    try {
        const newTitle = t('chat_new_title');
        const defaultTitle = t('chat_default_title');
        const legacyNewTitles = new Set(['新对话', '新對話', 'New chat']);
        const legacyDefaultTitles = new Set(['默认对话', '預設對話', 'Default chat', 'Default Chat']);
        let changed = false;
        for (const chat of chatManager.getAllChats()) {
            if (!chat || !Array.isArray(chat.messages) || chat.messages.length !== 0) continue;
            if (legacyNewTitles.has(chat.title) && chat.title !== newTitle) {
                chat.title = newTitle;
                changed = true;
            }
            if (legacyDefaultTitles.has(chat.title) && chat.title !== defaultTitle) {
                chat.title = defaultTitle;
                changed = true;
            }
        }
        if (changed) {
            chatManager.saveChats();
        }
    } catch {
        // ignore
    }

    const readingProgressManager = createReadingProgressManager({
        chatContainer,
        getActiveChatId: () => chatManager.getCurrentChat()?.id,
        storage: storageAdapter
    });

    // 初始化用户问题历史
    chatContainerManager.initializeUserQuestions();

    // 初始化对话列表组件
    if (chatListPage) {
        initChatListEvents({
            chatListPage,
            chatCards: chatListPage.querySelector('.chat-cards'),
            chatManager,
            loadChatContent: (chat) => loadChatContent(chat, chatContainer),
            onHide: hideChatList.bind(null, chatListPage)
        });

        // 初始化聊天列表功能
        initializeChatList({
            chatListPage,
            chatManager,
            newChatButton,
            chatListButton,
            settingsMenu,
            apiSettings,
            loadChatContent: (chat) => loadChatContent(chat, chatContainer)
        });
    }

    // 加载当前对话内容
    const currentChat = chatManager.getCurrentChat();
    if (currentChat) {
        await loadChatContent(currentChat, chatContainer);
        await readingProgressManager.restore(currentChat.id);
    }
    readingProgressManager.start();

    const flushSessionState = () => {
        void readingProgressManager.saveNow().catch(() => {});
        void chatManager.flushNow().catch(() => {});
    };

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            flushSessionState();
        }
    });
    window.addEventListener('pagehide', flushSessionState);

    if ((!currentChat || currentChat.messages.length === 0) && isExtensionEnvironment) {
        const currentTab = await browserAdapter.getCurrentTab();
        if (currentTab?.id && currentChat?.id) {
            await setWebpageSwitchesForChat(currentChat.id, { [currentTab.id]: true });
        }
    }

    // 如果不是扩展环境，隐藏网页问答功能
    if (!isExtensionEnvironment && webpageQAContainer) {
        webpageQAContainer.style.display = 'none';
    }

    // 草稿：按对话保存输入框文字（不保存图片，避免存储膨胀）
    const DRAFT_KEY_PREFIX = 'cerebr_draft_v1_';
    const draftKeyForChatId = (chatId) => `${DRAFT_KEY_PREFIX}${chatId}`;
    let draftChatId = currentChat?.id || null;
    let draftSaveTimer = null;

    const saveDraftNow = async (chatId) => {
        if (!chatId) return;
        const { message, imageTags } = getFormattedMessageContent(messageInput);
        const draftText = (message || '').trimEnd();

        if (!draftText) {
            await storageAdapter.remove(draftKeyForChatId(chatId));
            return;
        }
        await storageAdapter.set({ [draftKeyForChatId(chatId)]: draftText });
    };

    const queueDraftSave = (chatId) => {
        clearTimeout(draftSaveTimer);
        draftSaveTimer = setTimeout(() => void saveDraftNow(chatId), 400);
    };

    const restoreDraft = async (chatId) => {
        if (!chatId) return;
        const key = draftKeyForChatId(chatId);
        const result = await storageAdapter.get(key);
        const draftText = result[key];
        const { message, imageTags } = getFormattedMessageContent(messageInput);
        const isInputEmpty = !message.trim() && imageTags.length === 0;
        if (!isInputEmpty) return;
        if (!draftText) return;

        messageInput.textContent = draftText;
        messageInput.dispatchEvent(new Event('input'));
    };

    messageInput.addEventListener('input', () => {
        queueDraftSave(draftChatId);
    });

    // 恢复当前对话草稿（如果有）
    void restoreDraft(draftChatId);

    // 监听对话切换，切换草稿与未读计数
    let pendingReadingProgressChatId = null;
    let readingProgressRestoring = false;
    let readingProgressRestoredForChatId = null;

    const tryRestoreReadingProgress = async (chatId) => {
        if (!chatId) return;
        if (chatId !== chatManager.getCurrentChat()?.id) return;
        if (readingProgressRestoredForChatId === chatId) return;
        if (readingProgressRestoring) return;

        readingProgressRestoring = true;
        try {
            const ok = await readingProgressManager.restore(chatId);
            if (ok) {
                readingProgressRestoredForChatId = chatId;
                if (pendingReadingProgressChatId === chatId) pendingReadingProgressChatId = null;
            }
        } finally {
            readingProgressRestoring = false;
        }
    };

    document.addEventListener('cerebr:chatSwitched', (event) => {
        const nextChatId = event?.detail?.chatId;
        void (async () => {
            if (draftChatId && draftChatId !== nextChatId) {
                await saveDraftNow(draftChatId);
            }
            draftChatId = nextChatId || null;
            clearMessageInput(messageInput, uiConfig);
            await restoreDraft(draftChatId);
            pendingReadingProgressChatId = draftChatId;
            readingProgressRestoredForChatId = null;
        })();
    });

    // 对话内容分批渲染时，尽早恢复阅读进度（等锚点消息出现后会自动成功）
    document.addEventListener('cerebr:chatContentChunk', (event) => {
        const chatId = event?.detail?.chatId;
        if (!chatId) return;
        if (pendingReadingProgressChatId !== chatId) return;
        void tryRestoreReadingProgress(chatId);
    });


    // 监听来自 content script 的消息
    window.addEventListener('message', (event) => {
        // 使用消息输入组件的窗口消息处理函数
        handleWindowMessage(event, {
            messageInput,
            newChatButton,
            uiConfig
        });
    });

    // 新增：带重试逻辑的API调用函数
    async function callAPIWithRetry(apiParams, chatManager, chatId, onMessageUpdate, maxRetries = 20) {
        let attempt = 0;
        let misfiledThinkSilentlyRetries = 0;
        const maxMisfiledThinkSilentlyRetries = maxRetries;
        while (attempt <= maxRetries) {
            const { processStream, controller } = await callAPI(apiParams, chatManager, chatId, onMessageUpdate, {
                detectMisfiledThinkSilently: misfiledThinkSilentlyRetries < maxMisfiledThinkSilentlyRetries,
                misfiledThinkSilentlyPrefixes: ['think', 'silently', '思考', 'thought']
            });
            currentController = controller;
            abortControllerRef.current = controller;

            if (abortControllerRef.pendingAbort) {
                abortControllerRef.pendingAbort = false;
                try {
                    controller.abort();
                } finally {
                    abortControllerRef.current = null;
                    currentController = null;
                }
                return;
            }

            let result;
            try {
                result = await processStream();
            } catch (error) {
                if (
                    error?.code === 'CEREBR_MISFILED_THINK_SILENTLY' &&
                    misfiledThinkSilentlyRetries < maxMisfiledThinkSilentlyRetries &&
                    attempt < maxRetries
                ) {
                    console.warn(`检测到 Gemini 将思维链错误写入 content，正在自动重试... (尝试次数 ${attempt + 1})`);
                    misfiledThinkSilentlyRetries++;
                    attempt++;

                    // 防御：如果已经创建了不完整的 assistant 消息，移除它（避免污染后续请求）
                    const currentChat = chatManager.getCurrentChat?.();
                    const lastMessage = currentChat?.messages?.[currentChat.messages.length - 1];
                    if (lastMessage?.role === 'assistant') {
                        chatManager.popMessage();
                    }
                    continue;
                }
                throw error;
            }

            if (!result) return result;

            const resolvedContent = String(result.content || '').trim();
            const resolvedReasoning = String(result.reasoning_content || '').trim();

            // 如果 content 为空但 reasoning_content 不为空，则可能被截断，进行重试
            if (!resolvedContent && resolvedReasoning && attempt < maxRetries) {
                console.log(`API响应可能被截断，正在重试... (尝试次数 ${attempt + 1})`);
                attempt++;
                // 在重试前，将不完整的 assistant 消息从历史记录中移除
                const currentChat = chatManager.getCurrentChat?.();
                const lastMessage = currentChat?.messages?.[currentChat.messages.length - 1];
                if (lastMessage?.role === 'assistant') {
                    chatManager.popMessage();
                }
                continue;
            }

            // 处理：模型返回空响应（例如只返回 stop/usage/[DONE]，但没有任何文本）
            if (!resolvedContent && !resolvedReasoning) {
                showToast(t('toast_empty_response'), { type: 'info', durationMs: 2200 });
                return result;
            } else {
                return result; // 成功或达到最大重试次数
            }
        }
    }

    async function regenerateMessage(messageElement) {
        if (!messageElement) return;

        // 如果有正在更新的AI消息，停止它
        const updatingMessage = chatContainer.querySelector('.ai-message.updating');
        if (updatingMessage && currentController) {
            currentController.abort();
            currentController = null;
            abortControllerRef.current = null;
            updatingMessage.classList.remove('updating');
        }

        let userMessageElement = null;
        let aiMessageElement = null;
        if (messageElement.classList.contains('user-message')) {
            userMessageElement = messageElement;
            aiMessageElement = messageElement.nextElementSibling;
        } else {
            userMessageElement = messageElement.previousElementSibling;
            aiMessageElement = messageElement;
        }

        if (!userMessageElement || !userMessageElement.classList.contains('user-message')) {
            console.error('无法找到对应的用户消息');
            return;
        }

        try {
            const currentChat = chatManager.getCurrentChat();
            if (!currentChat) return;

            const stickToBottomOnStart = shouldStickToBottom(chatContainer);
            setThinkingPlaceholder();

            // 清理可能残留的“首 token 前占位”消息，避免 DOM/历史对不齐导致误删用户消息
            chatContainer.querySelectorAll('.ai-message').forEach((el) => {
                const original = el.getAttribute('data-original-text') || '';
                if (!original.trim() && el.querySelector('.typing-indicator')) {
                    el.remove();
                }
            });

            const domMessages = Array.from(chatContainer.querySelectorAll('.user-message, .ai-message'));
            const userMessageDomIndex = domMessages.indexOf(userMessageElement);
            const aiMessageDomIndex = aiMessageElement ? domMessages.indexOf(aiMessageElement) : -1;

            const truncateFromIndex = aiMessageDomIndex !== -1
                ? aiMessageDomIndex
                : (userMessageDomIndex !== -1 ? userMessageDomIndex + 1 : currentChat.messages.length);

            // 如果历史记录少于 DOM（例如此前异常清空），尝试从 DOM 补齐到可重试的最小集合
            if (currentChat.messages.length < truncateFromIndex) {
                for (let i = currentChat.messages.length; i < truncateFromIndex && i < domMessages.length; i++) {
                    const el = domMessages[i];
                    const original = el.getAttribute('data-original-text');
                    const content = (original && original.trim()) ? original : (el.textContent || '');
                    const role = el.classList.contains('user-message') ? 'user' : 'assistant';
                    currentChat.messages.push({ role, content });
                }
            }

            // 从历史记录中移除要重新生成的 assistant（以及其后的所有消息）
            currentChat.messages.splice(truncateFromIndex);
            chatManager.saveChats();
            await chatManager.flushNow().catch(() => {});

            // 从 DOM 中移除将被重新生成的消息及其后的所有消息（保留用户提问）
            domMessages.slice(truncateFromIndex).forEach(el => el.remove());

            const messagesToResend = currentChat.messages;

            // 准备API调用参数
            const apiParams = {
                messages: messagesToResend,
                apiConfig: apiConfigs[selectedConfigIndex],
                userLanguage: navigator.language,
                webpageInfo: isExtensionEnvironment ? await getEnabledTabsContent() : null
            };

            // 首 token 前占位：减少“没反应”的体感
            void appendMessage({
                text: '',
                sender: 'ai',
                chatContainer,
            }).then((element) => {
                if (!stickToBottomOnStart) return;
                ensureChatElementVisible({ chatContainer, element, behavior: 'smooth' });
            });

            let didStartReplying = false;
            const onMessageUpdate = async (updatedChatId, message) => {
                if (!didStartReplying) {
                    didStartReplying = true;
                    setReplyingPlaceholder();
                }
                return chatContainerManager.syncMessage(updatedChatId, message);
            };

            // 调用带重试逻辑的 API
            await callAPIWithRetry(apiParams, chatManager, currentChat.id, onMessageUpdate);
            await chatManager.flushNow().catch(() => {});
            await readingProgressManager.saveNow().catch(() => {});

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('用户手动停止更新');
                return;
            }
            console.error('重新生成消息失败:', error);
            showToast(t('error_regenerate_failed', [error.message]), { type: 'error', durationMs: 2200 });
        } finally {
            // Best-effort: avoid losing the regenerated answer on refresh.
            void chatManager.flushNow().catch(() => {});
            void readingProgressManager.saveNow().catch(() => {});
            restoreDefaultPlaceholder();
            const lastMessage = chatContainer.querySelector('.ai-message:last-child');
            if (lastMessage) {
                lastMessage.classList.remove('updating');
                const original = lastMessage.getAttribute('data-original-text') || '';
                if (!original.trim()) {
                    lastMessage.remove();
                }
            }
        }
    }

    async function sendMessage() {
        // 如果有正在更新的AI消息，停止它
        const updatingMessage = chatContainer.querySelector('.ai-message.updating');
        if (updatingMessage && currentController) {
            currentController.abort();
            currentController = null;
            abortControllerRef.current = null; // 同步更新引用对象
            updatingMessage.classList.remove('updating');
        }

        // 获取格式化后的消息内容
        const { message, imageTags } = getFormattedMessageContent(messageInput);

        if (!message.trim() && imageTags.length === 0) return;

        try {
            const stickToBottomOnSend = shouldStickToBottom(chatContainer);
            // 构建消息内容
            const content = buildMessageContent(message, imageTags);

            // 构建用户消息
            const userMessage = {
                role: "user",
                content: content
            };

            // 先添加用户消息到界面和历史记录
            appendMessage({
                text: userMessage,
                sender: 'user',
                chatContainer,
            });

            // 清空输入框并调整高度
            clearMessageInput(messageInput, uiConfig);
            messageInput.focus();
            setThinkingPlaceholder();

            // 构建消息数组
            const currentChat = chatManager.getCurrentChat();
            if (currentChat?.id) {
                await storageAdapter.remove(draftKeyForChatId(currentChat.id));
            }
            const messages = currentChat ? [...currentChat.messages] : [];  // 从chatManager获取消息历史
            messages.push(userMessage);
            await chatManager.addMessageToCurrentChat(userMessage);
            await chatManager.flushNow().catch(() => {});

            // 准备API调用参数
            const apiParams = {
                messages,
                apiConfig: apiConfigs[selectedConfigIndex],
                userLanguage: navigator.language,
                webpageInfo: isExtensionEnvironment ? await getEnabledTabsContent() : null
            };

            // 首 token 前占位：减少“没反应”的体感
            void appendMessage({
                text: '',
                sender: 'ai',
                chatContainer,
            }).then((element) => {
                if (!stickToBottomOnSend) return;
                ensureChatElementVisible({ chatContainer, element, behavior: 'smooth' });
            });

            let didStartReplying = false;
            const onMessageUpdate = async (updatedChatId, message) => {
                if (!didStartReplying) {
                    didStartReplying = true;
                    setReplyingPlaceholder();
                }
                return chatContainerManager.syncMessage(updatedChatId, message);
            };

            // 调用带重试逻辑的 API
            await callAPIWithRetry(apiParams, chatManager, currentChat.id, onMessageUpdate);
            await chatManager.flushNow().catch(() => {});
            await readingProgressManager.saveNow().catch(() => {});

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('用户手动停止更新');
                return;
            }
            console.error('发送消息失败:', error);
            showToast(t('error_send_failed', [error.message]), { type: 'error', durationMs: 2200 });
        } finally {
            // Best-effort: avoid losing the last question/answer on refresh.
            void chatManager.flushNow().catch(() => {});
            void readingProgressManager.saveNow().catch(() => {});
            restoreDefaultPlaceholder();
            const lastMessage = chatContainer.querySelector('.ai-message:last-child');
            if (lastMessage) {
                lastMessage.classList.remove('updating');
                const original = lastMessage.getAttribute('data-original-text') || '';
                if (!original.trim()) {
                    lastMessage.remove();
                }
            }
        }
    }

    let settingsMenuOpenMode = null;

    const openSettingsMenu = (mode = 'click') => {
        if (!settingsMenu) return;
        settingsMenu.classList.add('visible');
        settingsMenuOpenMode = mode;
    };

    const closeSettingsMenu = () => {
        settingsMenu?.classList?.remove('visible');
        settingsMenuOpenMode = null;
        webpageContentMenu?.classList?.remove('visible');
    };

    const enableSettingsMenuDecelOpen = true;

    if (enableSettingsMenuDecelOpen && settingsButton && settingsMenu) {
        let hoverCloseTimer = 0;
        let hoverOpenTimer = 0;
        let webpageHoverOpenTimer = 0;

        const APPROACH_DISTANCE_PX = 28;
        const HOVER_OPEN_DELAY_MS = 140;
        const TRAIL_WINDOW_MS = 200;
        const AUTO_CLOSE_DELAY_MS = 280;
        const AUTO_OPEN_COOLDOWN_MS = 900;
        const MIN_PREV_SPEED = 0.35; // px/ms
        const MAX_SPEED = 0.22; // px/ms
        const SLOWDOWN_FACTOR = 0.55;

        let buttonRectCache = null;
        let buttonRectCacheAt = 0;
        let webpageItemRectCache = null;
        let webpageItemRectCacheAt = 0;

        let pointerTrail = [];
        let lastButtonDistance = null;
        let lastAutoOpenAt = 0;

        let webpagePointerTrail = [];
        let lastWebpageDistance = null;
        let lastWebpageAutoOpenAt = 0;

        let lastPointerX = 0;
        let lastPointerY = 0;

        const isPointInRect = (x, y, rect) =>
            x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

        const pointToRectDistance = (x, y, rect) => {
            const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
            const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
            return Math.hypot(dx, dy);
        };

        const getSettingsButtonRect = (now) => {
            if (!buttonRectCache || now - buttonRectCacheAt > 100) {
                buttonRectCache = settingsButton.getBoundingClientRect();
                buttonRectCacheAt = now;
            }
            return buttonRectCache;
        };

        const clearPointerTrail = () => {
            pointerTrail = [];
            lastButtonDistance = null;
        };

        const clearWebpagePointerTrail = () => {
            webpagePointerTrail = [];
            lastWebpageDistance = null;
        };

        const cancelHoverOpen = () => {
            if (!hoverOpenTimer) return;
            clearTimeout(hoverOpenTimer);
            hoverOpenTimer = 0;
        };

        const cancelWebpageHoverOpen = () => {
            if (!webpageHoverOpenTimer) return;
            clearTimeout(webpageHoverOpenTimer);
            webpageHoverOpenTimer = 0;
        };

        const cancelAutoClose = () => {
            if (!hoverCloseTimer) return;
            clearTimeout(hoverCloseTimer);
            hoverCloseTimer = 0;
        };

        settingsButton.addEventListener(
            'pointerenter',
            (event) => {
                if (event.pointerType && event.pointerType !== 'mouse') return;
                if (settingsMenu.classList.contains('visible')) return;

                cancelHoverOpen();
                hoverOpenTimer = window.setTimeout(() => {
                    hoverOpenTimer = 0;
                    if (settingsMenu.classList.contains('visible')) return;
                    if (!settingsButton.matches(':hover')) return;
                    openSettingsMenu('hover');
                    lastAutoOpenAt = performance.now();
                    clearPointerTrail();
                }, HOVER_OPEN_DELAY_MS);
            },
            { passive: true }
        );

        settingsButton.addEventListener(
            'pointerleave',
            (event) => {
                if (event.pointerType && event.pointerType !== 'mouse') return;
                cancelHoverOpen();
            },
            { passive: true }
        );

        const getWebpageItemRect = (now) => {
            if (!webpageQAContainer) return null;
            if (!webpageItemRectCache || now - webpageItemRectCacheAt > 100) {
                webpageItemRectCache = webpageQAContainer.getBoundingClientRect();
                webpageItemRectCacheAt = now;
            }
            return webpageItemRectCache;
        };

        const openWebpageContentMenu = () => {
            if (!isExtensionEnvironment || !webpageQAContainer || !webpageContentMenu) return;
            if (webpageContentMenu.classList.contains('visible')) return;
            webpageQAContainer.dispatchEvent(
                new MouseEvent('click', {
                    bubbles: true,
                    cancelable: true,
                    view: window
                })
            );
        };

        if (isExtensionEnvironment && webpageQAContainer && webpageContentMenu) {
            webpageQAContainer.addEventListener(
                'pointerenter',
                (event) => {
                    if (event.pointerType && event.pointerType !== 'mouse') return;
                    if (!settingsMenu.classList.contains('visible')) return;
                    if (webpageContentMenu.classList.contains('visible')) return;

                    cancelWebpageHoverOpen();
                    webpageHoverOpenTimer = window.setTimeout(() => {
                        webpageHoverOpenTimer = 0;
                        if (!settingsMenu.classList.contains('visible')) return;
                        if (webpageContentMenu.classList.contains('visible')) return;
                        if (!webpageQAContainer.matches(':hover')) return;

                        openWebpageContentMenu();
                        lastWebpageAutoOpenAt = performance.now();
                        clearWebpagePointerTrail();
                    }, HOVER_OPEN_DELAY_MS);
                },
                { passive: true }
            );

            webpageQAContainer.addEventListener(
                'pointerleave',
                (event) => {
                    if (event.pointerType && event.pointerType !== 'mouse') return;
                    cancelWebpageHoverOpen();
                },
                { passive: true }
            );
        }

        const isPointerInSettingsHoverRegion = (x, y) => {
            const now = performance.now();
            const buttonRect = getSettingsButtonRect(now);
            if (buttonRect && pointToRectDistance(x, y, buttonRect) <= APPROACH_DISTANCE_PX) return true;
            if (settingsMenu.classList.contains('visible') && isPointInRect(x, y, settingsMenu.getBoundingClientRect())) {
                return true;
            }
            if (
                webpageContentMenu?.classList?.contains('visible') &&
                isPointInRect(x, y, webpageContentMenu.getBoundingClientRect())
            ) {
                return true;
            }
            return false;
        };

        const scheduleAutoClose = () => {
            cancelAutoClose();
            if (settingsMenuOpenMode !== 'hover') return;
            hoverCloseTimer = window.setTimeout(() => {
                hoverCloseTimer = 0;
                if (settingsMenuOpenMode !== 'hover') return;
                if (!isPointerInSettingsHoverRegion(lastPointerX, lastPointerY)) {
                    closeSettingsMenu();
                }
            }, AUTO_CLOSE_DELAY_MS);
        };

        document.addEventListener(
            'pointermove',
            (event) => {
                if (event.pointerType && event.pointerType !== 'mouse') return;
                if (event.buttons) return;

                lastPointerX = event.clientX;
                lastPointerY = event.clientY;

                if (hoverOpenTimer && !settingsButton.matches(':hover')) {
                    cancelHoverOpen();
                }
                if (webpageHoverOpenTimer && webpageQAContainer && !webpageQAContainer.matches(':hover')) {
                    cancelWebpageHoverOpen();
                }

                if (settingsMenu.classList.contains('visible')) {
                    if (settingsMenuOpenMode === 'hover') {
                        if (isPointerInSettingsHoverRegion(event.clientX, event.clientY)) {
                            cancelAutoClose();
                        } else {
                            scheduleAutoClose();
                        }
                    }

                    if (
                        isExtensionEnvironment &&
                        webpageQAContainer &&
                        webpageContentMenu &&
                        !webpageContentMenu.classList.contains('visible')
                    ) {
                        const now = performance.now();
                        if (now - lastWebpageAutoOpenAt < AUTO_OPEN_COOLDOWN_MS) return;

                        const itemRect = getWebpageItemRect(now);
                        if (!itemRect) return;
                        const itemDistance = pointToRectDistance(event.clientX, event.clientY, itemRect);

                        if (itemDistance > APPROACH_DISTANCE_PX) {
                            clearWebpagePointerTrail();
                            return;
                        }

                        webpagePointerTrail.push({ x: event.clientX, y: event.clientY, t: now });
                        while (webpagePointerTrail.length > 6) webpagePointerTrail.shift();
                        while (webpagePointerTrail.length > 2 && now - webpagePointerTrail[0].t > TRAIL_WINDOW_MS) {
                            webpagePointerTrail.shift();
                        }

                        const approaching = lastWebpageDistance == null || itemDistance < lastWebpageDistance - 0.25;
                        lastWebpageDistance = itemDistance;
                        if (!approaching) return;
                        if (webpagePointerTrail.length < 3) return;

                        const p2 = webpagePointerTrail[webpagePointerTrail.length - 1];
                        const p1 = webpagePointerTrail[webpagePointerTrail.length - 2];
                        const p0 = webpagePointerTrail[webpagePointerTrail.length - 3];
                        const dtNow = p2.t - p1.t;
                        const dtPrev = p1.t - p0.t;
                        if (dtNow < 8 || dtPrev < 8) return;

                        const speedNow = Math.hypot(p2.x - p1.x, p2.y - p1.y) / dtNow;
                        const speedPrev = Math.hypot(p1.x - p0.x, p1.y - p0.y) / dtPrev;

                        if (speedPrev < MIN_PREV_SPEED) return;
                        if (speedNow > MAX_SPEED) return;
                        if (speedNow > speedPrev * SLOWDOWN_FACTOR) return;

                        openWebpageContentMenu();
                        lastWebpageAutoOpenAt = now;
                        clearWebpagePointerTrail();
                    }
                    return;
                }

                const now = performance.now();
                if (now - lastAutoOpenAt < AUTO_OPEN_COOLDOWN_MS) return;

                const buttonRect = getSettingsButtonRect(now);
                const buttonDistance = pointToRectDistance(event.clientX, event.clientY, buttonRect);

                if (buttonDistance > APPROACH_DISTANCE_PX) {
                    clearPointerTrail();
                    return;
                }

                pointerTrail.push({ x: event.clientX, y: event.clientY, t: now });
                while (pointerTrail.length > 6) pointerTrail.shift();
                while (pointerTrail.length > 2 && now - pointerTrail[0].t > TRAIL_WINDOW_MS) {
                    pointerTrail.shift();
                }

                const approaching = lastButtonDistance == null || buttonDistance < lastButtonDistance - 0.25;
                lastButtonDistance = buttonDistance;
                if (!approaching) return;
                if (pointerTrail.length < 3) return;

                const p2 = pointerTrail[pointerTrail.length - 1];
                const p1 = pointerTrail[pointerTrail.length - 2];
                const p0 = pointerTrail[pointerTrail.length - 3];
                const dtNow = p2.t - p1.t;
                const dtPrev = p1.t - p0.t;
                if (dtNow < 8 || dtPrev < 8) return;

                const speedNow = Math.hypot(p2.x - p1.x, p2.y - p1.y) / dtNow;
                const speedPrev = Math.hypot(p1.x - p0.x, p1.y - p0.y) / dtPrev;

                if (speedPrev < MIN_PREV_SPEED) return;
                if (speedNow > MAX_SPEED) return;
                if (speedNow > speedPrev * SLOWDOWN_FACTOR) return;

                openSettingsMenu('hover');
                lastAutoOpenAt = now;
                clearPointerTrail();
            },
            { passive: true }
        );
    }

    // 修改点击事件监听器
    document.addEventListener('click', (e) => {
        const isInSettingsArea = !!e.target.closest?.('#settings-button, #settings-menu');
        const isInWebpageMenuArea = !!e.target.closest?.('#webpage-qa, #webpage-content-menu');

        // 点击网页内容二级菜单内部时，不要误关一级菜单
        if (!isInSettingsArea && !isInWebpageMenuArea) {
            closeSettingsMenu();
        }

        if (!isInWebpageMenuArea) {
            webpageContentMenu?.classList?.remove('visible');
        }
    });

    // 初始化网页内容二级菜单
    if (isExtensionEnvironment && webpageQAContainer && webpageContentMenu) {
        initWebpageMenu({ webpageQAContainer, webpageContentMenu });
    }

    // 确保设置按钮的点击事件在文档点击事件之前处理
    settingsButton?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!settingsMenu) return;

        if (!settingsMenu.classList.contains('visible')) {
            openSettingsMenu('click');
            webpageContentMenu?.classList?.remove('visible');
            return;
        }

        if (settingsMenuOpenMode === 'hover') {
            settingsMenuOpenMode = 'click';
            return;
        }

        closeSettingsMenu();
    });

    // 主题切换
    const themeToggle = document.getElementById('theme-toggle');
    const themeSwitch = document.getElementById('theme-switch');

    // 创建主题配置对象
    const themeConfig = {
        root: document.documentElement,
        themeSwitch,
        saveTheme: async (theme) => await syncStorageAdapter.set({ theme })
    };

    // 初始化主题
    async function initTheme() {
        try {
            const result = await syncStorageAdapter.get('theme');
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            const isDark = result.theme === 'dark' || (!result.theme && prefersDark);
            setTheme(isDark, themeConfig);
        } catch (error) {
            console.error('初始化主题失败:', error);
            // 如果出错，使用系统主题
            setTheme(window.matchMedia('(prefers-color-scheme: dark)').matches, themeConfig);
        }
    }

    // 监听主题切换
        if (themeSwitch) {
            themeSwitch.addEventListener('change', () => {
                setTheme(themeSwitch.checked, themeConfig);
            });
        }

    if (themeToggle && themeSwitch) {
        themeToggle.addEventListener('click', (e) => {
            // 点击开关本身时，让浏览器默认行为处理（避免 toggle 两次导致“没反应”）
            if (e.target.closest('.switch')) return;
            themeSwitch.click();
        });
    }

    // 监听系统主题变化
        const prefersDarkQuery = window.matchMedia('(prefers-color-scheme: dark)');
        const handleSystemThemeChange = async (e) => {
            const data = await syncStorageAdapter.get('theme');
            if (!data.theme) {  // 只有在用户没有手动设置主题时才跟随系统
                setTheme(e.matches, themeConfig);
            }
        };
        if (typeof prefersDarkQuery.addEventListener === 'function') {
            prefersDarkQuery.addEventListener('change', handleSystemThemeChange);
        } else if (typeof prefersDarkQuery.addListener === 'function') {
            prefersDarkQuery.addListener(handleSystemThemeChange);
        }

    // 初始化主题
    await initTheme();

    // 字体大小设置（通过 CSS 变量控制）
    const FONT_SCALE_KEY = 'fontScale';
    const FONT_SCALE_PRESETS = [0.9, 1, 1.1, 1.2];
    const SITE_OVERRIDES_KEY = 'panelSiteOverridesV1';
    const SITE_KEY_PLUS = 2;

    const isIPv4 = (hostname) => {
        if (typeof hostname !== 'string') return false;
        const parts = hostname.split('.');
        if (parts.length !== 4) return false;
        return parts.every((p) => {
            if (!/^(?:0|[1-9]\d{0,2})$/.test(p)) return false;
            const n = Number(p);
            return n >= 0 && n <= 255;
        });
    };

    const isIPv6 = (hostname) => {
        if (typeof hostname !== 'string') return false;
        return hostname.includes(':');
    };

    const MULTI_PART_PUBLIC_SUFFIXES = new Set([
        'co.uk',
        'org.uk',
        'ac.uk',
        'gov.uk',
        'net.uk',
        'com.au',
        'net.au',
        'org.au',
        'edu.au',
        'gov.au',
        'co.jp',
        'ne.jp',
        'or.jp',
        'ac.jp',
        'go.jp',
        'com.cn',
        'net.cn',
        'org.cn',
        'gov.cn',
        'com.hk',
        'com.tw',
        'com.sg'
    ]);

    const getSiteKeyFromHostname = (hostname, plus = SITE_KEY_PLUS) => {
        if (!hostname || typeof hostname !== 'string') return null;
        const normalized = hostname.trim().replace(/\.$/, '').toLowerCase();
        if (!normalized) return null;
        if (normalized === 'localhost' || normalized.endsWith('.localhost')) return normalized;
        if (isIPv4(normalized) || isIPv6(normalized)) return normalized;

        const parts = normalized.split('.').filter(Boolean);
        if (parts.length <= 2) return normalized;

        let suffixLen = 1;
        const last2 = parts.slice(-2).join('.');
        const last3 = parts.slice(-3).join('.');
        if (MULTI_PART_PUBLIC_SUFFIXES.has(last2)) suffixLen = 2;
        else if (MULTI_PART_PUBLIC_SUFFIXES.has(last3)) suffixLen = 3;

        const plusNumber = Math.max(1, Number(plus) || SITE_KEY_PLUS);
        const requiredLen = suffixLen + plusNumber;
        if (parts.length <= requiredLen) return normalized;
        return parts.slice(-requiredLen).join('.');
    };

    const pruneSiteOverridesInPlace = (overrides) => {
        const entries = Object.entries(overrides || {});
        const MAX_ENTRIES = 100;
        if (entries.length <= MAX_ENTRIES) return;
        entries
            .sort((a, b) => (Number(b[1]?.updatedAt) || 0) - (Number(a[1]?.updatedAt) || 0))
            .slice(MAX_ENTRIES)
            .forEach(([key]) => {
                delete overrides[key];
            });
    };

    const readSiteOverrides = async () => {
        try {
            const res = await syncStorageAdapter.get(SITE_OVERRIDES_KEY);
            const raw = res?.[SITE_OVERRIDES_KEY];
            return raw && typeof raw === 'object' ? raw : {};
        } catch {
            return {};
        }
    };

    const writeSiteOverrides = async (overrides) => {
        pruneSiteOverridesInPlace(overrides);
        await syncStorageAdapter.set({ [SITE_OVERRIDES_KEY]: overrides });
    };

    let currentSiteKey = null;
    let legacySiteKey = null;
    try {
        const tab = await browserAdapter.getCurrentTab();
        currentSiteKey = getSiteKeyFromHostname(tab?.hostname, SITE_KEY_PLUS);
        legacySiteKey = getSiteKeyFromHostname(tab?.hostname, 1);
    } catch {
        currentSiteKey = null;
        legacySiteKey = null;
    }

    const toPreset = (value) => {
        if (typeof value === 'number' && Number.isFinite(value) && FONT_SCALE_PRESETS.includes(value)) return value;
        if (typeof value === 'string') {
            const parsed = Number.parseFloat(value);
            if (Number.isFinite(parsed) && FONT_SCALE_PRESETS.includes(parsed)) return parsed;
        }
        return 1;
    };

    const applyFontScale = (scale) => {
        const root = document.documentElement;
        const scaledPx = (px) => `${Math.round(px * scale * 10) / 10}px`;
        root.style.setProperty('--cerebr-fs-12', scaledPx(12));
        root.style.setProperty('--cerebr-fs-13', scaledPx(13));
        root.style.setProperty('--cerebr-fs-14', scaledPx(14));
        root.style.setProperty('--cerebr-fs-16', scaledPx(16));
    };

    try {
        const result = await syncStorageAdapter.get([FONT_SCALE_KEY, SITE_OVERRIDES_KEY]);
        const overrides = result?.[SITE_OVERRIDES_KEY] && typeof result[SITE_OVERRIDES_KEY] === 'object'
            ? result[SITE_OVERRIDES_KEY]
            : {};
        const globalScale = toPreset(result?.[FONT_SCALE_KEY]);
        const siteScale = currentSiteKey ? Number(overrides?.[currentSiteKey]?.fontScale) : NaN;

        // 迁移：eTLD+1 -> eTLD+2（访问新站点粒度时，继承旧粒度的值）
        if (!Number.isFinite(siteScale) && currentSiteKey && legacySiteKey && legacySiteKey !== currentSiteKey) {
            const legacyScale = Number(overrides?.[legacySiteKey]?.fontScale);
            if (Number.isFinite(legacyScale)) {
                const migrated = toPreset(legacyScale);
                overrides[currentSiteKey] = {
                    ...(overrides?.[currentSiteKey] && typeof overrides[currentSiteKey] === 'object' ? overrides[currentSiteKey] : {}),
                    fontScale: migrated,
                    updatedAt: Date.now()
                };
                await writeSiteOverrides(overrides);
                applyFontScale(migrated);
                if (preferencesFontScale) preferencesFontScale.value = String(migrated);
                return;
            }
        }

        const initialScale = Number.isFinite(siteScale) ? toPreset(siteScale) : globalScale;
        applyFontScale(initialScale);
        if (preferencesFontScale) {
            preferencesFontScale.value = String(initialScale);
        }
    } catch (error) {
        console.error('初始化字体大小失败:', error);
        applyFontScale(1);
    }

    // API 设置功能
    const apiSettingsToggle = document.getElementById('api-settings-toggle');
    const backButton = apiSettings?.querySelector('.back-button') || null;
    const apiCards = apiSettings?.querySelector('.api-cards') || null;

    // 偏好设置页面
    const preferencesBackButton = preferencesSettings?.querySelector('.back-button');

    const getAppVersion = async () => {
        try {
            if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) return chrome.runtime.getManifest().version;
            if (typeof browser !== 'undefined' && browser.runtime?.getManifest) return browser.runtime.getManifest().version;
        } catch (error) {
            console.warn('读取版本号失败:', error);
        }

        const metaVersion = document.querySelector('meta[name="cerebr-version"]')?.getAttribute('content');
        if (metaVersion) return metaVersion;

        const fetchManifestVersion = async (path) => {
            try {
                const response = await fetch(new URL(path, window.location.href), { cache: 'no-store' });
                if (!response.ok) return null;
                const manifest = await response.json();
                return manifest?.version ? String(manifest.version) : null;
            } catch (error) {
                console.warn(`读取 ${path} 版本号失败:`, error);
                return null;
            }
        };

        return await fetchManifestVersion('./manifest.json')
            || await fetchManifestVersion('/manifest.json')
            || await fetchManifestVersion('./manifest.firefox.json')
            || await fetchManifestVersion('/manifest.firefox.json')
            || '-';
    };

    if (preferencesVersion) {
        preferencesVersion.textContent = await getAppVersion();
    }

    if (preferencesLanguage) {
        try {
            preferencesLanguage.value = await getLanguagePreference();
        } catch {
            preferencesLanguage.value = 'auto';
        }
        preferencesLanguage.addEventListener('change', async () => {
            try {
                await setLanguagePreference(preferencesLanguage.value);
                await reloadI18n();
                applyI18n(document);

                // 同步更新空对话的默认标题
                try {
                    const newTitle = t('chat_new_title');
                    const defaultTitle = t('chat_default_title');
                    const legacyNewTitles = new Set(['新对话', '新對話', 'New chat']);
                    const legacyDefaultTitles = new Set(['默认对话', '預設對話', 'Default chat', 'Default Chat']);
                    let changed = false;
                    for (const chat of chatManager.getAllChats?.() || []) {
                        if (!chat || !Array.isArray(chat.messages) || chat.messages.length !== 0) continue;
                        if (legacyNewTitles.has(chat.title) && chat.title !== newTitle) {
                            chat.title = newTitle;
                            changed = true;
                        }
                        if (legacyDefaultTitles.has(chat.title) && chat.title !== defaultTitle) {
                            chat.title = defaultTitle;
                            changed = true;
                        }
                    }
                    if (changed) chatManager.saveChats?.();
                } catch {
                    // ignore
                }
            } catch (error) {
                console.error('保存语言设置失败:', error);
            }
        });
    }

    if (preferencesToggle && preferencesSettings) {
        preferencesToggle.addEventListener('click', () => {
            preferencesSettings.classList.add('visible');
            closeSettingsMenu();
        });
    }

    if (preferencesBackButton && preferencesSettings) {
        preferencesBackButton.addEventListener('click', () => {
            preferencesSettings.classList.remove('visible');
        });
    }

    if (preferencesFeedback) {
        preferencesFeedback.addEventListener('click', () => {
            openExternal(FEEDBACK_URL);
            preferencesSettings?.classList.remove('visible');
        });
    }

    if (preferencesFontScale) {
        preferencesFontScale.addEventListener('change', async () => {
            const selected = toPreset(preferencesFontScale.value);
            applyFontScale(selected);
            try {
                if (!currentSiteKey) {
                    await syncStorageAdapter.set({ [FONT_SCALE_KEY]: selected });
                    return;
                }
                const overrides = await readSiteOverrides();
                const existing = overrides?.[currentSiteKey] && typeof overrides[currentSiteKey] === 'object'
                    ? overrides[currentSiteKey]
                    : {};
                overrides[currentSiteKey] = {
                    ...existing,
                    fontScale: selected,
                    updatedAt: Date.now()
                };
                await writeSiteOverrides(overrides);
            } catch (error) {
                console.error('保存字体大小失败:', error);
            }
        });
    }

    const SYSTEM_PROMPT_SYNC_THRESHOLD_BYTES = 6000;
    const SYSTEM_PROMPT_KEY_PREFIX = 'apiConfigSystemPrompt_';
    const SYSTEM_PROMPT_LOCAL_ONLY_KEY_PREFIX = 'apiConfigSystemPromptLocalOnly_';
    const SYSTEM_PROMPT_LOCAL_DEBOUNCE_MS = 200;
    const SYSTEM_PROMPT_SYNC_DEBOUNCE_MS = 2000;
    const API_CONFIGS_SYNC_DEBOUNCE_MS = 800;

    const getSystemPromptKey = (configId) => `${SYSTEM_PROMPT_KEY_PREFIX}${configId}`;
    const getSystemPromptLocalOnlyKey = (configId) => `${SYSTEM_PROMPT_LOCAL_ONLY_KEY_PREFIX}${configId}`;

    const generateConfigId = () => {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        return `cfg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    };

    const ensureConfigId = (config) => {
        if (!config.id) {
            config.id = generateConfigId();
        }
        return config.id;
    };

    const getUtf8ByteLength = (value) => {
        try {
            return new TextEncoder().encode(value ?? '').length;
        } catch {
            return (value ?? '').length;
        }
    };

    const normalizeApiConfig = (config) => {
        const normalized = { ...(config || {}) };
        ensureConfigId(normalized);
        normalized.apiKey = normalized.apiKey ?? '';
        normalized.baseUrl = normalizeChatCompletionsUrl(
            normalized.baseUrl ?? 'https://api.0-0.pro/v1/chat/completions'
        ) || 'https://api.0-0.pro/v1/chat/completions';
        normalized.modelName = normalized.modelName ?? 'gpt-4o';
        normalized.advancedSettings = {
            ...(normalized.advancedSettings || {}),
            systemPrompt: normalized.advancedSettings?.systemPrompt ?? '',
            isExpanded: normalized.advancedSettings?.isExpanded ?? false,
        };
        return normalized;
    };

    const stripApiConfigForSync = (config) => {
        const advancedSettings = { ...(config.advancedSettings || {}) };
        delete advancedSettings.systemPrompt;
        return {
            ...config,
            advancedSettings,
        };
    };

    const systemPromptPersistStateByConfigId = new Map();

    const persistSystemPromptLocalNow = async ({ configId, systemPrompt }) => {
        const promptKey = getSystemPromptKey(configId);
        await storageAdapter.set({ [promptKey]: systemPrompt });
    };

    const persistSystemPromptSyncNow = async ({ configId, systemPrompt }) => {
        const promptKey = getSystemPromptKey(configId);
        const localOnlyKey = getSystemPromptLocalOnlyKey(configId);
        const byteLength = getUtf8ByteLength(systemPrompt);

        if (byteLength <= SYSTEM_PROMPT_SYNC_THRESHOLD_BYTES) {
            try {
                await syncStorageAdapter.set({ [promptKey]: systemPrompt, [localOnlyKey]: false });
            } catch (error) {
                const message = String(error?.message || error);
                if (message.includes('kQuotaBytesPerItem') || message.includes('QuotaExceeded')) {
                    await syncStorageAdapter.set({ [promptKey]: '', [localOnlyKey]: true });
                } else {
                    throw error;
                }
            }
        } else {
            await syncStorageAdapter.set({ [promptKey]: '', [localOnlyKey]: true });
        }
    };

    const queueSystemPromptPersist = (config) => {
        const configId = ensureConfigId(config);
        const systemPrompt = config.advancedSettings?.systemPrompt ?? '';

        const byteLength = getUtf8ByteLength(systemPrompt);
        if (config.advancedSettings) {
            config.advancedSettings.systemPromptLocalOnly = byteLength > SYSTEM_PROMPT_SYNC_THRESHOLD_BYTES;
        }

        const prev = systemPromptPersistStateByConfigId.get(configId) || {};
        if (prev.localTimer) clearTimeout(prev.localTimer);
        if (prev.syncTimer) clearTimeout(prev.syncTimer);

        const state = {
            latestSystemPrompt: systemPrompt,
            localTimer: setTimeout(() => {
                persistSystemPromptLocalNow({ configId, systemPrompt }).catch(() => {});
            }, SYSTEM_PROMPT_LOCAL_DEBOUNCE_MS),
            syncTimer: setTimeout(() => {
                persistSystemPromptSyncNow({ configId, systemPrompt }).catch(() => {});
            }, SYSTEM_PROMPT_SYNC_DEBOUNCE_MS),
        };

        systemPromptPersistStateByConfigId.set(configId, state);
    };

    const flushSystemPromptPersist = async (config) => {
        const configId = ensureConfigId(config);
        const state = systemPromptPersistStateByConfigId.get(configId);
        const systemPrompt = config.advancedSettings?.systemPrompt ?? state?.latestSystemPrompt ?? '';

        if (state?.localTimer) clearTimeout(state.localTimer);
        if (state?.syncTimer) clearTimeout(state.syncTimer);
        systemPromptPersistStateByConfigId.delete(configId);

        await persistSystemPromptLocalNow({ configId, systemPrompt });
        await persistSystemPromptSyncNow({ configId, systemPrompt });
    };

    let apiConfigsPersistTimer = null;

    const queueApiConfigsPersist = () => {
        if (apiConfigsPersistTimer) clearTimeout(apiConfigsPersistTimer);
        apiConfigsPersistTimer = setTimeout(() => {
            apiConfigsPersistTimer = null;
            saveAPIConfigs().catch(() => {});
        }, API_CONFIGS_SYNC_DEBOUNCE_MS);
    };

    const flushApiConfigsPersist = async () => {
        if (apiConfigsPersistTimer) {
            clearTimeout(apiConfigsPersistTimer);
            apiConfigsPersistTimer = null;
        }
        await saveAPIConfigs();
    };

    // 使用新的selectCard函数
    const handleCardSelect = (template, index) => {
        selectCard({
            template,
            index,
            onIndexChange: (newIndex) => {
                selectedConfigIndex = newIndex;
            },
            onSave: saveAPIConfigs,
            cardSelector: '.api-card',
            onSelect: () => {
                // 关闭API设置面板
                apiSettings?.classList?.remove('visible');
            }
        });
    };

    // 创建渲染API卡片的辅助函数
    const renderAPICardsWithCallbacks = () => {
        renderAPICards({
            apiConfigs,
            apiCardsContainer: apiCards,
            templateCard: document.querySelector('.api-card.template'),
            ...createCardCallbacks({
                selectCard: handleCardSelect,
                apiConfigs,
                selectedConfigIndex,
                saveAPIConfigs,
                queueApiConfigsPersist,
                flushApiConfigsPersist,
                queueSystemPromptPersist,
                flushSystemPromptPersist,
                renderAPICardsWithCallbacks,
                onBeforeCardDelete: (configToDelete) => {
                    const configId = configToDelete?.id;
                    if (!configId) return;
                    const promptKey = getSystemPromptKey(configId);
                    const localOnlyKey = getSystemPromptLocalOnlyKey(configId);

                    const state = systemPromptPersistStateByConfigId.get(configId);
                    if (state?.localTimer) clearTimeout(state.localTimer);
                    if (state?.syncTimer) clearTimeout(state.syncTimer);
                    systemPromptPersistStateByConfigId.delete(configId);

                    storageAdapter.remove(promptKey).catch(() => {});
                    syncStorageAdapter.remove([promptKey, localOnlyKey]).catch(() => {});
                }
            }),
            selectedIndex: selectedConfigIndex
        });
    };

    // 从存储加载配置
    async function loadAPIConfigs() {
        try {
            // 统一使用 syncStorageAdapter 来实现配置同步
            const result = await syncStorageAdapter.get(['apiConfigs', 'selectedConfigIndex']);

            // 分别检查每个配置项
            if (result.apiConfigs) {
                const nextConfigs = result.apiConfigs.map(normalizeApiConfig);
                apiConfigs.splice(0, apiConfigs.length, ...nextConfigs);
            } else {
                apiConfigs.splice(0, apiConfigs.length, {
                    id: generateConfigId(),
                    apiKey: '',
                    baseUrl: 'https://api.0-0.pro/v1/chat/completions',
                    modelName: 'gpt-4o',
                    advancedSettings: {
                        systemPrompt: '',
                        isExpanded: false,
                    },
                });
                // 只有在没有任何配置的情况下才保存默认配置
                await saveAPIConfigs();
            }

            // 只有当 selectedConfigIndex 为 undefined 或 null 时才使用默认值 0
            selectedConfigIndex = result.selectedConfigIndex ?? 0;
            if (!Number.isInteger(selectedConfigIndex)) {
                selectedConfigIndex = 0;
            }
            selectedConfigIndex = Math.max(0, Math.min(selectedConfigIndex, apiConfigs.length - 1));

            // 加载系统提示（优先本地，其次同步）
            const promptKeys = apiConfigs.map((c) => getSystemPromptKey(c.id));
            const promptLocalOnlyKeys = apiConfigs.map((c) => getSystemPromptLocalOnlyKey(c.id));
            const promptSyncResult = await syncStorageAdapter.get([...promptKeys, ...promptLocalOnlyKeys]);

            const localPromptResults = await Promise.all(
                apiConfigs.map((c) =>
                    storageAdapter.get(getSystemPromptKey(c.id)).catch(() => ({}))
                )
            );

            let needsMigrationSave = false;
            const localPromptPayloadToCache = {};

            const nextConfigs = apiConfigs.map((config, idx) => {
                const promptKey = getSystemPromptKey(config.id);
                const localOnlyKey = getSystemPromptLocalOnlyKey(config.id);
                const localPrompt = localPromptResults[idx]?.[promptKey];
                const syncPrompt = promptSyncResult?.[promptKey];
                const localOnly = !!promptSyncResult?.[localOnlyKey];
                const legacyPrompt = config.advancedSettings?.systemPrompt;

                let systemPrompt = '';
                if (typeof localPrompt === 'string') {
                    systemPrompt = localPrompt;
                } else if (!localOnly && typeof syncPrompt === 'string' && syncPrompt.length > 0) {
                    systemPrompt = syncPrompt;
                    localPromptPayloadToCache[promptKey] = syncPrompt;
                } else if (typeof legacyPrompt === 'string' && legacyPrompt.length > 0) {
                    systemPrompt = legacyPrompt;
                    localPromptPayloadToCache[promptKey] = legacyPrompt;
                    needsMigrationSave = true;
                }

                return {
                    ...config,
                    advancedSettings: {
                        ...(config.advancedSettings || {}),
                        systemPrompt,
                        systemPromptLocalOnly: localOnly,
                    },
                };
            });
            apiConfigs.splice(0, apiConfigs.length, ...nextConfigs);

            if (Object.keys(localPromptPayloadToCache).length > 0) {
                await storageAdapter.set(localPromptPayloadToCache);
            }

            // 若发现旧版本把 systemPrompt 存在了 apiConfigs 中，迁移一次以避免再次触发 sync 单条目限制
            if (needsMigrationSave) {
                await saveAPIConfigs();
            }

            // 确保一定会渲染卡片
            renderAPICardsWithCallbacks();
        } catch (error) {
            console.error('加载 API 配置失败:', error);
            // 只有在出错的情况下才使用默认值
            apiConfigs.splice(0, apiConfigs.length, {
                id: generateConfigId(),
                apiKey: '',
                baseUrl: 'https://api.0-0.pro/v1/chat/completions',
                modelName: 'gpt-4o',
                advancedSettings: {
                    systemPrompt: '',
                    isExpanded: false,
                },
            });
            selectedConfigIndex = 0;
            renderAPICardsWithCallbacks();
        }
    }

    // 监听标签页切换
    browserAdapter.onTabActivated(async (activeInfo) => {
        // background 会广播给所有 sidebar 实例：只在当前可见的实例里处理，避免跨 tab 状态串扰
        if (document.hidden) return;
        try {
            if (activeInfo?.tabId || activeInfo?.windowId) {
                const currentTab = await browserAdapter.getCurrentTab();
                if (!currentTab?.id) return;
                if (typeof activeInfo?.tabId === 'number' && currentTab.id !== activeInfo.tabId) return;
                if (typeof activeInfo?.windowId === 'number' && currentTab.windowId && currentTab.windowId !== activeInfo.windowId) return;
            }
        } catch {
            // ignore
        }
        // 同步API配置
        await loadAPIConfigs();
        renderAPICardsWithCallbacks();

        // 同步对话数据（对话列表在打开时再渲染，避免后台渲染造成额外布局开销）
        await chatManager.initialize();

        // 如果当前对话为空，则重置网页内容开关
        const currentChat = chatManager.getCurrentChat();
        if (currentChat && currentChat.messages.length === 0) {
            const currentTab = await browserAdapter.getCurrentTab();
            if (currentTab?.id) {
                await setWebpageSwitchesForChat(currentChat.id, { [currentTab.id]: true });
            }
        }
    });

    // 串行化保存，避免并发写入导致“旧值覆盖新值”
    let apiConfigsSaveChain = Promise.resolve();

    function saveAPIConfigs() {
        apiConfigsSaveChain = Promise.resolve(apiConfigsSaveChain)
            .catch(() => {})
            .then(() => saveAPIConfigsNow());
        return apiConfigsSaveChain;
    }

    // 保存配置到存储
    async function saveAPIConfigsNow() {
        try {
            const nextConfigs = apiConfigs.map(normalizeApiConfig);
            apiConfigs.splice(0, apiConfigs.length, ...nextConfigs);
            if (!Number.isInteger(selectedConfigIndex)) {
                selectedConfigIndex = 0;
            }
            selectedConfigIndex = Math.max(0, Math.min(selectedConfigIndex, apiConfigs.length - 1));

            const localPayload = {};
            const syncPayload = {
                apiConfigs: apiConfigs.map(stripApiConfigForSync),
                selectedConfigIndex,
            };

            for (const config of apiConfigs) {
                const id = ensureConfigId(config);
                const promptKey = getSystemPromptKey(id);
                const localOnlyKey = getSystemPromptLocalOnlyKey(id);

                const systemPrompt = config.advancedSettings?.systemPrompt ?? '';
                localPayload[promptKey] = systemPrompt;

                const byteLength = getUtf8ByteLength(systemPrompt);
                if (byteLength <= SYSTEM_PROMPT_SYNC_THRESHOLD_BYTES) {
                    syncPayload[promptKey] = systemPrompt;
                    syncPayload[localOnlyKey] = false;
                    if (config.advancedSettings) config.advancedSettings.systemPromptLocalOnly = false;
                } else {
                    syncPayload[promptKey] = '';
                    syncPayload[localOnlyKey] = true;
                    if (config.advancedSettings) config.advancedSettings.systemPromptLocalOnly = true;
                }
            }

            // 先确保本地已持久化（即便同步失败也不丢数据）
            await storageAdapter.set(localPayload);

            // 统一使用 syncStorageAdapter 来实现配置同步
            await syncStorageAdapter.set(syncPayload);
        } catch (error) {
            console.error('保存 API 配置失败:', error);

            // 如果因为 quota 限制失败，降级为“仅同步配置骨架”
            const message = String(error?.message || error);
            if (message.includes('kQuotaBytesPerItem') || message.includes('QuotaExceeded')) {
                try {
                    const degradedSyncPayload = {
                        apiConfigs: apiConfigs.map(stripApiConfigForSync),
                        selectedConfigIndex,
                    };
                    for (const config of apiConfigs) {
                        const id = ensureConfigId(config);
                        degradedSyncPayload[getSystemPromptKey(id)] = '';
                        degradedSyncPayload[getSystemPromptLocalOnlyKey(id)] = true;
                    }
                    await syncStorageAdapter.set(degradedSyncPayload);
                } catch (degradedError) {
                    console.error('保存 API 配置失败（降级仍失败）:', degradedError);
                }
            }
        }
    }

    // 等待 DOM 加载完成后再初始化
    await loadAPIConfigs();

    // 显示/隐藏 API 设置
    apiSettingsToggle?.addEventListener('click', () => {
        apiSettings?.classList?.add('visible');
        closeSettingsMenu();
        // 确保每次打开设置时都重新渲染卡片
        renderAPICardsWithCallbacks();
    });

    // 返回聊天界面
        backButton?.addEventListener('click', () => {
            apiSettings?.classList?.remove('visible');
        });

    // 图片预览功能
        const closeButton = previewModal?.querySelector?.('.image-preview-close') || null;

        closeButton?.addEventListener('click', () => {
            if (!uiConfig.imagePreview.previewModal || !uiConfig.imagePreview.previewImage) return;
            hideImagePreview({ config: uiConfig.imagePreview });
        });

        previewModal?.addEventListener('click', (e) => {
            if (e.target === previewModal) {
                if (!uiConfig.imagePreview.previewModal || !uiConfig.imagePreview.previewImage) return;
                hideImagePreview({ config: uiConfig.imagePreview });
            }
        });

    document.addEventListener('keydown', (e) => {
        // 简单的焦点陷阱：图片预览打开时，Tab 不要跑出对话框
        if (previewModal?.classList?.contains('visible') && e.key === 'Tab') {
            const focusables = Array.from(previewModal.querySelectorAll(
                'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])'
            )).filter((el) => {
                const style = getComputedStyle(el);
                return style.display !== 'none' && style.visibility !== 'hidden';
            });
            if (focusables.length === 0) {
                e.preventDefault();
                return;
            }
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus({ preventScroll: true });
                return;
            }
            if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus({ preventScroll: true });
                return;
            }
        }

        if (e.key !== 'Escape') return;

        let handled = false;

        if (previewModal?.classList?.contains('visible')) {
            if (uiConfig.imagePreview.previewModal && uiConfig.imagePreview.previewImage) {
                hideImagePreview({ config: uiConfig.imagePreview });
            }
            handled = true;
        }

        if (contextMenu?.classList?.contains('visible')) {
            hideContextMenu({ contextMenu, onMessageElementReset: () => {} });
            handled = true;
        }

        if (webpageContentMenu?.classList?.contains('visible')) {
            webpageContentMenu.classList.remove('visible');
            handled = true;
        }

        if (settingsMenu?.classList?.contains('visible')) {
            closeSettingsMenu();
            handled = true;
        }

        if (apiSettings?.classList?.contains('visible')) {
            apiSettings.classList.remove('visible');
            handled = true;
        }

        if (chatListPage?.classList?.contains('show')) {
            hideChatList(chatListPage);
            handled = true;
        }

        if (handled) {
            e.preventDefault();
        }
    });
    } catch (error) {
        console.error('[Cerebr] 初始化失败:', error);
    }
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onDomReady);
} else {
    onDomReady();
}
