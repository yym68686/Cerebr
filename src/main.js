import { setTheme } from './utils/theme.js';
import { callAPI } from './services/chat.js';
import { handleImageDrop } from './utils/image.js';
import { chatManager } from './utils/chat-manager.js';
import { appendMessage, updateAIMessage } from './handlers/message-handler.js';
import { renderAPICards, createCardCallbacks, selectCard } from './components/api-card/index.js';
import { adjustTextareaHeight, showImagePreview, hideImagePreview, createImageTag } from './utils/ui.js';
import { showContextMenu, hideContextMenu, copyMessageContent } from './components/context-menu/index.js';
import { storageAdapter, syncStorageAdapter, browserAdapter, isExtensionEnvironment } from './utils/storage-adapter.js';
import './utils/viewport.js';
import {
    hideChatList,
    initChatListEvents,
    loadChatContent,
    initializeChatList
} from './components/chat-list/index.js';

// 存储用户的问题历史
let userQuestions = [];

// 初始化历史消息
function initializeUserQuestions() {
    const userMessages = document.querySelectorAll('.user-message');
    userQuestions = Array.from(userMessages).map(msg => msg.textContent.trim());
    console.log('初始化历史问题:', userQuestions);
}

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
    let currentMessageElement = null;
    let currentCodeElement = null;
    let currentController = null;

    // 初始化历史消息
    initializeUserQuestions();

    // 监听聊天容器的变化，检测新的用户消息
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.classList && node.classList.contains('user-message')) {
                    const question = node.textContent.trim();
                    // 只有当问题不在历史记录中时才添加
                    if (question && !userQuestions.includes(question)) {
                        userQuestions.push(question);
                        console.log('保存新问题:', question);
                        console.log('当前问题历史:', userQuestions);
                    }
                }
            });
        });
    });

    // 开始观察聊天容器的变化
    observer.observe(chatContainer, { childList: true });

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

    // 添加点击次数跟踪变量
    let clickCount = 0;

    // 添加点击事件监听
    document.body.addEventListener('click', (e) => {
        // 如果有文本被选中，不要触发输入框聚焦
        if (window.getSelection().toString()) {
            return;
        }

        // 排除点击设置按钮、设置菜单、上下文菜单的情况
        if (!settingsButton.contains(e.target) &&
            !settingsMenu.contains(e.target) &&
            !contextMenu.contains(e.target)) {

            clickCount++;
            if (clickCount % 2 === 1) {
                // 奇数次点击，聚焦输入框
                messageInput.focus();
            } else {
                // 偶数次点击，取消聚焦
                messageInput.blur();
            }
        }
    });

    // 监听输入框的焦点状态
    messageInput.addEventListener('focus', () => {
        // 输入框获得焦点时隐藏右键菜单
        hideContextMenu({
            contextMenu,
            onMessageElementReset: () => { currentMessageElement = null; }
        });
        // 输入框获得焦点，阻止事件冒泡
        messageInput.addEventListener('click', (e) => e.stopPropagation());
    });

    messageInput.addEventListener('blur', () => {
        // 输入框失去焦点时，移除点击事件监听
        messageInput.removeEventListener('click', (e) => e.stopPropagation());
    });

    // 初始化ChatManager
    await chatManager.initialize();

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
    async function getPageContent() {
        try {
            // console.log('getPageContent 发送获取网页内容请求');
            const response = await browserAdapter.sendMessage({
                type: 'GET_PAGE_CONTENT_FROM_SIDEBAR'
            });
            return response;
        } catch (error) {
            console.error('获取网页内容失败:', error);
            return null;
        }
    }

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
    // 在 DOMContentLoaded 事件处理程序中添加加载网页问答状态
    await loadWebpageSwitch();

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

    // 添加一个锁变量和队列
    let isUpdating = false;
    const updateQueue = [];

    // 创建消息同步函数
    const syncMessage = async (updatedChatId, message) => {
        const currentChat = chatManager.getCurrentChat();
        // 只有当更新的消息属于当前显示的对话时才更新界面
        if (currentChat && currentChat.id === updatedChatId) {
            // 将更新任务添加到队列
            updateQueue.push(message);

            // 如果当前没有更新在进行，开始处理队列
            if (!isUpdating) {
                await processUpdateQueue();
            }
        }
    };

    // 处理更新队列的函数
    const processUpdateQueue = async () => {
        if (isUpdating || updateQueue.length === 0) return;

        try {
            isUpdating = true;
            while (updateQueue.length > 0) {
                const message = updateQueue.shift();
                await updateAIMessage({
                    text: message,
                    chatContainer
                });
            }
        } finally {
            isUpdating = false;
            // 检查是否在处理过程中有新的更新加入队列
            if (updateQueue.length > 0) {
                await processUpdateQueue();
            }
        }
    };

    async function sendMessage() {
        // 如果有正在更新的AI消息，停止它
        const updatingMessage = chatContainer.querySelector('.ai-message.updating');
        if (updatingMessage && currentController) {
            currentController.abort();
            currentController = null;
            updatingMessage.classList.remove('updating');
        }

        // 使用innerHTML获取内容，并将<br>转换为\n
        let message = messageInput.innerHTML
            .replace(/<div><br><\/div>/g, '\n')  // 处理换行后的空行
            .replace(/<div>/g, '\n')             // 处理换行后的新行开始
            .replace(/<\/div>/g, '')             // 处理换行后的新行结束
            .replace(/<br\s*\/?>/g, '\n')        // 处理单个换行
            .replace(/&nbsp;/g, ' ');            // 处理空格

        // 将HTML实体转换回实际字符
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = message;
        message = tempDiv.textContent;

        const imageTags = messageInput.querySelectorAll('.image-tag');

        if (!message.trim() && imageTags.length === 0) return;

        try {
            // 构建消息内容
            let content;
            if (imageTags.length > 0) {
                content = [];
                if (message.trim()) {
                    content.push({
                        type: "text",
                        text: message
                    });
                }
                imageTags.forEach(tag => {
                    const base64Data = tag.getAttribute('data-image');
                    if (base64Data) {
                        content.push({
                            type: "image_url",
                            image_url: {
                                url: base64Data
                            }
                        });
                    }
                });
            } else {
                content = message;
            }

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
            messageInput.innerHTML = '';
            adjustTextareaHeight({
                textarea: messageInput,
                config: uiConfig.textarea
            });

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
            const { processStream, controller } = await callAPI(apiParams, chatManager, currentChat.id, syncMessage);
            currentController = controller;

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

    // 监听来自 content script 的消息
    window.addEventListener('message', (event) => {
        if (event.data.type === 'DROP_IMAGE') {
            console.log('收到拖放图片数据');
            const imageData = event.data.imageData;
            if (imageData && imageData.data) {
                console.log('创建图片标签');
                // 确保base64数据格式正确
                const base64Data = imageData.data.startsWith('data:') ? imageData.data : `data:image/png;base64,${imageData.data}`;
                const imageTag = createImageTag({
                    base64Data: base64Data,
                    fileName: imageData.name
                });

                // 确保输入框有焦点
                messageInput.focus();

                // 获取或创建选区
                const selection = window.getSelection();
                let range;

                // 检查是否有现有选区
                if (selection.rangeCount > 0) {
                    range = selection.getRangeAt(0);
                } else {
                    // 创建新的选区
                    range = document.createRange();
                    // 将选区设置到输入框的末尾
                    range.selectNodeContents(messageInput);
                    range.collapse(false);
                    selection.removeAllRanges();
                    selection.addRange(range);
                }

                console.log('插入图片标签到输入框');
                // 插入图片标签
                range.deleteContents();
                range.insertNode(imageTag);

                // 移动光标到图片标签后面
                const newRange = document.createRange();
                newRange.setStartAfter(imageTag);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);

                // 触发输入事件以调整高度
                messageInput.dispatchEvent(new Event('input'));
                console.log('图片插入完成');
            }
        } else if (event.data.type === 'FOCUS_INPUT') {
            messageInput.focus();
            const range = document.createRange();
            range.selectNodeContents(messageInput);
            range.collapse(false);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        } else if (event.data.type === 'URL_CHANGED') {
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
        } else if (event.data.type === 'UPDATE_PLACEHOLDER') {
            // console.log('收到更新placeholder消息:', event.data);
            if (messageInput) {
                messageInput.setAttribute('placeholder', event.data.placeholder);
                if (event.data.timeout) {
                    setTimeout(() => {
                        messageInput.setAttribute('placeholder', '输入消息...');
                    }, event.data.timeout);
                }
            }
        } else if (event.data && event.data.type === 'CLEAR_CHAT_COMMAND') {
            console.log('收到清空聊天记录命令');
            const clearChatButton = document.querySelector('#clear-chat');
            if (clearChatButton) {
                clearChatButton.click();
            }
        } else if (event.data.type === 'NEW_CHAT') {
            // 模拟点击新对话按钮
            newChatButton.click();
        }
    });

    // 监听输入框变化
    messageInput.addEventListener('input', function() {
        adjustTextareaHeight({
            textarea: this,
            config: uiConfig.textarea
        });

        // 处理 placeholder 的显示
        if (this.textContent.trim() === '' && !this.querySelector('.image-tag')) {
            // 如果内容空且没有图片标签，清空内容以显示 placeholder
            while (this.firstChild) {
                this.removeChild(this.firstChild);
            }
        }
    });

    // 处理换行和输入
    let isComposing = false;  // 跟踪输入法状态

    messageInput.addEventListener('compositionstart', () => {
        isComposing = true;
    });

    messageInput.addEventListener('compositionend', () => {
        isComposing = false;
    });

    messageInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            if (isComposing) {
                // 如果正在使用输入法，不发送消息
                return;
            }
            e.preventDefault();
            const text = this.textContent.trim();
            if (text || this.querySelector('.image-tag')) {  // 检查是否有文本或图片
                sendMessage();
            }
        } else if (e.key === 'Escape') {
            // 按 ESC 键时让输入框失去焦点
            messageInput.blur();
        } else if (e.key === 'ArrowUp' && e.target.textContent.trim() === '') {
            // 处理输入框特定的键盘事件
            // 当按下向上键且输入框为空时
            e.preventDefault(); // 阻止默认行为

            // 如果有历史记录
            if (userQuestions.length > 0) {
                // 如果是第一次按向上键从最后一个问题开始
                e.target.textContent = userQuestions[userQuestions.length - 1];
                // 触发入事件以调整高度
                e.target.dispatchEvent(new Event('input', { bubbles: true }));
                // 移动光标到末尾
                const range = document.createRange();
                range.selectNodeContents(e.target);
                range.collapse(false);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
            }
        }
    });

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

    // 添加输入框的事件监听器
    messageInput.addEventListener('focus', () => {
        settingsMenu.classList.remove('visible');
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
            apiConfigs = result.apiConfigs || [{
                apiKey: '',
                baseUrl: 'https://api.openai.com/v1/chat/completions',
                modelName: 'gpt-4o'
            }];

            // 只有当 selectedConfigIndex 为 undefined 或 null 时才使用默认值 0
            selectedConfigIndex = result.selectedConfigIndex ?? 0;

            // 只有在没有任何配置的情况下才保存默认配置
            if (!result.apiConfigs) {
                await saveAPIConfigs();
            }
        } catch (error) {
            console.error('加载 API 配置失败:', error);
            // 只有在出错的情况下才使用默认值
            apiConfigs = [{
                apiKey: '',
                baseUrl: 'https://api.openai.com/v1/chat/completions',
                modelName: 'gpt-4o'
            }];
            selectedConfigIndex = 0;
        }

        // 确保一定会渲染卡片
        renderAPICardsWithCallbacks();
    }

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

    // 添加点击事件监听
    chatContainer.addEventListener('click', () => {
        // 击聊天区域时让输入框失去焦点
        messageInput.blur();
    });

    // 监听 AI 消息的右键点击
    chatContainer.addEventListener('contextmenu', (e) => {
        const messageElement = e.target.closest('.ai-message');
        const codeElement = e.target.closest('pre > code');

        if (messageElement) {
            currentMessageElement = messageElement;
            currentCodeElement = codeElement;

            // 获取菜单元素
            const copyMessageButton = document.getElementById('copy-message');
            const copyCodeButton = document.getElementById('copy-code');
            const copyMathButton = document.getElementById('copy-math');
            const stopUpdateButton = document.getElementById('stop-update');

            // 根据右键点击的元素类型显示/隐藏相应的菜单项
            copyMessageButton.style.display = 'flex';
            copyCodeButton.style.display = codeElement ? 'flex' : 'none';
            copyMathButton.style.display = 'none';  // 默认隐藏复制公式按钮
            stopUpdateButton.style.display = messageElement.classList.contains('updating') ? 'flex' : 'none';

            showContextMenu({
                event: e,
                messageElement,
                contextMenu,
                stopUpdateButton,
                onMessageElementSelect: (element) => {
                    currentMessageElement = element;
                }
            });
        }
    });

    // 添加长按触发右键菜单的支持
    let touchTimeout;
    let touchStartX;
    let touchStartY;
    const LONG_PRESS_DURATION = 200; // 长按触发时间为200ms

    chatContainer.addEventListener('touchstart', (e) => {
        const messageElement = e.target.closest('.ai-message');
        if (!messageElement) return;

        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;

        touchTimeout = setTimeout(() => {
            const codeElement = e.target.closest('pre > code');
            currentMessageElement = messageElement;
            currentCodeElement = codeElement;

            // 根据长按元素类型显示/隐藏相应的菜单项
            copyMessageButton.style.display = 'flex';
            copyCodeButton.style.display = codeElement ? 'flex' : 'none';

            showContextMenu({
                event: {
                    preventDefault: () => {},
                    clientX: touchStartX,
                    clientY: touchStartY
                },
                messageElement,
                contextMenu,
                stopUpdateButton,
                onMessageElementSelect: (element) => {
                    currentMessageElement = element;
                }
            });
        }, LONG_PRESS_DURATION);
    }, { passive: false });

    chatContainer.addEventListener('touchmove', (e) => {
        // 如果移动超过10px，取消长按
        if (touchTimeout &&
            (Math.abs(e.touches[0].clientX - touchStartX) > 10 ||
             Math.abs(e.touches[0].clientY - touchStartY) > 10)) {
            clearTimeout(touchTimeout);
            touchTimeout = null;
        }
    }, { passive: true });

    chatContainer.addEventListener('touchend', () => {
        if (touchTimeout) {
            clearTimeout(touchTimeout);
            touchTimeout = null;
        }
        // 如果用户没有触发长按（即正常的触摸结束），则隐藏菜单
        if (!contextMenu.style.display || contextMenu.style.display === 'none') {
            hideContextMenu({
                contextMenu,
                onMessageElementReset: () => { currentMessageElement = null; }
            });
        }
    });

    document.addEventListener('contextmenu', (event) => {
        // 检查是否点击了 MathJax 3 的任何元素
        const isMathElement = (element) => {
            const isMjx = element.tagName && element.tagName.toLowerCase().startsWith('mjx-');
            const hasContainer = element.closest('mjx-container') !== null;
            return isMjx || hasContainer;
        };

        if (isMathElement(event.target)) {
            event.preventDefault();
            event.stopPropagation();

            // 获取最外层的 mjx-container
            const container = event.target.closest('mjx-container');

            if (container) {
                const mathContextMenu = document.getElementById('copy-math');
                const copyMessageButton = document.getElementById('copy-message');
                const copyCodeButton = document.getElementById('copy-code');
                const stopUpdateButton = document.getElementById('stop-update');

                if (mathContextMenu) {
                    // 设置菜单项的显示状态
                    mathContextMenu.style.display = 'flex';
                    copyMessageButton.style.display = 'flex';  // 显示复制消息按钮
                    copyCodeButton.style.display = 'none';
                    stopUpdateButton.style.display = 'none';

                    // 获取包含公式的 AI 消息元素
                    const aiMessage = container.closest('.ai-message');
                    currentMessageElement = aiMessage;  // 设置当前消息元素为 AI 消息

                    // 调用 showContextMenu 函数
                    showContextMenu({
                        event,
                        messageElement: aiMessage,  // 使用 AI 消息元素
                        contextMenu,
                        stopUpdateButton
                    });

                    // 设置数学公式内容
                    const assistiveMml = container.querySelector('mjx-assistive-mml');
                    let mathContent;

                    // 获取原始的 LaTeX 源码
                    const mjxTexElement = container.querySelector('script[type="math/tex; mode=display"]') ||
                                        container.querySelector('script[type="math/tex"]');

                    if (mjxTexElement) {
                        mathContent = mjxTexElement.textContent;
                    } else {
                        // 如果找不到原始 LaTeX，尝试从 MathJax 内部存储获取
                        const mjxInternal = container.querySelector('mjx-math');
                        if (mjxInternal) {
                            const texAttr = mjxInternal.getAttribute('aria-label');
                            if (texAttr) {
                                // 移除 "TeX:" 前缀（如果有的话）
                                mathContent = texAttr.replace(/^TeX:\s*/, '');
                            }
                        }
                    }

                    // 如果还是没有找到，尝试其他方法
                    if (!mathContent) {
                        if (assistiveMml) {
                            const texAttr = assistiveMml.getAttribute('aria-label');
                            if (texAttr) {
                                mathContent = texAttr.replace(/^TeX:\s*/, '');
                            }
                        }
                    }

                    mathContextMenu.dataset.mathContent = mathContent || container.textContent;
                }
            }
        }
    }, { capture: true, passive: false });

    // 复制数学公式
    document.getElementById('copy-math')?.addEventListener('click', async () => {
        try {
            // 获取数学公式内容
            const mathContent = document.getElementById('copy-math').dataset.mathContent;

            if (mathContent) {
                await navigator.clipboard.writeText(mathContent);
                console.log('数学公式已复制:', mathContent);

                // 隐藏上下文菜单
                hideContextMenu({
                    contextMenu,
                    onMessageElementReset: () => {
                        currentMessageElement = null;
                    }
                });
            } else {
                console.error('没有找到可复制的数学公式内容');
            }
        } catch (err) {
            console.error('复制公式失败:', err);
        }
    });

    // 点击复制按钮
    copyMessageButton.addEventListener('click', () => {
        copyMessageContent({
            messageElement: currentMessageElement,
            onSuccess: () => hideContextMenu({
                contextMenu,
                onMessageElementReset: () => {
                    currentMessageElement = null;
                    currentCodeElement = null;
                }
            }),
            onError: (err) => console.error('复制失败:', err)
        });
    });

    // 点击复制代码按钮
    copyCodeButton.addEventListener('click', () => {
        if (currentCodeElement) {
            const codeText = currentCodeElement.textContent;
            navigator.clipboard.writeText(codeText)
                .then(() => {
                    hideContextMenu({
                        contextMenu,
                        onMessageElementReset: () => {
                            currentMessageElement = null;
                            currentCodeElement = null;
                        }
                    });
                })
                .catch(err => console.error('复制代码失败:', err));
        }
    });

    // 点击其他地方隐藏菜单
    document.addEventListener('click', (e) => {
        if (!contextMenu.contains(e.target)) {
            hideContextMenu({
                contextMenu,
                onMessageElementReset: () => { currentMessageElement = null; }
            });
        }
    });

    // 触摸其他地方隐藏菜单
    document.addEventListener('touchstart', (e) => {
        if (!contextMenu.contains(e.target)) {
            hideContextMenu({
                contextMenu,
                onMessageElementReset: () => { currentMessageElement = null; }
            });
        }
    });

    // 滚动时隐藏菜单
    chatContainer.addEventListener('scroll', () => {
        hideContextMenu({
            contextMenu,
            onMessageElementReset: () => { currentMessageElement = null; }
        });
    });

    // 按下 Esc 键隐藏菜单
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hideContextMenu({
                contextMenu,
                onMessageElementReset: () => { currentMessageElement = null; }
            });
        }
    });

    // 片粘贴功能
    messageInput.addEventListener('paste', async (e) => {
        e.preventDefault(); // 阻止默认粘贴行为

        const items = Array.from(e.clipboardData.items);
        const imageItem = items.find(item => item.type.startsWith('image/'));

        if (imageItem) {
            // 处理图片粘贴
            const file = imageItem.getAsFile();
            const reader = new FileReader();

            reader.onload = async () => {
                const base64Data = reader.result;
                const imageTag = createImageTag({
                    base64Data,
                    fileName: file.name,
                    config: uiConfig.imageTag
                });

                // 在光标位置插入图片标签
                const selection = window.getSelection();
                const range = selection.getRangeAt(0);
                range.deleteContents();
                range.insertNode(imageTag);

                // 移动光标到图片标签后面，并确保不会插入额外的换行
                const newRange = document.createRange();
                newRange.setStartAfter(imageTag);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);

                // 移除可能存在的多余行
                const brElements = messageInput.getElementsByTagName('br');
                Array.from(brElements).forEach(br => {
                    if (br.previousSibling && br.previousSibling.classList && br.previousSibling.classList.contains('image-tag')) {
                        br.remove();
                    }
                });

                // 触发输入事件以调整高度
                messageInput.dispatchEvent(new Event('input'));
            };

            reader.readAsDataURL(file);
        } else {
            // 处理文本粘贴
            const text = e.clipboardData.getData('text/plain');
            document.execCommand('insertText', false, text);
        }
    });

    // 处理图片标签的删除
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' || e.key === 'Delete') {
            const selection = window.getSelection();
            const range = selection.getRangeAt(0);
            const startContainer = range.startContainer;

            // 检查是否在图片标签旁边
            if (startContainer.nodeType === Node.TEXT_NODE && startContainer.textContent === '') {
                const previousSibling = startContainer.previousSibling;
                if (previousSibling && previousSibling.classList?.contains('image-tag')) {
                    e.preventDefault();
                    previousSibling.remove();

                    // 移除可能存在的多余换行
                    const brElements = messageInput.getElementsByTagName('br');
                    Array.from(brElements).forEach(br => {
                        if (!br.nextSibling || (br.nextSibling.nodeType === Node.TEXT_NODE && br.nextSibling.textContent.trim() === '')) {
                            br.remove();
                        }
                    });

                    // 触发输入事件以调整高度
                    messageInput.dispatchEvent(new Event('input'));
                }
            }
        }
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

    // 为输入框添加拖放事件监听器
    messageInput.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    messageInput.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    messageInput.addEventListener('drop', (e) => {
        handleImageDrop(e, {
            messageInput,
            createImageTag,
            onSuccess: () => {
                // 可以在这里添加成功处理的回调
            },
            onError: (error) => {
                console.error('处理拖放事件失败:', error);
            }
        });
    });

    // 为聊天区域添加拖放事件监听器
    chatContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    chatContainer.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    chatContainer.addEventListener('drop', (e) => {
        handleImageDrop(e, {
            messageInput,
            createImageTag,
            onSuccess: () => {
                // 可以在这里添加成功处理的回调
            },
            onError: (error) => {
                console.error('处理拖放事件失败:', error);
            }
        });
    });

    // 阻止聊天区域的图片默认行为
    chatContainer.addEventListener('click', (e) => {
        if (e.target.tagName === 'IMG') {
            e.preventDefault();
            e.stopPropagation();
        }
    });

    // 添加停止更新按钮的点击事件处理
    stopUpdateButton.addEventListener('click', () => {
        if (currentController) {
            currentController.abort();  // 中止当前请求
            currentController = null;
            hideContextMenu({
                contextMenu,
                onMessageElementReset: () => { currentMessageElement = null; }
            });
        }
    });
});