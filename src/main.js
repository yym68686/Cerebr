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
    initializeChatList,
    renderChatList
} from './components/chat-list.js';

// 存储用户的问题历史
let userQuestions = [];

document.addEventListener('DOMContentLoaded', async () => {
    const chatContainer = document.getElementById('chat-container');
    const messageInput = document.getElementById('message-input');
    const contextMenu = document.getElementById('context-menu');
    const copyMessageButton = document.getElementById('copy-message');
    const copyCodeButton = document.getElementById('copy-code');
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

    // 修改: 创建一个对象引用来保存当前控制器
    const abortControllerRef = { current: null };
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
        stopUpdateButton,
        deleteMessageButton,
        abortController: abortControllerRef
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
        settingsMenu
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

    // 网答功能
    const webpageSwitch = document.getElementById('webpage-switch');
    const webpageQAContainer = document.getElementById('webpage-qa');

    // 如果不是扩展环境，隐藏网页问答功能
    if (!isExtensionEnvironment) {
        webpageQAContainer.style.display = 'none';
    }

    let pageContent = null;

    // 获取网页内容
    async function getPageContent(skipWaitContent = false) {
        try {
            // console.log('getPageContent 发送获取网页内容请求');
            const response = await browserAdapter.sendMessage({
                type: 'GET_PAGE_CONTENT_FROM_SIDEBAR',
                skipWaitContent: skipWaitContent // 传递是否跳过等待内容加载的参数
            });
            return response;
        } catch (error) {
            console.error('获取网页内容失败:', error);
            return null;
        }
    }

    // 修改 saveWebpageSwitch 函数，改进存储和错误处理
    async function saveWebpageSwitch(domain, enabled) {
        console.log('开始保存网页问答开关状态:', domain, enabled);

        try {
            const result = await storageAdapter.get('webpageSwitchDomains');
            let domains = result.webpageSwitchDomains || {};

            // 只在状态发生变化时才更新
            if (domains[domain] !== enabled) {
                domains[domain] = enabled;
                await storageAdapter.set({ webpageSwitchDomains: domains });
                console.log('网页问答状态已保存:', domain, enabled);
            }
        } catch (error) {
            console.error('保存网页问答状态失败:', error, domain, enabled);
        }
    }

    // 获取当前域名
    async function getCurrentDomain() {
        try {
            const tab = await browserAdapter.getCurrentTab();
            if (!tab) return null;

            // 如果是本地文件，直接返回hostname
            if (tab.hostname === 'local_pdf') {
                return tab.hostname;
            }

            // 处理普通URL
            const hostname = tab.hostname;
            // 规范化域名
            const normalizedDomain = hostname
                .replace(/^www\./, '')  // 移除www前缀
                .toLowerCase();         // 转换为小写

            // console.log('规范化域名:', hostname, '->', normalizedDomain);
            return normalizedDomain;
        } catch (error) {
            // console.error('获取当前域名失败:', error);
            return null;
        }
    }

    // 修改网页问答开关监听器
    webpageSwitch.addEventListener('change', async () => {
        try {
            const domain = await getCurrentDomain();
            console.log('网页问答开关状态改变后，获取当前域名:', domain);

            if (!domain) {
                console.log('无法获取域名，保持开关状态不变');
                webpageSwitch.checked = !webpageSwitch.checked; // 恢复开关状态
                return;
            }

            console.log('网页问答开关状态改变后，获取网页问答开关状态:', webpageSwitch.checked);

            if (webpageSwitch.checked) {
                document.body.classList.add('loading-content');

                try {
                    const content = await getPageContent();
                    if (content) {
                        pageContent = content;
                        await saveWebpageSwitch(domain, true);
                        console.log('修改网页问答为已开启');
                    } else {
                        console.error('获取网页内容失败。');
                    }
                } catch (error) {
                    console.error('获取网页内容失败:', error);
                } finally {
                    document.body.classList.remove('loading-content');
                }
            } else {
                pageContent = null;
                await saveWebpageSwitch(domain, false);
                console.log('修改网页问答为已关闭');
            }
        } catch (error) {
            console.error('处理网页问答开关变化失败:', error);
            webpageSwitch.checked = !webpageSwitch.checked; // 恢复开关状态
        }
    });

    // 监听来自 content script 的消息
    window.addEventListener('message', (event) => {
        // 使用消息输入组件的窗口消息处理函数
        handleWindowMessage(event, {
            messageInput,
            newChatButton,
            uiConfig
        });

        // 处理URL变化事件，因为这涉及到网页问答功能，保留在main.js中
        if (event.data.type === 'URL_CHANGED') {
            console.log('sidebar.js [收到URL变化]', event.data.url);
            if (webpageSwitch.checked) {
                console.log('[网页问答] URL变化，重新获取页面内容');
                document.body.classList.add('loading-content');

                getPageContent()
                    .then(async content => {
                        if (content) {
                            pageContent = content;
                            const domain = await getCurrentDomain();
                            if (domain) {
                                await saveWebpageSwitch(domain, true);
                            }
                        } else {
                            console.error('URL_CHANGED 无法获取网页内容');
                        }
                    })
                    .catch(async error => {
                        console.error('URL_CHANGED 获取网页内容失败:', error);
                    })
                    .finally(() => {
                        document.body.classList.remove('loading-content');
                    });
            }
        }
    });

    // 修改 loadWebpageSwitch 函数
    async function loadWebpageSwitch(call_name = 'loadWebpageSwitch') {
        // console.log(`loadWebpageSwitch 从 ${call_name} 调用`);

        try {
            const domain = await getCurrentDomain();
            // console.log('刷新后 网页问答 获取当前域名:', domain);
            if (!domain) return;

            const result = await storageAdapter.get('webpageSwitchDomains');
            const domains = result.webpageSwitchDomains || {};
            // console.log('刷新后 网页问答存储中获取域名:', domains);

            // 只在开关状态不一致时才更新
            if (domains[domain]) {
                webpageSwitch.checked = domains[domain];
                // 检查当前标签页是否活跃
                const isTabActive = await browserAdapter.sendMessage({
                    type: 'CHECK_TAB_ACTIVE'
                });

                if (isTabActive) {
                    setTimeout(async () => {
                        try {
                            const content = await getPageContent();
                            if (content) {
                                pageContent = content;
                            }
                        } catch (error) {
                            console.error('loadWebpageSwitch 获取网页内容失败:', error);
                        }
                    }, 0);
                }
            } else {
                webpageSwitch.checked = false;
                // console.log('loadWebpageSwitch 域名不在存储中:', domain);
            }
        } catch (error) {
            console.error('加载网页问答状态失败:', error);
        }
    }

    // 在 DOMContentLoaded 事件处理程序中添加加载网页问答状态
    await loadWebpageSwitch();

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
            // 如果网页问答功能开启，重新获取页面内容，不等待内容加载
            if (webpageSwitch.checked) {
                // console.log('发送消息时网页问答已打开，重新获取页面内容');
                try {
                    const content = await getPageContent(true); // 跳过等待内容加载
                    if (content) {
                        pageContent = content;
                        console.log('成功更新 pageContent 内容');
                    }
                } catch (error) {
                    console.error('发送消息时获取页面内容失败:', error);
                }
            }

            // 构建消息内容
            const content = buildMessageContent(message, imageTags);

            // 构建用户消息
            const userMessage = {
                role: "user",
                content: content
            };

            // 先添加用户消息到界面和历史记录
            appendMessage({
                text: messageInput.innerHTML,
                sender: 'user',
                chatContainer,
            });

            // 清空输入框并调整高度
            clearMessageInput(messageInput, uiConfig);

            // 构建消息数组
            const currentChat = chatManager.getCurrentChat();
            const messages = currentChat ? [...currentChat.messages] : [];  // 从chatManager获取消息历史
            messages.push(userMessage);
            chatManager.addMessageToCurrentChat(userMessage);

            // 准备API调用参数
            const apiParams = {
                messages,
                apiConfig: apiConfigs[selectedConfigIndex],
                userLanguage: navigator.language,
                webpageInfo: webpageSwitch.checked ? pageContent : null
            };

            // 调用 API
            const { processStream, controller } = await callAPI(apiParams, chatManager, currentChat.id, chatContainerManager.syncMessage);
            currentController = controller;
            abortControllerRef.current = controller; // 同步更新引用对象

            // 处理流式响应
            await processStream();

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
            }
        }
    }

    // 修改点击事件监听器
    document.addEventListener('click', (e) => {
        // 如果点击的不是设置按钮本身和设置菜单，就关闭菜单
        if (!settingsButton.contains(e.target) && !settingsMenu.contains(e.target)) {
            settingsMenu.classList.remove('visible');
        }
    });

    // 确保设置按钮的点击事件在文档点击事件之前处理
    settingsButton.addEventListener('click', (e) => {
        e.stopPropagation();
        settingsMenu.classList.toggle('visible');
    });

    // 主题切换
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

    // 加载保存的 API 配置
    let apiConfigs = [];
    let selectedConfigIndex = 0;

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
                renderAPICardsWithCallbacks
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
                apiConfigs = result.apiConfigs;
            } else {
                apiConfigs = [{
                    apiKey: '',
                    baseUrl: 'https://api.openai.com/v1/chat/completions',
                    modelName: 'gpt-4o'
                }];
                // 只有在没有任何配置的情况下才保存默认配置
                await saveAPIConfigs();
            }

            // 只有当 selectedConfigIndex 为 undefined 或 null 时才使用默认值 0
            selectedConfigIndex = result.selectedConfigIndex ?? 0;

            // 确保一定会渲染卡片
            renderAPICardsWithCallbacks();
        } catch (error) {
            console.error('加载 API 配置失败:', error);
            // 只有在出错的情况下才使用默认值
            apiConfigs = [{
                apiKey: '',
                baseUrl: 'https://api.openai.com/v1/chat/completions',
                modelName: 'gpt-4o'
            }];
            selectedConfigIndex = 0;
            renderAPICardsWithCallbacks();
        }
    }

    // 监听标签页切换
    browserAdapter.onTabActivated(async () => {
        // console.log('标签页切换，重新加载API配置');
        await loadWebpageSwitch();
        // 同步API配置
        await loadAPIConfigs();
        renderAPICardsWithCallbacks();

        // 同步对话列表
        await chatManager.initialize();
        await renderChatList(
            chatManager,
            chatListPage.querySelector('.chat-cards')
        );
    });
    // 保存配置到存储
    async function saveAPIConfigs() {
        try {
            // 统一使用 syncStorageAdapter 来实现配置同步
            await syncStorageAdapter.set({
                apiConfigs,
                selectedConfigIndex
            });
        } catch (error) {
            console.error('保存 API 配置失败:', error);
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
});