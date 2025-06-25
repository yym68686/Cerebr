import { setTheme } from './utils/theme.js';
import { callAPI } from './services/chat.js';
import { generateTitleForChat } from './services/title-generator.js';
import { analyzeTabRelevance, getRelevantTabsContent, formatMultiPageContext } from './services/tab-relevance.js';
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

// 编辑状态
let editingState = {
    isEditing: false,
    messageIndex: -1
};

document.addEventListener('DOMContentLoaded', async () => {
    const chatContainer = document.getElementById('chat-container');
    const messageInput = document.getElementById('message-input');
    const contextMenu = document.getElementById('context-menu');
    const copyMessageButton = document.getElementById('copy-message');
    const copyCodeButton = document.getElementById('copy-code');
    const editMessageButton = document.getElementById('edit-message');
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
        editMessageButton,
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
            const response = await browserAdapter.sendMessage({
                type: 'GET_PAGE_CONTENT_FROM_SIDEBAR',
                skipWaitContent: skipWaitContent,
                tabId: tabId
            });
            return response;
        } catch (error) {
            console.error('获取网页内容失败:', error);
            return null;
        }
    }

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

    // 相关标签页功能状态
    let relatedTabsEnabled = false;
    let relatedTabsData = [];
    let selectedRelatedTabs = [];

    // 加载相关标签页设置
    async function loadRelatedTabsSettings() {
        try {
            const settings = await storageAdapter.get('relatedTabsSettings');
            if (settings.relatedTabsSettings) {
                relatedTabsEnabled = settings.relatedTabsSettings.enabled || false;
                selectedRelatedTabs = settings.relatedTabsSettings.selectedTabs || [];
                updateRelatedTabsButton(relatedTabsEnabled, selectedRelatedTabs.length);
            } else {
                // 默认状态：灰色，未启用
                updateRelatedTabsButton(false, 0);
            }
        } catch (error) {
            console.error('加载相关标签页设置失败:', error);
            updateRelatedTabsButton(false, 0);
        }
    }

    // 保存相关标签页设置
    async function saveRelatedTabsSettings() {
        try {
            await storageAdapter.set({
                relatedTabsSettings: {
                    enabled: relatedTabsEnabled,
                    selectedTabs: selectedRelatedTabs,
                    lastUpdated: Date.now()
                }
            });
        } catch (error) {
            console.error('保存相关标签页设置失败:', error);
        }
    }

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
            if (!domain) {
                return;
            }
    
            const isAutoTrigger = event.isTrusted && webpageQAEnabled === false;
            const newState = isAutoTrigger ? true : !webpageQAEnabled;
    
            if (newState) {
                webpageQAButton.classList.add('loading');
                document.body.classList.add('loading-content');
    
                try {
                    const content = await getPageContent(false, tabId);
                    if (content && !content.error) {
                        pageContent = content;
                        updateWebpageQAButton(true);
                    } else if (content && content.error) {
                        console.error('获取网页内容失败：', content.error, content.details || '');
                    }
                } catch (error) {
                    console.error('获取网页内容失败:', error.message || error);
                } finally {
                    webpageQAButton.classList.remove('loading');
                    document.body.classList.remove('loading-content');
                }
            } else {
                pageContent = null;
                updateWebpageQAButton(false);
            }
        } catch (error) {
            console.error('处理网页问答按钮点击失败:', error);
            webpageQAButton.classList.remove('loading');
        }
    });

    // 初始化按钮状态为关闭
    updateWebpageQAButton(false);

    // 相关标签页按钮和模态框元素
    const relatedTabsButton = document.getElementById('related-tabs-button');
    const relatedTabsModal = document.getElementById('related-tabs-modal');
    const relatedTabsClose = document.querySelector('.related-tabs-close');
    const relatedTabsConfirm = document.getElementById('related-tabs-confirm');
    const relatedTabsCancel = document.getElementById('related-tabs-cancel');
    const relatedTabsCount = document.getElementById('related-tabs-count');
    const selectedTabsCount = document.getElementById('selected-tabs-count');
    const selectAllTabsBtn = document.getElementById('select-all-tabs');
    const deselectAllTabsBtn = document.getElementById('deselect-all-tabs');
    const relatedTabsControls = document.getElementById('related-tabs-controls');

    // 获取所有标签页信息
    async function getAllTabs() {
        try {
            const response = await browserAdapter.sendMessage({
                type: 'getAllTabs'
            });
            return response?.tabs || [];
        } catch (error) {
            console.error('获取所有标签页失败:', error);
            return [];
        }
    }

    // 更新相关标签页按钮状态
    function updateRelatedTabsButton(enabled, count = 0) {
        relatedTabsEnabled = enabled;

        // 移除加载状态
        relatedTabsButton.classList.remove('loading');

        if (enabled && count > 0) {
            relatedTabsButton.classList.remove('related-tabs-off');
            relatedTabsButton.classList.add('related-tabs-on');
            relatedTabsCount.textContent = count;
            relatedTabsCount.style.display = 'flex';
        } else {
            relatedTabsButton.classList.remove('related-tabs-on');
            relatedTabsButton.classList.add('related-tabs-off');
            relatedTabsCount.style.display = 'none';
        }
    }

    // 设置按钮加载状态
    function setRelatedTabsButtonLoading(loading) {
        if (loading) {
            relatedTabsButton.classList.add('loading');
        } else {
            relatedTabsButton.classList.remove('loading');
        }
    }

    // 显示相关标签页模态框
    function showRelatedTabsModal() {
        relatedTabsModal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }

    // 隐藏相关标签页模态框
    function hideRelatedTabsModal() {
        relatedTabsModal.style.display = 'none';
        document.body.style.overflow = '';
    }

    // 初始化相关标签页按钮状态（默认灰色）
    updateRelatedTabsButton(false, 0);

    // 加载相关标签页设置
    await loadRelatedTabsSettings();

    // 相关标签页按钮点击事件
    relatedTabsButton.addEventListener('click', async () => {
        if (!webpageQAEnabled) {
            // 如果网页问答未启用，自动启用
            console.log('自动启用网页问答功能');

            // 创建一个Promise来等待网页问答启用完成
            const waitForWebpageQA = new Promise((resolve, reject) => {
                let attempts = 0;
                const maxAttempts = 20; // 最多等待10秒

                const checkStatus = () => {
                    attempts++;
                    if (webpageQAEnabled) {
                        resolve();
                    } else if (attempts >= maxAttempts) {
                        reject(new Error('网页问答启用超时'));
                    } else {
                        setTimeout(checkStatus, 500);
                    }
                };

                // 触发网页问答按钮点击
                webpageQAButton.click();

                // 开始检查状态
                setTimeout(checkStatus, 100);
            });

            try {
                await waitForWebpageQA;
                console.log('网页问答功能已启用');
            } catch (error) {
                console.error('启用网页问答失败:', error);
                alert('无法启用网页问答功能，请检查当前页面或手动启用');
                return;
            }
        }

        try {
            // 开始加载状态
            setRelatedTabsButtonLoading(true);

            // 获取当前页面信息
            const { domain, tabId } = await getCurrentDomain();
            if (!domain) {
                alert('无法获取当前页面信息');
                return;
            }

            // 获取所有标签页
            const allTabs = await getAllTabs();
            if (allTabs.length <= 1) {
                alert('当前只有一个标签页，无法分析相关性');
                return;
            }

            // 获取当前页面内容以获取标题
            const currentContent = await getPageContent(true, tabId);
            if (!currentContent || currentContent.error) {
                alert('无法获取当前页面内容');
                return;
            }

            showRelatedTabsModal();

            // 显示加载状态
            document.getElementById('related-tabs-loading').style.display = 'flex';
            document.getElementById('related-tabs-list').style.display = 'none';
            document.getElementById('related-tabs-empty').style.display = 'none';
            relatedTabsControls.style.display = 'none';

            // 分析相关性
            const relevantTabs = await analyzeTabRelevance(
                currentContent.title,
                allTabs,
                apiConfigs[selectedConfigIndex]
            );

            // 隐藏加载状态
            document.getElementById('related-tabs-loading').style.display = 'none';

            if (relevantTabs.length > 0) {
                relatedTabsData = relevantTabs;
                renderRelatedTabsList(relevantTabs, allTabs);
                document.getElementById('related-tabs-list').style.display = 'block';
                relatedTabsControls.style.display = 'flex';
            } else {
                document.getElementById('related-tabs-empty').style.display = 'block';
                relatedTabsControls.style.display = 'none';
            }

        } catch (error) {
            console.error('分析相关标签页失败:', error);
            alert('分析相关标签页失败，请重试');
            hideRelatedTabsModal();
        } finally {
            setRelatedTabsButtonLoading(false);
        }
    });

    // 渲染相关标签页列表
    function renderRelatedTabsList(relevantTabs, allTabs) {
        const listContainer = document.getElementById('related-tabs-list');
        listContainer.innerHTML = '';

        // 如果没有预选的标签页，清空选择
        if (!selectedRelatedTabs || selectedRelatedTabs.length === 0) {
            selectedRelatedTabs = [];
        }

        relevantTabs.forEach(tabInfo => {
            const tab = allTabs.find(t => t.id === tabInfo.id);
            if (!tab) return;

            // 检查这个标签页是否之前被选中过
            const isSelected = selectedRelatedTabs.some(selectedTab => selectedTab.id === tab.id);

            const item = document.createElement('div');
            item.className = 'related-tab-item';
            if (isSelected) {
                item.classList.add('selected');
            }

            item.innerHTML = `
                <input type="checkbox" class="related-tab-checkbox" data-tab-id="${tab.id}" ${isSelected ? 'checked' : ''}>
                <div class="related-tab-info">
                    <div class="related-tab-title">${tab.title}</div>
                    <div class="related-tab-url">${tab.url}</div>
                    <div class="related-tab-reason">${tabInfo.reason}</div>
                    <div class="related-tab-score">相关性: ${Math.round(tabInfo.relevance_score * 100)}%</div>
                </div>
            `;

            // 点击整个项目来切换选择状态
            item.addEventListener('click', (e) => {
                if (e.target.type !== 'checkbox') {
                    const checkbox = item.querySelector('.related-tab-checkbox');
                    checkbox.checked = !checkbox.checked;
                    checkbox.dispatchEvent(new Event('change'));
                }
            });

            // 复选框变化事件
            const checkbox = item.querySelector('.related-tab-checkbox');
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    item.classList.add('selected');
                    selectedRelatedTabs.push(tabInfo);
                } else {
                    item.classList.remove('selected');
                    selectedRelatedTabs = selectedRelatedTabs.filter(t => t.id !== tabInfo.id);
                }
                updateConfirmButton();
            });

            listContainer.appendChild(item);
        });
    }

    // 更新确认按钮状态
    function updateConfirmButton() {
        const count = selectedRelatedTabs.length;
        selectedTabsCount.textContent = count;
        relatedTabsConfirm.disabled = count === 0;
    }

    // 模态框事件处理
    relatedTabsClose.addEventListener('click', hideRelatedTabsModal);
    relatedTabsCancel.addEventListener('click', hideRelatedTabsModal);

    relatedTabsConfirm.addEventListener('click', async () => {
        // 无论是否选择了标签页，都要更新状态
        if (selectedRelatedTabs.length > 0) {
            // 有选择：按钮变蓝色，显示数量
            updateRelatedTabsButton(true, selectedRelatedTabs.length);
        } else {
            // 无选择：按钮保持灰色
            updateRelatedTabsButton(false, 0);
        }

        await saveRelatedTabsSettings();
        hideRelatedTabsModal();
    });

    // 全选按钮事件
    selectAllTabsBtn.addEventListener('click', () => {
        const checkboxes = document.querySelectorAll('.related-tab-checkbox');
        checkboxes.forEach(checkbox => {
            if (!checkbox.checked) {
                checkbox.checked = true;
                checkbox.dispatchEvent(new Event('change'));
            }
        });
    });

    // 取消全选按钮事件
    deselectAllTabsBtn.addEventListener('click', () => {
        const checkboxes = document.querySelectorAll('.related-tab-checkbox');
        checkboxes.forEach(checkbox => {
            if (checkbox.checked) {
                checkbox.checked = false;
                checkbox.dispatchEvent(new Event('change'));
            }
        });
    });

    // 点击模态框背景关闭
    relatedTabsModal.addEventListener('click', (e) => {
        if (e.target === relatedTabsModal) {
            hideRelatedTabsModal();
        }
    });

    // 监听来自 content script 的消息
    window.addEventListener('message', (event) => {
        handleWindowMessage(event, {
            messageInput,
            newChatButton,
            uiConfig
        });

        if (event.data.type === 'URL_CHANGED') {
            if (webpageQAEnabled) {
                pageContent = null;
                updateWebpageQAButton(false);
            }
            if (relatedTabsEnabled) {
                selectedRelatedTabs = [];
                relatedTabsData = [];
                updateRelatedTabsButton(false);
            }
        }
    });

    // 函数：开始编辑
    window.startEditing = (messageIndex, messageText) => {
        editingState = {
            isEditing: true,
            messageIndex: messageIndex
        };
        messageInput.textContent = messageText;
        messageInput.focus();
        const range = document.createRange();
        range.selectNodeContents(messageInput);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    };

    async function sendMessage() {
        let currentChat = null;
        if (editingState.isEditing) {
            await chatManager.truncateMessages(editingState.messageIndex);

            const messages = Array.from(chatContainer.children);
            for (let i = messages.length - 1; i >= editingState.messageIndex; i--) {
                messages[i].remove();
            }

            editingState = {
                isEditing: false,
                messageIndex: -1
            };
        }

        if (chatContainer.querySelector('.ai-message.updating') && currentController) {
            currentController.abort();
            currentController = null;
            abortControllerRef.current = null;
            chatContainer.querySelector('.ai-message.updating').classList.remove('updating');
        }

        const { message, imageTags } = getFormattedMessageContent(messageInput);
        if (!message.trim() && imageTags.length === 0) return;

        try {
            if (webpageQAEnabled) {
                try {
                    const { tabId } = await getCurrentDomain();
                    const content = await getPageContent(true, tabId);
                    if (content && !content.error) {
                        // 如果启用了相关标签页功能且有选中的相关标签页
                        if (relatedTabsEnabled && selectedRelatedTabs.length > 0) {
                            console.log('获取相关标签页内容...');
                            const relatedContents = await getRelevantTabsContent(selectedRelatedTabs, getPageContent);
                            pageContent = formatMultiPageContext(content, relatedContents);
                            console.log('多页面内容聚合完成，相关页面数量:', relatedContents.length);
                        } else {
                            pageContent = content;
                        }
                    }
                } catch (error) {
                    console.error('发送消息时获取页面内容失败:', error.message || error);
                }
            }

            const content = buildMessageContent(message, imageTags);
            const userMessage = { role: "user", content: content };

            appendMessage({
                text: userMessage,
                sender: 'user',
                chatContainer,
            });

            clearMessageInput(messageInput, uiConfig);

            currentChat = chatManager.getCurrentChat();
            const isFirstMessage = currentChat && currentChat.messages.length === 0;
            const messages = currentChat ? [...currentChat.messages] : [];
            messages.push(userMessage);
            chatManager.addMessageToCurrentChat(userMessage);

            if (isFirstMessage) {
                const tabInfo = await browserAdapter.getCurrentTab();
                if (tabInfo) {
                    chatManager.setChatSource(currentChat.id, tabInfo.title, tabInfo.url);
                }
            }

            const apiParams = {
                messages,
                apiConfig: apiConfigs[selectedConfigIndex],
                userLanguage: navigator.language,
                webpageInfo: webpageQAEnabled ? pageContent : null
            };

            const { processStream, controller } = await callAPI(apiParams, chatManager, currentChat.id, chatContainerManager.syncMessage);
            currentController = controller;
            abortControllerRef.current = controller;

            await processStream();
            
            const lastAiMessage = chatContainer.querySelector('.ai-message:last-child');
            if (lastAiMessage) {
                // 自动折叠所有推理内容（包括reasoning_content和<think>标签生成的）
                const reasoningDivs = lastAiMessage.querySelectorAll('.reasoning-content');
                reasoningDivs.forEach(reasoningDiv => {
                    if (!reasoningDiv.classList.contains('collapsed')) {
                        reasoningDiv.classList.add('collapsed');
                    }
                });
            }

            // 检查是否是首轮对话完成，如果是则生成标题
            currentChat = chatManager.getCurrentChat();
            if (currentChat && currentChat.messages.length === 2) {
                // 不等待标题生成，让其在后台运行
                generateTitleForChat(currentChat.messages, apiConfigs[selectedConfigIndex]).then(newTitle => {
                    if (newTitle) {
                        chatManager.updateChatTitle(currentChat.id, newTitle);
                    }
                });
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
            currentChat = chatManager.getCurrentChat();
            if (currentChat && currentChat.messages.length > 0) {
                if (currentChat.messages[currentChat.messages.length - 1].role === 'assistant') {
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

    document.addEventListener('click', (e) => {
        if (!settingsButton.contains(e.target) && !settingsMenu.contains(e.target)) {
            settingsMenu.classList.remove('visible');
        }
    });

    settingsButton.addEventListener('click', (e) => {
        e.stopPropagation();
        settingsMenu.classList.toggle('visible');
    });

    const themeSelect = document.getElementById('theme-select');
    const themeConfig = {
        root: document.documentElement,
        themeSelect,
        saveTheme: async (theme) => await syncStorageAdapter.set({ theme })
    };

    async function initTheme() {
        try {
            const result = await syncStorageAdapter.get('theme');
            const themeMode = result.theme || 'auto';
            setTheme(themeMode, themeConfig);
        } catch (error) {
            console.error('初始化主题失败:', error);
            setTheme('auto', themeConfig);
        }
    }

    themeSelect.addEventListener('change', () => {
        setTheme(themeSelect.value, themeConfig);
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => {
        const data = await syncStorageAdapter.get('theme');
        if (data.theme === 'auto' || !data.theme) {
            setTheme('auto', themeConfig);
        }
    });

    await initTheme();

    const fontSizeSelect = document.getElementById('font-size-select');

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

    fontSizeSelect.addEventListener('change', async () => {
        const fontSize = fontSizeSelect.value;
        setFontSize(fontSize);
        try {
            await syncStorageAdapter.set({ fontSize });
        } catch (error) {
            console.error('保存字体大小设置失败:', error);
        }
        
        if (window.parent !== window) {
            window.parent.postMessage({
                type: 'FONT_SIZE_CHANGED',
                fontSize: fontSize
            }, '*');
        }
    });

    await initFontSize();

    const apiSettingsToggle = document.getElementById('api-settings-toggle');
    const backButton = document.querySelector('#api-settings .back-button');
    const apiCards = document.querySelector('.api-cards');

    let apiConfigs = [];
    let selectedConfigIndex = 0;

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
                apiSettings.classList.remove('visible');
            }
        });
    };

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

    async function loadAPIConfigs() {
        try {
            const result = await syncStorageAdapter.get(['apiConfigs', 'selectedConfigIndex']);
            apiConfigs = result.apiConfigs || [{
                apiKey: '',
                baseUrl: 'https://api.openai.com/v1/chat/completions',
                modelName: 'gpt-4o'
            }];
            selectedConfigIndex = result.selectedConfigIndex ?? 0;
            if (!result.apiConfigs) {
                await saveAPIConfigs();
            }
            renderAPICardsWithCallbacks();
        } catch (error) {
            console.error('加载 API 配置失败:', error);
            apiConfigs = [{
                apiKey: '',
                baseUrl: 'https://api.openai.com/v1/chat/completions',
                modelName: 'gpt-4o'
            }];
            selectedConfigIndex = 0;
            renderAPICardsWithCallbacks();
        }
    }

    browserAdapter.onTabActivated(async () => {
        await loadAPIConfigs();
        renderAPICardsWithCallbacks();
        await chatManager.initialize();
        await renderChatList(
            chatManager,
            chatListPage.querySelector('.chat-cards')
        );
    });

    async function saveAPIConfigs() {
        try {
            await syncStorageAdapter.set({
                apiConfigs,
                selectedConfigIndex
            });
        } catch (error) {
            console.error('保存 API 配置失败:', error);
        }
    }

    await loadAPIConfigs();

    apiSettingsToggle.addEventListener('click', () => {
        apiSettings.classList.add('visible');
        settingsMenu.classList.remove('visible');
        renderAPICardsWithCallbacks();
    });

    backButton.addEventListener('click', () => {
        apiSettings.classList.remove('visible');
    });

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