import { appendMessage } from '../handlers/message-handler.js';
import { storageAdapter, browserAdapter, isExtensionEnvironment } from '../utils/storage-adapter.js';
import { t } from '../utils/i18n.js';
import { setWebpageSwitchesForChat } from '../utils/webpage-switches.js';

let renderToken = 0;
let chatContentToken = 0;

function scheduleWork(callback) {
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(callback, { timeout: 1000 });
    } else {
        requestAnimationFrame(() => callback({ timeRemaining: () => 0, didTimeout: true }));
    }
}

function createChatSwitchPlaceholder() {
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-switch-placeholder';
    wrapper.innerHTML = `
        <div class="chat-switch-spinner" aria-hidden="true"></div>
        <div class="chat-switch-text">${t('chat_switch_loading')}</div>
    `;
    return wrapper;
}

export function renderChatListIncremental(chatManager, chatCards, searchTerm = '') {
    const template = chatCards.querySelector('.chat-card.template');
    if (!template) return;

    const lowerCaseSearchTerm = searchTerm.toLowerCase();
    const currentChatId = chatManager.getCurrentChat()?.id;
    const allChats = chatManager.getAllChats();

    const filteredChats = allChats.filter(chat => {
        if (!searchTerm) return true;
        const titleMatch = chat.title.toLowerCase().includes(lowerCaseSearchTerm);
        const contentMatch = chat.messages.some(message =>
            message.content &&
            (
                (typeof message.content === 'string' && message.content.toLowerCase().includes(lowerCaseSearchTerm)) ||
                (Array.isArray(message.content) && message.content.some(part => part.type === 'text' && part.text.toLowerCase().includes(lowerCaseSearchTerm)))
            )
        );
        return titleMatch || contentMatch;
    });

    const myToken = ++renderToken;
    let index = 0;

    // 先清空（只保留模板），避免一次性 replaceChildren 大量节点导致长任务
    chatCards.replaceChildren(template);

    if (filteredChats.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'chat-list-empty-state';
        empty.textContent = searchTerm ? t('chat_list_no_match') : t('chat_list_empty');
        chatCards.appendChild(empty);
        return;
    }

    const renderChunk = (deadline) => {
        if (myToken !== renderToken) return;

        const fragment = document.createDocumentFragment();
        const shouldContinue = () => {
            if (!deadline || typeof deadline.timeRemaining !== 'function') return false;
            return deadline.didTimeout || deadline.timeRemaining() > 8;
        };

        // 至少渲染少量条目，避免空白；同时严格限制每次渲染数量，防止单次长任务
        const minPerChunk = 12;
        const maxPerChunk = 25;
        let rendered = 0;
        while (index < filteredChats.length && rendered < maxPerChunk && (rendered < minPerChunk || shouldContinue())) {
            const chat = filteredChats[index++];
            const card = template.cloneNode(true);
            card.classList.remove('template');
            card.style.display = '';
            card.dataset.chatId = chat.id;

            const titleElement = card.querySelector('.chat-title');
            titleElement.textContent = chat.title;

            if (chat.id === currentChatId) {
                card.classList.add('selected');
            } else {
                card.classList.remove('selected');
            }

            fragment.appendChild(card);
            rendered++;
        }

        chatCards.appendChild(fragment);

        if (index < filteredChats.length) {
            scheduleWork(renderChunk);
        }
    };

    scheduleWork(renderChunk);
}

// 加载对话内容
export async function loadChatContent(chat, chatContainer) {
    chatContainer.innerHTML = '';
    // 确定要遍历的消息范围
    const messages = chat.messages;

    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        if (message.content) {
            await appendMessage({
                text: message,
                sender: message.role === 'user' ? 'user' : 'ai',
                chatContainer,
                skipHistory: true,
            });
        }
    }
}

async function loadChatContentIncremental(chat, chatContainer, token) {
    chatContainer.replaceChildren(createChatSwitchPlaceholder());
    const messages = chat.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
        chatContainer.innerHTML = '';
        document.dispatchEvent(new CustomEvent('cerebr:chatContentChunk', { detail: { chatId: chat.id, done: true, rendered: 0 } }));
        document.dispatchEvent(new CustomEvent('cerebr:chatContentLoaded', { detail: { chatId: chat.id } }));
        return;
    }

    let index = 0;
    const myToken = token;
    let hasRenderedAny = false;

    const renderChunk = async (deadline) => {
        if (myToken !== chatContentToken) return;

        const fragment = document.createDocumentFragment();
        const nodes = [];

        const shouldContinue = () => {
            if (!deadline || typeof deadline.timeRemaining !== 'function') return false;
            return deadline.didTimeout || deadline.timeRemaining() > 8;
        };

        const minPerChunk = 6;
        const maxPerChunk = 14;
        let rendered = 0;

        while (index < messages.length &&
            rendered < maxPerChunk &&
            (rendered < minPerChunk || shouldContinue())) {
            if (myToken !== chatContentToken) return;

            const message = messages[index++];
            if (!message?.content) continue;

            const element = await appendMessage({
                text: message,
                sender: message.role === 'user' ? 'user' : 'ai',
                chatContainer,
                skipHistory: true,
                fragment
            });
            nodes.push(element);
            rendered++;
        }

        if (myToken !== chatContentToken) return;
        if (!hasRenderedAny) {
            chatContainer.replaceChildren(fragment);
            hasRenderedAny = true;
        } else {
            chatContainer.appendChild(fragment);
        }
        requestAnimationFrame(() => {
            nodes.forEach((el) => el?.classList?.add('show'));
        });

        document.dispatchEvent(new CustomEvent('cerebr:chatContentChunk', { detail: { chatId: chat.id, done: index >= messages.length, rendered: index } }));

        if (index < messages.length) {
            scheduleWork(renderChunk);
            return;
        }

        document.dispatchEvent(new CustomEvent('cerebr:chatContentLoaded', { detail: { chatId: chat.id } }));
    };

    scheduleWork(renderChunk);
}

// 切换到指定对话
export function switchToChat(chatId, chatManager) {
    // Optimistically switch current chat immediately; persist to storage in background.
    void chatManager.switchChat(chatId).catch((err) => console.error('切换对话失败:', err));
    const chat = chatManager.getCurrentChat();
    if (chat) {
        const token = ++chatContentToken;
        const chatContainer = document.getElementById('chat-container');
        chatContainer.replaceChildren(createChatSwitchPlaceholder());
        void loadChatContentIncremental(chat, chatContainer, token);

        // 更新对话列表中的选中状态
        document.querySelectorAll('.chat-card').forEach(card => {
            if (card.dataset.chatId === chatId) {
                card.classList.add('selected');
            } else {
                card.classList.remove('selected');
            }
        });

        // 通知其他模块（例如：草稿/滚动按钮）当前对话已切换
        document.dispatchEvent(new CustomEvent('cerebr:chatSwitched', { detail: { chatId } }));
    }
}

// 显示对话列表
export function showChatList(chatListPage, apiSettings) {
    chatListPage.classList.add('show');
    apiSettings.classList.remove('visible');  // 确保API设置页面被隐藏
}

// 隐藏对话列表
export function hideChatList(chatListPage) {
    chatListPage.classList.remove('show');

    // Cancel any in-progress incremental render and clear heavy DOM off the critical path.
    renderToken++;
    const chatCards = chatListPage.querySelector('.chat-cards');
    const template = chatCards?.querySelector('.chat-card.template');
    if (chatCards && template) {
        const myToken = renderToken;
        const clearChunk = (deadline) => {
            if (myToken !== renderToken) return;

            const shouldContinue = () => {
                if (!deadline || typeof deadline.timeRemaining !== 'function') return false;
                return deadline.didTimeout || deadline.timeRemaining() > 8;
            };

            let removed = 0;
            while (chatCards.lastElementChild &&
                !chatCards.lastElementChild.classList.contains('template') &&
                removed < 60 &&
                (removed < 20 || shouldContinue())) {
                chatCards.lastElementChild.remove();
                removed++;
            }

            if (chatCards.children.length > 1) {
                scheduleWork(clearChunk);
            }
        };
        scheduleWork(clearChunk);
    }
}

// 初始化对话列表事件监听
export function initChatListEvents({
    chatListPage,
    chatCards,
    chatManager,
    onHide
}) {
    // 为每个卡片添加点击事件
    chatCards.addEventListener('click', async (e) => {
        const card = e.target.closest('.chat-card');
        if (!card || card.classList.contains('template')) return;

        if (!e.target.closest('.delete-btn')) {
            // 先准备聊天界面，再关闭列表页，避免“旧对话被清空”的闪动露出。
            switchToChat(card.dataset.chatId, chatManager);
            requestAnimationFrame(() => {
                if (onHide) onHide();
            });
        }
    });

    // 为删除按钮添加点击事件
    chatCards.addEventListener('click', async (e) => {
        const deleteBtn = e.target.closest('.delete-btn');
        if (!deleteBtn) return;

        const card = deleteBtn.closest('.chat-card');
        if (!card || card.classList.contains('template')) return;

        e.stopPropagation();
        const prevChatId = chatManager.getCurrentChat()?.id || null;
        // 清理该对话的阅读进度（避免无效残留）
        await storageAdapter.remove(`cerebr_reading_progress_v1_${card.dataset.chatId}`);
        await chatManager.deleteChat(card.dataset.chatId);
        scheduleWork(() => renderChatListIncremental(chatManager, chatCards));

        // 如果删除的是当前对话，重新加载聊天内容
        const currentChat = chatManager.getCurrentChat();
        if (currentChat) {
            const token = ++chatContentToken;
            const chatContainer = document.getElementById('chat-container');
            chatContainer.replaceChildren(createChatSwitchPlaceholder());
            void loadChatContentIncremental(currentChat, chatContainer, token);
            if (prevChatId !== currentChat.id) {
                document.dispatchEvent(new CustomEvent('cerebr:chatSwitched', { detail: { chatId: currentChat.id } }));
            }
        }
    });

    // 返回按钮点击事件
    const backButton = chatListPage.querySelector('.back-button');
    if (backButton) {
        backButton.addEventListener('click', () => {
            if (onHide) onHide();
        });
    }
}

// 初始化聊天列表功能
export function initializeChatList({
    chatListPage,
    chatManager,
    newChatButton,
    chatListButton,
    settingsMenu,
    apiSettings
}) {
    const messageInput = document.getElementById('message-input');
    // 新建对话按钮点击事件
    newChatButton.addEventListener('click', async () => {
        const currentChat = chatManager.getCurrentChat();
        // 如果当前对话没有消息，则不创建新对话
        if (currentChat && currentChat.messages.length === 0) {
            return;
        }

        const newChat = chatManager.createNewChat(t('chat_new_title'));
        switchToChat(newChat.id, chatManager);
        settingsMenu.classList.remove('visible');
        messageInput.focus();

        if (isExtensionEnvironment) {
            const currentTab = await browserAdapter.getCurrentTab();
            if (currentTab?.id) {
                await setWebpageSwitchesForChat(newChat.id, { [currentTab.id]: true });
            }
        }
    });

    // 对话列表按钮点击事件
    chatListButton.addEventListener('click', () => {
        const searchInput = document.getElementById('chat-search-input');
        const chatCards = chatListPage.querySelector('.chat-cards');
        if (searchInput) searchInput.value = ''; // 清空搜索框

        // Show UI first, then render incrementally off the click task.
        showChatList(chatListPage, apiSettings);

        settingsMenu.classList.remove('visible');

        scheduleWork(() => renderChatListIncremental(chatManager, chatCards));
    });

    // 搜索框事件
    const searchInput = document.getElementById('chat-search-input');
    const clearSearchBtn = chatListPage.querySelector('.clear-search-btn');
    const chatCards = chatListPage.querySelector('.chat-cards');

    let searchTimer = null;
    let lastSearchTerm = '';

    searchInput.addEventListener('input', () => {
        const searchTerm = searchInput.value;
        clearSearchBtn.style.display = searchTerm ? 'flex' : 'none';

        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            if (searchTerm === lastSearchTerm) return;
            lastSearchTerm = searchTerm;
            renderChatListIncremental(chatManager, chatCards, searchTerm);
        }, 140);
    });

    clearSearchBtn.addEventListener('click', () => {
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input'));
        searchInput.focus();
    });

    // 对话列表返回按钮点击事件
    const chatListBackButton = chatListPage.querySelector('.back-button');
    if (chatListBackButton) {
        chatListBackButton.addEventListener('click', () => hideChatList(chatListPage));
    }
}
