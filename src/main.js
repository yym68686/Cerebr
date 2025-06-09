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
    const previewModal = document.querySelector('.image-preview-modal');
    const previewImage = previewModal.querySelector('img');
    const chatListPage = document.getElementById('chat-list-page');
    const newChatButton = document.getElementById('new-chat');
    const chatListButton = document.getElementById('chat-list');
    const apiSettings = document.getElementById('api-settings');
    const deleteMessageButton = document.getElementById('delete-message');
    const webpageQAButton = document.getElementById('webpage-qa-button');

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
    const webpageQAContainer = document.getElementById('webpage-qa');

    // 如果不是扩展环境，隐藏网页问答功能
    if (!isExtensionEnvironment) {
        webpageQAContainer.style.display = 'none';
    }

    let pageContent = null;

    // 获取网页内容
    async function getPageContent(skipWaitContent = false, tabId = null) {
        try {
            // console.log('getPageContent 发送获取网页内容请求');
            const response = await browserAdapter.sendMessage({
                type: 'GET_PAGE_CONTENT_FROM_SIDEBAR',
                skipWaitContent: skipWaitContent, // 传递是否跳过等待内容加载的参数
                tabId: tabId // 传递标签页ID
            });
            return response;
        } catch (error) {
            console.error('获取网页内容失败:', error);
            return null;
        }
    }

    // 移除域名保存逻辑，新方案不再需要记忆域名状态

    // 获取当前域名
    async function getCurrentDomain() {
        try {
            const response = await browser.runtime.sendMessage({
                type: "getCurrentDomain"
            });
            if (response && response.domain) {
                return { domain: response.domain, tabId: response.tabId };
            } else {
                console.error('无法从后台脚本获取域名:', response);
                return { domain: null, tabId: null };
            }
        } catch (error) {
            console.error('获取当前域名失败:', error);
            return { domain: null, tabId: null };
        }
    }

    // 网页问答按钮状态
    let webpageQAEnabled = false;

    // 更新按钮状态
    function updateWebpageQAButton(enabled) {
        webpageQAEnabled = enabled;
        if (enabled) {
            webpageQAButton.classList.remove('webpage-qa-off');
            webpageQAButton.classList.add('webpage-qa-on');
        } else {
            webpageQAButton.classList.remove('webpage-qa-on');
            webpageQAButton.classList.add('webpage-qa-off');
        }
    }

    // 网页问答按钮点击事件
    webpageQAButton.addEventListener('click', async (event) => {
        try {
            const { domain, tabId } = await getCurrentDomain();
            console.log('网页问答按钮点击，获取当前域名:', domain);
    
            if (!domain) {
                console.log('无法获取域名，无法切换状态');
                return;
            }
    
            // 检查是否是自动触发（通过Alt+Z快捷键）
            const isAutoTrigger = event.isTrusted && webpageQAEnabled === false;
            const newState = isAutoTrigger ? true : !webpageQAEnabled;
            console.log('网页问答按钮切换状态:', newState, isAutoTrigger ? '(自动触发)' : '(手动切换)');
    
            if (newState) {
                // 开启网页问答
                webpageQAButton.classList.add('loading');
                document.body.classList.add('loading-content');
    
                try {
                    const content = await getPageContent(false, tabId);
                    if (content) {
                        if (content.error) {
                            console.error('获取网页内容失败：', content.error, content.details || '');
                            return;
                        } else {
                            pageContent = content;
                            updateWebpageQAButton(true);
                            console.log('网页问答已开启');
                        }
                    } else {
                        console.error('获取网页内容失败：未收到响应');
                        return;
                    }
                } catch (error) {
                    console.error('获取网页内容失败:', error.message || error);
                    return;
                } finally {
                    webpageQAButton.classList.remove('loading');
                    document.body.classList.remove('loading-content');
                }
            } else {
                // 关闭网页问答
                pageContent = null;
                updateWebpageQAButton(false);
                console.log('网页问答已关闭');
            }
        } catch (error) {
            console.error('处理网页问答按钮点击失败:', error);
            webpageQAButton.classList.remove('loading');
        }
    });

    // 初始化按钮状态为关闭
    updateWebpageQAButton(false);

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
            // URL变化时自动关闭网页问答
            if (webpageQAEnabled) {
                console.log('[网页问答] URL变化，自动关闭网页问答');
                pageContent = null;
                updateWebpageQAButton(false);
            }
        }
    });



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
            if (webpageQAEnabled) {
                // console.log('发送消息时网页问答已打开，重新获取页面内容');
                try {
                    const { tabId } = await getCurrentDomain();
                    const content = await getPageContent(true, tabId); // 跳过等待内容加载
                    if (content) {
                        if (content.error) {
                            console.error('发送消息时获取页面内容失败：', content.error, content.details || '');
                        } else {
                            pageContent = content;
                            console.log('成功更新 pageContent 内容');
                        }
                    }
                } catch (error) {
                    console.error('发送消息时获取页面内容失败:', error.message || error);
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
                text: userMessage,
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
                webpageInfo: webpageQAEnabled ? pageContent : null
            };

            // 调用 API
            const { processStream, controller } = await callAPI(apiParams, chatManager, currentChat.id, chatContainerManager.syncMessage);
            currentController = controller;
            abortControllerRef.current = controller; // 同步更新引用对象

            // 处理流式响应
            await processStream();
            
            // 流式输出结束后，自动折叠深度思考内容
            const lastAiMessage = chatContainer.querySelector('.ai-message:last-child');
            if (lastAiMessage) {
                const reasoningDiv = lastAiMessage.querySelector('.reasoning-content');
                if (reasoningDiv && !reasoningDiv.classList.contains('collapsed')) {
                    reasoningDiv.classList.add('collapsed');
                }
            }

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
    const themeSelect = document.getElementById('theme-select');

    // 创建主题配置对象
    const themeConfig = {
        root: document.documentElement,
        themeSelect,
        saveTheme: async (theme) => await syncStorageAdapter.set({ theme })
    };

    // 初始化主题
    async function initTheme() {
        try {
            const result = await syncStorageAdapter.get('theme');
            // 默认跟随系统，如果没有保存的设置
            const themeMode = result.theme || 'auto';
            setTheme(themeMode, themeConfig);
        } catch (error) {
            console.error('初始化主题失败:', error);
            // 如果出错，使用跟随系统模式
            setTheme('auto', themeConfig);
        }
    }

    // 监听主题切换
    themeSelect.addEventListener('change', () => {
        setTheme(themeSelect.value, themeConfig);
    });

    // 监听系统主题变化
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async (e) => {
        const data = await syncStorageAdapter.get('theme');
        // 只有在设置为跟随系统时才响应系统主题变化
        if (data.theme === 'auto' || !data.theme) {
            setTheme('auto', themeConfig);
        }
    });

    // 初始化主题
    await initTheme();

    // 字体大小设置
    const fontSizeSelect = document.getElementById('font-size-select');

    // 初始化字体大小
    async function initFontSize() {
        try {
            const result = await syncStorageAdapter.get('fontSize');
            const fontSize = result.fontSize || 'medium';
            fontSizeSelect.value = fontSize;
            setFontSize(fontSize);
        } catch (error) {
            console.error('初始化字体大小失败:', error);
            setFontSize('medium');
        }
    }

    // 设置字体大小
    function setFontSize(size) {
        const root = document.documentElement;
        switch (size) {
            case 'small':
                root.style.setProperty('--cerebr-font-size', '12px');
                break;
            case 'medium':
                root.style.setProperty('--cerebr-font-size', '14px');
                break;
            case 'large':
                root.style.setProperty('--cerebr-font-size', '16px');
                break;
            case 'extra-large':
                root.style.setProperty('--cerebr-font-size', '18px');
                break;
            default:
                root.style.setProperty('--cerebr-font-size', '14px');
        }
    }

    // 监听字体大小变化
    fontSizeSelect.addEventListener('change', async () => {
        const fontSize = fontSizeSelect.value;
        setFontSize(fontSize);
        try {
            await syncStorageAdapter.set({ fontSize });
        } catch (error) {
            console.error('保存字体大小设置失败:', error);
        }
        
        // 通知父窗口字体大小已更改
        if (window.parent !== window) {
            window.parent.postMessage({
                type: 'FONT_SIZE_CHANGED',
                fontSize: fontSize
            }, '*');
        }
    });

    // 初始化字体大小
    await initFontSize();

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
        // 移除loadWebpageSwitch调用，新方案不再需要
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