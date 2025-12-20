import { setTheme } from './utils/theme.js';
import { callAPI } from './services/chat.js';
import { chatManager } from './utils/chat-manager.js';
import { appendMessage } from './handlers/message-handler.js';
import { hideContextMenu } from './components/context-menu.js';
import { initChatContainer } from './components/chat-container.js';
import { showImagePreview, hideImagePreview } from './utils/ui.js';
import { renderAPICards, createCardCallbacks, selectCard } from './components/api-card.js';
import { storageAdapter, syncStorageAdapter, browserAdapter, isExtensionEnvironment } from './utils/storage-adapter.js';
import { initMessageInput, getFormattedMessageContent, buildMessageContent, clearMessageInput, handleWindowMessage } from './components/message-input.js';
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

// 存储用户的问题历史
let userQuestions = [];

// 将 API 配置提升到模块作用域，以确保在异步事件中状态的稳定性
// 加载保存的 API 配置
let apiConfigs = [];
let selectedConfigIndex = 0;

document.addEventListener('DOMContentLoaded', async () => {
    const chatContainer = document.getElementById('chat-container');
    const messageInput = document.getElementById('message-input');
    const contextMenu = document.getElementById('context-menu');
    const copyMessageButton = document.getElementById('copy-message');
    const copyCodeButton = document.getElementById('copy-code');
    const copyImageButton = document.getElementById('copy-image');
    const stopUpdateButton = document.getElementById('stop-update');
    const settingsButton = document.getElementById('settings-button');
    const settingsMenu = document.getElementById('settings-menu');
    const feedbackButton = document.getElementById('feedback-button');
    const previewModal = document.querySelector('.image-preview-modal');
    const previewImage = previewModal.querySelector('img');
    const chatListPage = document.getElementById('chat-list-page');
    const newChatButton = document.getElementById('new-chat');
    const chatListButton = document.getElementById('chat-list');
    const apiSettings = document.getElementById('api-settings');
    const deleteMessageButton = document.getElementById('delete-message');
    const regenerateMessageButton = document.getElementById('regenerate-message');
    const webpageQAContainer = document.getElementById('webpage-qa');
    const webpageContentMenu = document.getElementById('webpage-content-menu');

    syncChatBottomExtraPadding();
    window.addEventListener('resize', () => syncChatBottomExtraPadding());

    // 基础键盘可访问性：让 role="menuitem" 的元素可用 Enter/Space 触发
    document.addEventListener('keydown', (e) => {
        const active = document.activeElement;
        if (!active || active.getAttribute('role') !== 'menuitem') return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            active.click();
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
    });

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

    // 添加反馈按钮点击事件
    feedbackButton.addEventListener('click', () => {
        const newIssueUrl = 'https://github.com/yym68686/Cerebr/issues/new';
        window.open(newIssueUrl, '_blank');
        settingsMenu.classList.remove('visible'); // 使用 classList 来正确切换菜单状态
    });

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
            onMessageElementReset: () => { /* 清空引用 */ }
        }),
        uiConfig,
        settingsMenu,
        webpageContentMenu // 传递二级菜单
    });

    // 初始化ChatManager
    await chatManager.initialize();

    // 初始化用户问题历史
    chatContainerManager.initializeUserQuestions();

    // 初始化对话列表组件
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

    // 加载当前对话内容
    const currentChat = chatManager.getCurrentChat();
    if (currentChat) {
        await loadChatContent(currentChat, chatContainer);
    }

    if ((!currentChat || currentChat.messages.length === 0) && isExtensionEnvironment) {
        const currentTab = await browserAdapter.getCurrentTab();
        if (currentTab) {
            await storageAdapter.set({ webpageSwitches: { [currentTab.id]: true } });
        }
    }

    // 如果不是扩展环境，隐藏网页问答功能
    if (!isExtensionEnvironment) {
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
    document.addEventListener('cerebr:chatSwitched', (event) => {
        const nextChatId = event?.detail?.chatId;
        void (async () => {
            if (draftChatId && draftChatId !== nextChatId) {
                await saveDraftNow(draftChatId);
            }
            draftChatId = nextChatId || null;
            clearMessageInput(messageInput, uiConfig);
            await restoreDraft(draftChatId);
        })();
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
    async function callAPIWithRetry(apiParams, chatManager, chatId, onMessageUpdate, maxRetries = 10) {
        let attempt = 0;
        while (attempt <= maxRetries) {
            const { processStream, controller } = await callAPI(apiParams, chatManager, chatId, onMessageUpdate);
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

            const result = await processStream();

            // 如果 content 为空但 reasoning_content 不为空，则可能被截断，进行重试
            if (result && !result.content && result.reasoning_content && attempt < maxRetries) {
                console.log(`API响应可能被截断，正在重试... (尝试次数 ${attempt + 1})`);
                attempt++;
                // 在重试前，将不完整的 assistant 消息从历史记录中移除
                chatManager.popMessage();
            } else {
                return; // 成功或达到最大重试次数
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

            const domMessages = Array.from(chatContainer.querySelectorAll('.user-message, .ai-message'));
            const aiMessageDomIndex = domMessages.indexOf(aiMessageElement);

            // 通过比较DOM和历史记录中的消息数量，判断是否在从一个临时错误消息中重新生成
            const historyMessages = currentChat.messages.filter(m => ['user', 'assistant'].includes(m.role));
            if (domMessages.length === historyMessages.length && aiMessageDomIndex !== -1) {
                // 正常情况：重新生成一个已保存的响应。
                // 我们需要从历史记录中删除旧的响应。
                currentChat.messages.splice(aiMessageDomIndex);
            } else if (domMessages.length === historyMessages.length + 2) {
                currentChat.messages.push({
                    role: 'user',
                    content: userMessageElement.textContent
                });
            }
            // 错误情况：如果 domMessages.length > historyMessages.length，
            // 意味着最后一个消息是未保存的错误消息。
            // 在这种情况下，我们不修改历史记录，因为它已经是正确的了。
            chatManager.saveChats();

            // 从DOM中移除AI消息（无论是错误消息还是旧的成功消息）及其之后的所有消息
            domMessages.slice(currentChat.messages.length).forEach(el => el.remove());

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
                ensureChatElementVisible({ chatContainer, element, behavior: 'smooth' });
            });

            // 调用带重试逻辑的 API
            await callAPIWithRetry(apiParams, chatManager, currentChat.id, chatContainerManager.syncMessage);

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('用户手动停止更新');
                return;
            }
            console.error('重新生成消息失败:', error);
            appendMessage({
                text: '重新生成失败: ' + error.message,
                sender: 'ai',
                chatContainer,
                skipHistory: true,
            });
        } finally {
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

            // 构建消息数组
            const currentChat = chatManager.getCurrentChat();
            if (currentChat?.id) {
                await storageAdapter.remove(draftKeyForChatId(currentChat.id));
            }
            const messages = currentChat ? [...currentChat.messages] : [];  // 从chatManager获取消息历史
            messages.push(userMessage);
            chatManager.addMessageToCurrentChat(userMessage);

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
                ensureChatElementVisible({ chatContainer, element, behavior: 'smooth' });
            });

            // 调用带重试逻辑的 API
            await callAPIWithRetry(apiParams, chatManager, currentChat.id, chatContainerManager.syncMessage);

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('用户手动停止更新');
                return;
            }
            console.error('发送消息失败:', error);
            appendMessage({
                text: '发送失败: ' + error.message,
                sender: 'ai',
                chatContainer,
                skipHistory: true,
            });
            // 从 chatHistory 中移除最后一条记录（用户的问题）
            const currentChat = chatManager.getCurrentChat();
            const messages = currentChat ? [...currentChat.messages] : [];
            if (messages.length > 0) {
                if (messages[messages.length - 1].role === 'assistant') {
                    chatManager.popMessage();
                    chatManager.popMessage();
                } else {
                    chatManager.popMessage();
                }
            }
        } finally {
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

    // 修改点击事件监听器
    document.addEventListener('click', (e) => {
        const isInSettingsArea = settingsButton.contains(e.target) || settingsMenu.contains(e.target);
        const isInWebpageMenuArea = webpageQAContainer.contains(e.target) || webpageContentMenu.contains(e.target);

        // 点击网页内容二级菜单内部时，不要误关一级菜单
        if (!isInSettingsArea && !isInWebpageMenuArea) {
            settingsMenu.classList.remove('visible');
        }

        if (!isInWebpageMenuArea) {
            webpageContentMenu.classList.remove('visible');
        }
    });

   // 初始化网页内容二级菜单
   if (isExtensionEnvironment) {
    initWebpageMenu({ webpageQAContainer, webpageContentMenu });
   }

    // 确保设置按钮的点击事件在文档点击事件之前处理
    settingsButton.addEventListener('click', (e) => {
        e.stopPropagation();
        const isVisible = settingsMenu.classList.toggle('visible');

        // 如果设置菜单被隐藏，也一并隐藏网页内容菜单
        if (!isVisible) {
            webpageContentMenu.classList.remove('visible');
        }
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
    themeSwitch.addEventListener('change', () => {
        setTheme(themeSwitch.checked, themeConfig);
    });

    if (themeToggle && themeSwitch) {
        themeToggle.addEventListener('click', (e) => {
            // 点击开关本身时，让浏览器默认行为处理（避免 toggle 两次导致“没反应”）
            if (e.target.closest('.switch')) return;
            themeSwitch.click();
        });
    }

    // 监听系统主题变化
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async (e) => {
        const data = await syncStorageAdapter.get('theme');
        if (!data.theme) {  // 只有在用户没有手动设置主题时才跟随系统
            setTheme(e.matches, themeConfig);
        }
    });

    // 初始化主题
    await initTheme();

    // API 设置功能
    const apiSettingsToggle = document.getElementById('api-settings-toggle');
    const backButton = document.querySelector('.back-button');
    const apiCards = document.querySelector('.api-cards');

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
            normalized.baseUrl ?? 'https://api.openai.com/v1/chat/completions'
        ) || 'https://api.openai.com/v1/chat/completions';
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
                apiSettings.classList.remove('visible');
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
                    baseUrl: 'https://api.openai.com/v1/chat/completions',
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
                baseUrl: 'https://api.openai.com/v1/chat/completions',
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
    browserAdapter.onTabActivated(async () => {
        // 同步API配置
        await loadAPIConfigs();
        renderAPICardsWithCallbacks();

        // 同步对话数据（对话列表在打开时再渲染，避免后台渲染造成额外布局开销）
        await chatManager.initialize();

        // 如果当前对话为空，则重置网页内容开关
        const currentChat = chatManager.getCurrentChat();
        if (currentChat && currentChat.messages.length === 0) {
            const currentTab = await browserAdapter.getCurrentTab();
            if (currentTab) {
                await storageAdapter.set({ webpageSwitches: { [currentTab.id]: true } });
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
    apiSettingsToggle.addEventListener('click', () => {
        apiSettings.classList.add('visible');
        settingsMenu.classList.remove('visible');
        // 确保每次打开设置时都重新渲染卡片
        renderAPICardsWithCallbacks();
    });

    // 返回聊天界面
    backButton.addEventListener('click', () => {
        apiSettings.classList.remove('visible');
    });

    // 图片预览功能
    const closeButton = previewModal.querySelector('.image-preview-close');

    closeButton.addEventListener('click', () => {
        hideImagePreview({ config: uiConfig.imagePreview });
    });

    previewModal.addEventListener('click', (e) => {
        if (e.target === previewModal) {
            hideImagePreview({ config: uiConfig.imagePreview });
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;

        let handled = false;

        if (previewModal.classList.contains('visible')) {
            hideImagePreview({ config: uiConfig.imagePreview });
            handled = true;
        }

        if (contextMenu.classList.contains('visible')) {
            hideContextMenu({ contextMenu, onMessageElementReset: () => {} });
            handled = true;
        }

        if (webpageContentMenu.classList.contains('visible')) {
            webpageContentMenu.classList.remove('visible');
            handled = true;
        }

        if (settingsMenu.classList.contains('visible')) {
            settingsMenu.classList.remove('visible');
            handled = true;
        }

        if (apiSettings.classList.contains('visible')) {
            apiSettings.classList.remove('visible');
            handled = true;
        }

        if (chatListPage.classList.contains('show')) {
            hideChatList(chatListPage);
            handled = true;
        }

        if (handled) {
            e.preventDefault();
        }
    });
});
