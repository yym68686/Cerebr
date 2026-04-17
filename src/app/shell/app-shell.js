import {
    applyThemePreference,
    normalizeThemePreference,
    THEME_STORAGE_KEY,
    THEME_SYSTEM
} from '../../utils/theme.js';
import { chatManager } from '../../domain/chat/chat-store.js';
import { createChatController } from '../../runtime/chat/chat-controller.js';
import { createDraftController } from '../../runtime/draft/draft-controller.js';
import { hideContextMenu } from '../../components/context-menu.js';
import { initChatContainer } from '../../components/chat-container.js';
import { showImagePreview, hideImagePreview, showToast } from '../../utils/ui.js';
import { renderAPICards, createCardCallbacks, selectCard } from '../../components/api-card.js';
import { initPluginSettings } from '../../components/plugin-settings.js';
import { storageAdapter, syncStorageAdapter, browserAdapter, isExtensionEnvironment } from '../../utils/storage-adapter.js';
import {
    buildMessageContent,
    clearMessageInput,
    getFormattedMessageContent,
    initMessageInput,
    handleWindowMessage,
    moveCaretToEnd,
    setMessageInputContent,
    setPlaceholder,
    setPlaceholderRestoreResolver,
} from '../../components/message-input.js';
import '../../utils/viewport.js';
import {
    hideChatList,
    initChatListEvents,
    loadChatContent,
    initializeChatList
} from '../../components/chat-list.js';
import { initWebpageMenu, getEnabledTabsContent } from '../../components/webpage-menu.js';
import { normalizeChatCompletionsUrl } from '../../utils/api-url.js';
import { DEFAULT_REASONING_EFFORT, normalizeReasoningEffort } from '../../utils/reasoning-effort.js';
import { syncChatBottomExtraPadding } from '../../utils/scroll.js';
import { createReadingProgressManager } from '../../utils/reading-progress.js';
import { applyI18n, initI18n, getLanguagePreference, setLanguagePreference, reloadI18n, t } from '../../utils/i18n.js';
import { getAppVersion } from '../../utils/app-version.js';
import {
    buildDataBackupFilename,
    createDataBackupSnapshot,
    downloadDataBackup,
    parseDataBackupFile,
    restoreDataBackup,
} from '../../utils/data-transfer.js';
import { setWebpageSwitchesForChat } from '../../utils/webpage-switches.js';
import { updateMessageElement } from '../../render/message/message-renderer.js';
import { SITE_KEY_PLUS, getSiteKeyFromHostname, pruneSiteOverridesInPlace } from '../../platform/site-key.js';
import { readDeveloperModePreference, writeDeveloperModePreference } from '../../plugin/dev/developer-mode.js';
import {
    DEFAULT_CHAT_KIND,
    isDefaultChat,
    isDefaultChatSeedOnly,
    isLegacyDefaultChatTitle,
    resolveDefaultChatLocale,
    syncDefaultChatForLocale
} from '../../utils/default-chat.js';
import { createShellPluginRuntime } from '../../plugin/shell/shell-plugin-runtime.js';

// 存储用户的问题历史
let userQuestions = [];

// 将 API 配置提升到模块作用域，以确保在异步事件中状态的稳定性
// 加载保存的 API 配置
let apiConfigs = [];
let selectedConfigIndex = 0;

async function onDomReady() {
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
        const editMessageButton = document.getElementById('edit-message');
        const settingsButton = document.getElementById('settings-button');
        const settingsMenu = document.getElementById('settings-menu');
        const preferencesToggle = document.getElementById('preferences-toggle');
        const pluginsToggle = document.getElementById('plugins-toggle');
        const previewModal = document.querySelector('.image-preview-modal');
        const previewImage = previewModal?.querySelector('img') || null;
        const chatListPage = document.getElementById('chat-list-page');
        const newChatButton = document.getElementById('new-chat');
        const chatListButton = document.getElementById('chat-list');
        const apiSettings = document.getElementById('api-settings');
        const preferencesSettings = document.getElementById('preferences-settings');
        const pluginSettings = document.getElementById('plugin-settings');
        const deleteMessageButton = document.getElementById('delete-message');
        const regenerateMessageButton = document.getElementById('regenerate-message');
        const webpageQAContainer = document.getElementById('webpage-qa');
        const webpageContentMenu = document.getElementById('webpage-content-menu');
        const inputContainer = document.getElementById('input-container');
        const confirmEditButton = document.getElementById('confirm-edit-button');
        const preferencesVersion = document.getElementById('preferences-version');
        const preferencesFontScale = document.getElementById('preferences-font-scale');
        const preferencesFeedback = document.getElementById('preferences-feedback');
        const preferencesLanguage = document.getElementById('preferences-language');
        const preferencesTheme = document.getElementById('preferences-theme');
        const preferencesDeveloperMode = document.getElementById('preferences-developer-mode');
        const preferencesDataExport = document.getElementById('preferences-export-data');
        const preferencesDataImport = document.getElementById('preferences-import-data');
        const preferencesImportFile = document.getElementById('preferences-import-file');
        const scrollToBottomButton = document.getElementById('scroll-to-bottom');
        const pluginInputActions = document.getElementById('plugin-input-actions');
        const pluginSlashCommands = document.getElementById('plugin-slash-commands');
        const pluginMenuItems = document.getElementById('plugin-menu-items');
        const pluginShellPage = document.getElementById('plugin-shell-page');
        const pluginShellPageBack = document.getElementById('plugin-shell-page-back');
        const pluginShellPageTitle = document.getElementById('plugin-shell-page-title');
        const pluginShellPageSubtitle = document.getElementById('plugin-shell-page-subtitle');
        const pluginShellPageBody = document.getElementById('plugin-shell-page-body');
        const shellSlotContainers = Object.fromEntries(
            Array.from(document.querySelectorAll('[data-plugin-slot^="shell."]'))
                .map((element) => [element.dataset.pluginSlot, element])
        );

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

        let readingProgressManager = null;

        const syncLocalizedChats = async ({ rerenderCurrent = false } = {}) => {
            const locale = await resolveDefaultChatLocale();
            const newTitle = t('chat_new_title');
            const legacyNewTitles = new Set(['新对话', '新對話', 'New chat']);
            const changedChatIds = new Set();
            const activeChatId = chatManager.getCurrentChat()?.id || null;

            for (const chat of chatManager.getAllChats?.() || []) {
                if (!chat?.id || !Array.isArray(chat.messages)) continue;

                let changed = false;
                const shouldPromoteLegacyDefault = !isDefaultChat(chat) &&
                    chat.messages.length === 0 &&
                    isLegacyDefaultChatTitle(chat.title);

                if (shouldPromoteLegacyDefault) {
                    chat.kind = DEFAULT_CHAT_KIND;
                    chat.titleLocaleBound = true;
                    changed = true;
                }

                if (isDefaultChat(chat)) {
                    if (syncDefaultChatForLocale(chat, locale, {
                        insertSeedsWhenEmpty: chat.messages.length === 0
                    })) {
                        changed = true;
                    }
                } else if (chat.messages.length === 0 && legacyNewTitles.has(chat.title) && chat.title !== newTitle) {
                    chat.title = newTitle;
                    changed = true;
                }

                if (changed) {
                    changedChatIds.add(chat.id);
                    chatManager.markChatDirty?.(chat.id, { touchUpdatedAt: false });
                }
            }

            if (changedChatIds.size === 0) return;

            await chatManager.saveChats?.({ touchCurrentChat: false });
            await chatManager.flushNow?.().catch(() => {});

            if (!rerenderCurrent || !activeChatId || !changedChatIds.has(activeChatId)) return;

            if (readingProgressManager) {
                await readingProgressManager.saveNow().catch(() => {});
            }

            const currentChat = chatManager.getCurrentChat();
            if (!currentChat) return;

            await loadChatContent(currentChat, chatContainer);
            chatContainerManager.initializeUserQuestions();
            if (readingProgressManager) {
                await readingProgressManager.restore(currentChat.id);
            }
        };

        let managedPlaceholderState = 'default';

        const getSelectedModelName = () => {
            const configuredModelName = apiConfigs[selectedConfigIndex]?.modelName;
            const normalizedModelName = typeof configuredModelName === 'string'
                ? configuredModelName.trim()
                : '';
            return normalizedModelName || 'gpt-4o';
        };

        const getManagedPlaceholderText = (state = managedPlaceholderState) => {
            const modelName = getSelectedModelName();

            switch (state) {
            case 'thinking':
                return t('message_input_placeholder_thinking');
            case 'replying':
                return t('message_input_placeholder_replying');
            default:
                return t('message_input_placeholder_with_model', [modelName]);
            }
        };

        const applyManagedPlaceholder = (state) => {
            managedPlaceholderState = state;
            setPlaceholder({ messageInput, placeholder: getManagedPlaceholderText(state) });
        };

        const refreshManagedPlaceholder = () => {
            setPlaceholder({ messageInput, placeholder: getManagedPlaceholderText() });
        };

        setPlaceholderRestoreResolver(() => getManagedPlaceholderText());

        const setThinkingPlaceholder = () => {
            applyManagedPlaceholder('thinking');
        };

        const setReplyingPlaceholder = () => {
            applyManagedPlaceholder('replying');
        };

        const restoreDefaultPlaceholder = () => {
            applyManagedPlaceholder('default');
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
        // 仅扩展环境支持侧边栏 iframe 拖动（Web 版即使被嵌入也不启用）
        if (!isExtensionEnvironment) return;
        // 仅在被嵌入（扩展侧边栏 iframe）时启用
        if (window.top === window) return;
        if (!chatContainer) return;

        try {
            document.documentElement?.classList?.add('cerebr-extension-sidebar-iframe');
        } catch {
            // ignore
        }

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
    const DRAFT_KEY_PREFIX = 'cerebr_draft_v1_';
    const draftKeyForChatId = (chatId) => `${DRAFT_KEY_PREFIX}${chatId}`;

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

    const shellPluginRuntime = createShellPluginRuntime({
        messageInput,
        inputContainer,
        inputActionsContainer: pluginInputActions,
        slashCommandsContainer: pluginSlashCommands,
        menuItemsContainer: pluginMenuItems,
        pageElements: {
            root: pluginShellPage,
            backButton: pluginShellPageBack,
            titleElement: pluginShellPageTitle,
            subtitleElement: pluginShellPageSubtitle,
            bodyElement: pluginShellPageBody,
        },
        slotContainers: shellSlotContainers,
    });

    const chatController = createChatController({
        chatContainer,
        messageInput,
        uiConfig,
        chatContainerManager,
        chatManager,
        getReadingProgressManager: () => readingProgressManager,
        getSelectedApiConfig: () => apiConfigs[selectedConfigIndex],
        getWebpageInfo: async () => (isExtensionEnvironment ? await getEnabledTabsContent() : null),
        getUserLanguage: () => navigator.language,
        getDraftKeyForChatId: draftKeyForChatId,
        storageAdapter,
        shouldStickToBottom,
        setThinkingPlaceholder,
        setReplyingPlaceholder,
        restoreDefaultPlaceholder,
        pluginRuntime: shellPluginRuntime,
    });
    shellPluginRuntime.attachChatRuntime(chatController);

    const closePluginShellPage = (reason = 'host-navigation') => {
        try {
            shellPluginRuntime.dismissPage?.(reason);
        } catch (error) {
            console.warn('[Cerebr] Failed to close shell plugin page', error);
        }
    };

    const cloneMessageContent = (content) => Array.isArray(content)
        ? content.map((part) => {
            if (!part || typeof part !== 'object') return part;
            if (part.type === 'image_url') {
                return {
                    ...part,
                    image_url: part.image_url && typeof part.image_url === 'object'
                        ? { ...part.image_url }
                        : part.image_url
                };
            }
            return { ...part };
        })
        : String(content ?? '');

    const isMessageContentEmpty = (content) => {
        if (Array.isArray(content)) {
            return content.every((part) => {
                if (!part || typeof part !== 'object') return true;
                if (part.type === 'text') return !String(part.text || '').trim();
                if (part.type === 'image_url') return !String(part?.image_url?.url || '').trim();
                return true;
            });
        }

        return !String(content ?? '').trim();
    };

    const getChatMessageElements = () => Array.from(chatContainer.querySelectorAll('.message'));

    const restoreInputFromContent = (content) => {
        if (isMessageContentEmpty(content)) {
            clearMessageInput(messageInput, uiConfig);
            messageInput.dispatchEvent(new Event('input', { bubbles: true }));
            return;
        }

        setMessageInputContent(messageInput, cloneMessageContent(content), uiConfig);
    };

    const captureCurrentDraftContent = () => {
        const { message, imageTags } = getFormattedMessageContent(messageInput);
        return cloneMessageContent(buildMessageContent(message, imageTags));
    };

    const messageEditState = {
        active: false,
        chatId: null,
        messageIndex: -1,
        messageElement: null,
        previousDraftContent: '',
    };

    const syncMessageEditUi = () => {
        const isActive = !!messageEditState.active;
        inputContainer?.classList?.toggle('is-editing-message', isActive);
        if (confirmEditButton) {
            confirmEditButton.hidden = !isActive;
        }
    };

    const clearMessageEditState = ({
        restorePreviousDraft = true,
        focusInput = false,
        syncInput = true,
    } = {}) => {
        const previousDraftContent = cloneMessageContent(messageEditState.previousDraftContent);

        if (messageEditState.messageElement?.isConnected) {
            messageEditState.messageElement.classList.remove('is-editing');
        }

        messageEditState.active = false;
        messageEditState.chatId = null;
        messageEditState.messageIndex = -1;
        messageEditState.messageElement = null;
        messageEditState.previousDraftContent = '';
        syncMessageEditUi();

        if (syncInput) {
            if (restorePreviousDraft) {
                restoreInputFromContent(previousDraftContent);
            } else {
                clearMessageInput(messageInput, uiConfig);
                messageInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }

        if (focusInput) {
            messageInput.focus({ preventScroll: true });
            moveCaretToEnd(messageInput);
        }
    };

    const startMessageEdit = (messageElement) => {
        if (!messageElement?.isConnected || !messageElement.classList?.contains('user-message')) {
            return false;
        }

        const currentChat = chatManager.getCurrentChat();
        if (!currentChat?.id) {
            return false;
        }

        const messageIndex = getChatMessageElements().indexOf(messageElement);
        const targetMessage = currentChat.messages?.[messageIndex];
        if (!targetMessage || targetMessage.role !== 'user') {
            return false;
        }

        const previousDraftContent = messageEditState.active
            ? cloneMessageContent(messageEditState.previousDraftContent)
            : captureCurrentDraftContent();

        if (messageEditState.messageElement?.isConnected) {
            messageEditState.messageElement.classList.remove('is-editing');
        }

        messageEditState.active = true;
        messageEditState.chatId = currentChat.id;
        messageEditState.messageIndex = messageIndex;
        messageEditState.messageElement = messageElement;
        messageEditState.previousDraftContent = previousDraftContent;

        messageElement.classList.add('is-editing');
        syncMessageEditUi();
        restoreInputFromContent(targetMessage.content);
        messageInput.focus({ preventScroll: true });
        moveCaretToEnd(messageInput);
        return true;
    };

    const confirmMessageEdit = async () => {
        if (!messageEditState.active) return false;

        const currentChat = chatManager.getCurrentChat();
        if (!currentChat?.id || currentChat.id !== messageEditState.chatId) {
            clearMessageEditState({ restorePreviousDraft: false, syncInput: false });
            return false;
        }

        const messageElement = messageEditState.messageElement;
        const liveMessageIndex = messageElement?.isConnected
            ? getChatMessageElements().indexOf(messageElement)
            : -1;
        const messageIndex = liveMessageIndex !== -1 ? liveMessageIndex : messageEditState.messageIndex;
        const currentMessage = currentChat.messages?.[messageIndex];
        if (!messageElement?.isConnected || !currentMessage || currentMessage.role !== 'user') {
            clearMessageEditState({ restorePreviousDraft: false, syncInput: false });
            return false;
        }

        const { message, imageTags } = getFormattedMessageContent(messageInput);
        if (!message.trim() && imageTags.length === 0) {
            showToast(t('message_edit_empty'), { type: 'error' });
            messageInput.focus({ preventScroll: true });
            return false;
        }

        const nextContent = buildMessageContent(message, imageTags);
        if (JSON.stringify(currentMessage.content ?? '') === JSON.stringify(nextContent)) {
            clearMessageEditState({ restorePreviousDraft: true, focusInput: true });
            return true;
        }

        const nextMessage = {
            ...currentMessage,
            role: 'user',
            content: cloneMessageContent(nextContent)
        };
        delete nextMessage.reasoning_content;
        delete nextMessage.updating;
        delete nextMessage.seedId;
        delete nextMessage.seedVersion;
        delete nextMessage.seedLocaleBound;

        chatController.abortActiveReply();
        await chatManager.updateMessageAt(currentChat.id, messageIndex, nextMessage);
        await updateMessageElement({
            messageElement,
            text: nextMessage,
            sender: 'user'
        });
        chatContainerManager.initializeUserQuestions();
        clearMessageEditState({ restorePreviousDraft: true, focusInput: true });
        await chatManager.flushNow().catch(() => {});
        showToast(t('toast_message_edited'), { type: 'success' });
        return true;
    };

    const cancelMessageEdit = () => {
        if (!messageEditState.active) return false;
        clearMessageEditState({ restorePreviousDraft: true, focusInput: true });
        return true;
    };

    syncMessageEditUi();

    // 设置按钮事件处理
    chatContainerManager.setupButtonHandlers({
        copyMessageButton,
        copyCodeButton,
        copyImageButton,
        stopUpdateButton,
        editMessageButton,
        deleteMessageButton,
        regenerateMessageButton,
        abortController: chatController.abortControllerRef,
        regenerateMessage: chatController.regenerateMessage,
        editMessage: startMessageEdit,
    });

    // 初始化消息输入组件
    initMessageInput({
        messageInput,
        sendMessage: chatController.sendMessage,
        confirmMessageEdit,
        isEditingMessage: () => messageEditState.active,
        confirmEditButton,
        cancelMessageEdit,
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
    await syncLocalizedChats({ rerenderCurrent: false });

    readingProgressManager = createReadingProgressManager({
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

    const draftController = createDraftController({
        messageInput,
        uiConfig,
        storageAdapter,
        chatManager,
        getReadingProgressManager: () => readingProgressManager,
        draftKeyForChatId,
    });
    draftController.attach();

    document.addEventListener('cerebr:chatSwitched', () => {
        if (!messageEditState.active) return;
        clearMessageEditState({ restorePreviousDraft: false, syncInput: false });
    });

    const flushSessionState = () => {
        void draftController.saveDraftNow().catch(() => {});
        void readingProgressManager.saveNow().catch(() => {});
        void chatManager.flushNow().catch(() => {});
    };

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            flushSessionState();
        }
    });
    window.addEventListener('pagehide', flushSessionState);

    if ((!currentChat || currentChat.messages.length === 0 || isDefaultChatSeedOnly(currentChat)) && isExtensionEnvironment) {
        const currentTab = await browserAdapter.getCurrentTab();
        if (currentTab?.id && currentChat?.id) {
            await setWebpageSwitchesForChat(currentChat.id, { [currentTab.id]: true });
        }
    }

    // 如果不是扩展环境，隐藏网页问答功能
    if (!isExtensionEnvironment && webpageQAContainer) {
        webpageQAContainer.style.display = 'none';
    }

    await shellPluginRuntime.start();

    const notifyParentIframeReady = () => {
        if (!isExtensionEnvironment) return;
        if (window.top === window) return;
        try {
            window.parent?.postMessage?.({ type: 'CEREBR_IFRAME_READY' }, '*');
        } catch {
            // ignore
        }
    };

    // 监听来自 content script 的消息
    window.addEventListener('message', (event) => {
        // 使用消息输入组件的窗口消息处理函数
        handleWindowMessage(event, {
            messageInput,
            newChatButton,
            uiConfig
        });
    });
    notifyParentIframeReady();

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

    const themeConfig = {
        root: document.documentElement,
        themeSelect: preferencesTheme
    };

    async function readThemePreference() {
        const result = await syncStorageAdapter.get(THEME_STORAGE_KEY);
        return normalizeThemePreference(result?.[THEME_STORAGE_KEY]);
    }

    async function initTheme() {
        try {
            const themePreference = await readThemePreference();
            applyThemePreference(themePreference, themeConfig);
        } catch (error) {
            console.error('初始化主题失败:', error);
            applyThemePreference(THEME_SYSTEM, themeConfig);
        }
    }

    let lastAppliedThemePreference = THEME_SYSTEM;

    const prefersDarkQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSystemThemeChange = async () => {
        try {
            const themePreference = await readThemePreference();
            if (themePreference === THEME_SYSTEM) {
                applyThemePreference(THEME_SYSTEM, themeConfig);
            }
        } catch (error) {
            console.error('响应系统主题变化失败:', error);
            applyThemePreference(THEME_SYSTEM, themeConfig);
        }
    };
    if (typeof prefersDarkQuery.addEventListener === 'function') {
        prefersDarkQuery.addEventListener('change', handleSystemThemeChange);
    } else if (typeof prefersDarkQuery.addListener === 'function') {
        prefersDarkQuery.addListener(handleSystemThemeChange);
    }

    await initTheme();
    lastAppliedThemePreference = normalizeThemePreference(preferencesTheme?.value);

    const persistThemePreference = async (value) => {
        const themePreference = normalizeThemePreference(value);
        if (themePreference === lastAppliedThemePreference) return;

        applyThemePreference(themePreference, themeConfig);
        try {
            await syncStorageAdapter.set({ [THEME_STORAGE_KEY]: themePreference });
            lastAppliedThemePreference = themePreference;
        } catch (error) {
            console.error('保存主题设置失败:', error);
        }
    };

    if (preferencesTheme) {
        preferencesTheme.addEventListener('change', async () => {
            await persistThemePreference(preferencesTheme.value);
        });
    }

    // 字体大小设置（通过 CSS 变量控制）
    const FONT_SCALE_KEY = 'fontScale';
    const FONT_SCALE_PRESETS = [0.9, 1, 1.1, 1.2];
    const SITE_OVERRIDES_KEY = 'panelSiteOverridesV1';

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

    let lastAppliedFontScale = 1;

    const persistFontScalePreference = async (value) => {
        const selected = toPreset(value);
        if (selected === lastAppliedFontScale) return;

        applyFontScale(selected);
        try {
            if (!currentSiteKey) {
                await syncStorageAdapter.set({ [FONT_SCALE_KEY]: selected });
                lastAppliedFontScale = selected;
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
            lastAppliedFontScale = selected;
        } catch (error) {
            console.error('保存字体大小失败:', error);
        }
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
                lastAppliedFontScale = migrated;
                if (preferencesFontScale) preferencesFontScale.value = String(migrated);
                return;
            }
        }

        const initialScale = Number.isFinite(siteScale) ? toPreset(siteScale) : globalScale;
        applyFontScale(initialScale);
        lastAppliedFontScale = initialScale;
        if (preferencesFontScale) {
            preferencesFontScale.value = String(initialScale);
        }
    } catch (error) {
        console.error('初始化字体大小失败:', error);
        applyFontScale(1);
        lastAppliedFontScale = 1;
    }

    // API 设置功能
    const apiSettingsToggle = document.getElementById('api-settings-toggle');
    const backButton = apiSettings?.querySelector('.back-button') || null;
    const apiCards = apiSettings?.querySelector('.api-cards') || null;

    // 偏好设置页面
    const preferencesBackButton = preferencesSettings?.querySelector('.back-button');
    const pluginSettingsBackButton = pluginSettings?.querySelector('.back-button') || null;
    const pluginSettingsStatus = pluginSettings?.querySelector('#plugin-settings-status') || null;

    const appVersion = await getAppVersion();
    if (preferencesVersion) {
        preferencesVersion.textContent = appVersion;
    }

    let pluginSettingsController = null;
    let pluginSettingsControllerPromise = null;
    let lastAppliedLanguagePreference = 'auto';
    let lastAppliedDeveloperModeEnabled = false;

    const applyDeveloperModeUI = (enabled) => {
        const nextEnabled = !!enabled;

        if (pluginsToggle) {
            pluginsToggle.hidden = !nextEnabled;
            pluginsToggle.style.display = nextEnabled ? '' : 'none';
        }

        if (pluginSettings) {
            pluginSettings.hidden = !nextEnabled;
            if (!nextEnabled) {
                pluginSettings.classList.remove('visible');
            }
        }
    };

    const persistDeveloperModePreference = async (enabled) => {
        const nextEnabled = !!enabled;
        applyDeveloperModeUI(nextEnabled);
        if (nextEnabled === lastAppliedDeveloperModeEnabled) return;

        try {
            await writeDeveloperModePreference(nextEnabled);
            lastAppliedDeveloperModeEnabled = nextEnabled;
        } catch (error) {
            console.error('保存开发者模式失败:', error);
            applyDeveloperModeUI(lastAppliedDeveloperModeEnabled);
            if (preferencesDeveloperMode) {
                preferencesDeveloperMode.checked = lastAppliedDeveloperModeEnabled;
            }
        }
    };

    const ensurePluginSettingsController = () => {
        if (pluginSettingsController) {
            return Promise.resolve(pluginSettingsController);
        }

        if (!pluginSettingsControllerPromise) {
            pluginSettingsControllerPromise = initPluginSettings({
                page: pluginSettings,
            })
                .then((controller) => {
                    pluginSettingsController = controller;
                    return controller;
                })
                .catch((error) => {
                    pluginSettingsControllerPromise = null;
                    throw error;
                });
        }

        return pluginSettingsControllerPromise;
    };

    const handlePluginSettingsInitError = (error) => {
        console.error('[Cerebr] 初始化插件页面失败:', error);
        if (!pluginSettingsStatus) return;
        pluginSettingsStatus.textContent = `${t('plugin_market_sync_failed')}: ${error?.message || String(error)}`;
        pluginSettingsStatus.dataset.state = 'error';
    };

    const openPluginSettingsPage = ({ tabId = '' } = {}) => {
        if (!lastAppliedDeveloperModeEnabled || !pluginSettings) return;
        closePluginShellPage();

        const shouldRefreshAfterEnsure = !!pluginSettingsController;
        if (!shouldRefreshAfterEnsure && !pluginSettingsControllerPromise && pluginSettingsStatus) {
            pluginSettingsStatus.textContent = t('plugin_market_loading');
            pluginSettingsStatus.dataset.state = 'loading';
        }

        pluginSettings.classList.add('visible');
        closeSettingsMenu();

        void ensurePluginSettingsController()
            .then((controller) => {
                if (tabId) {
                    controller?.selectTab?.(tabId);
                }
                if (!shouldRefreshAfterEnsure) return controller;
                return controller?.refresh?.().then(() => {
                    if (tabId) {
                        controller?.selectTab?.(tabId);
                    }
                    return controller;
                });
            })
            .catch(handlePluginSettingsInitError);
    };

    const initialViewParams = (() => {
        try {
            const search = new URLSearchParams(window.location.search);
            return {
                open: search.get('open') || '',
                pluginTab: search.get('pluginTab') || '',
            };
        } catch {
            return {
                open: '',
                pluginTab: '',
            };
        }
    })();

    const persistLanguagePreference = async (value) => {
        const nextPreference = value === 'auto' ? 'auto' : value;
        if (nextPreference === lastAppliedLanguagePreference) return;

        try {
            await setLanguagePreference(nextPreference);
            await reloadI18n();
            applyI18n(document);
            refreshManagedPlaceholder();
            if (lastAppliedDeveloperModeEnabled) {
                await pluginSettingsController?.refresh?.();
            }
            await syncLocalizedChats({ rerenderCurrent: true });
            lastAppliedLanguagePreference = nextPreference;
        } catch (error) {
            console.error('保存语言设置失败:', error);
        }
    };

    if (preferencesLanguage) {
        try {
            preferencesLanguage.value = await getLanguagePreference();
        } catch {
            preferencesLanguage.value = 'auto';
        }
        lastAppliedLanguagePreference = preferencesLanguage.value;
        preferencesLanguage.addEventListener('change', async () => {
            await persistLanguagePreference(preferencesLanguage.value);
        });
    }

    if (preferencesDeveloperMode) {
        const initialDeveloperModeEnabled = await readDeveloperModePreference();
        preferencesDeveloperMode.checked = initialDeveloperModeEnabled;
        lastAppliedDeveloperModeEnabled = initialDeveloperModeEnabled;
        applyDeveloperModeUI(initialDeveloperModeEnabled);

        preferencesDeveloperMode.addEventListener('change', async () => {
            await persistDeveloperModePreference(preferencesDeveloperMode.checked);
        });
    } else {
        applyDeveloperModeUI(false);
    }

    if (initialViewParams.open === 'plugins' && lastAppliedDeveloperModeEnabled) {
        openPluginSettingsPage({
            tabId: initialViewParams.pluginTab,
        });
    }

    const commitPendingPreferences = async () => {
        const activeElement = document.activeElement;
        if (preferencesSettings?.contains(activeElement) && typeof activeElement?.blur === 'function') {
            activeElement.blur();
        }

        if (preferencesTheme) {
            await persistThemePreference(preferencesTheme.value);
        }
        if (preferencesFontScale) {
            await persistFontScalePreference(preferencesFontScale.value);
        }
        if (preferencesLanguage) {
            await persistLanguagePreference(preferencesLanguage.value);
        }
        if (preferencesDeveloperMode) {
            await persistDeveloperModePreference(preferencesDeveloperMode.checked);
        }
    };

    if (preferencesToggle && preferencesSettings) {
        preferencesToggle.addEventListener('click', () => {
            closePluginShellPage();
            preferencesSettings.classList.add('visible');
            closeSettingsMenu();
        });
    }

    if (preferencesBackButton && preferencesSettings) {
        preferencesBackButton.addEventListener('click', async () => {
            await commitPendingPreferences();
            preferencesSettings.classList.remove('visible');
        });
    }

    if (preferencesFeedback) {
        preferencesFeedback.addEventListener('click', async () => {
            await commitPendingPreferences();
            openExternal(FEEDBACK_URL);
            preferencesSettings?.classList.remove('visible');
        });
    }

    if (preferencesFontScale) {
        preferencesFontScale.addEventListener('change', async () => {
            await persistFontScalePreference(preferencesFontScale.value);
        });
    }

    if (pluginsToggle && pluginSettings) {
        pluginsToggle.addEventListener('click', () => {
            openPluginSettingsPage();
        });
    }

    if (pluginSettingsBackButton && pluginSettings) {
        pluginSettingsBackButton.addEventListener('click', () => {
            pluginSettings.classList.remove('visible');
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
            reasoningEffort: normalizeReasoningEffort(normalized.advancedSettings?.reasoningEffort),
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
                refreshManagedPlaceholder();
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
                onConfigChange: (index, _newConfig, options = {}) => {
                    if (index === selectedConfigIndex && options.kind === 'apiFields') {
                        refreshManagedPlaceholder();
                    }
                },
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
                        reasoningEffort: DEFAULT_REASONING_EFFORT,
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
                    reasoningEffort: DEFAULT_REASONING_EFFORT,
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
        if (currentChat && (currentChat.messages.length === 0 || isDefaultChatSeedOnly(currentChat))) {
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
        refreshManagedPlaceholder();
    }

    // 等待 DOM 加载完成后再初始化
    await loadAPIConfigs();
    refreshManagedPlaceholder();

    const flushAllPersistedStateForTransfer = async () => {
        await commitPendingPreferences();
        await Promise.all([
            flushApiConfigsPersist(),
            draftController.saveDraftNow(),
            readingProgressManager?.saveNow?.() || Promise.resolve(),
            chatManager.flushNow(),
        ]);
    };

    if (preferencesDataExport) {
        preferencesDataExport.addEventListener('click', async () => {
            try {
                await flushAllPersistedStateForTransfer();
                const snapshot = await createDataBackupSnapshot({ appVersion });
                const exportedAt = new Date(snapshot.exportedAt);
                downloadDataBackup(snapshot, {
                    filename: buildDataBackupFilename(Number.isNaN(exportedAt.getTime()) ? new Date() : exportedAt)
                });
                showToast(t('toast_data_exported'), { type: 'success' });
            } catch (error) {
                console.error('导出数据失败:', error);
                showToast(t('error_data_export_failed'), { type: 'error', durationMs: 2400 });
            }
        });
    }

    if (preferencesDataImport && preferencesImportFile) {
        preferencesDataImport.addEventListener('click', () => {
            preferencesImportFile.value = '';
            preferencesImportFile.click();
        });

        preferencesImportFile.addEventListener('change', async () => {
            const file = preferencesImportFile.files?.[0] || null;
            preferencesImportFile.value = '';
            if (!file) return;

            let snapshot;
            try {
                snapshot = await parseDataBackupFile(file);
            } catch (error) {
                console.error('读取备份文件失败:', error);
                showToast(t('error_data_import_invalid'), { type: 'error', durationMs: 2800 });
                return;
            }

            if (!window.confirm(t('preferences_data_import_confirm'))) {
                return;
            }

            try {
                await restoreDataBackup(snapshot);
                showToast(t('toast_data_imported'), { type: 'success', durationMs: 1400 });
                window.setTimeout(() => {
                    window.location.reload();
                }, 900);
            } catch (error) {
                console.error('导入数据失败:', error);
                showToast(t('error_data_import_failed'), { type: 'error', durationMs: 2800 });
            }
        });
    }

    // 显示/隐藏 API 设置
    apiSettingsToggle?.addEventListener('click', () => {
        closePluginShellPage();
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

        if (pluginSettings?.classList?.contains('visible')) {
            pluginSettings.classList.remove('visible');
            handled = true;
        }

        if (shellPluginRuntime.hasOpenPage?.()) {
            shellPluginRuntime.dismissPage?.('escape');
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
}

export function bootAppShell() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onDomReady, { once: true });
    } else {
        void onDomReady();
    }
}
