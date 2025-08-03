import { appendMessage } from '../handlers/message-handler.js';
import { storageAdapter, browserAdapter, isExtensionEnvironment } from '../utils/storage-adapter.js';

// 渲染对话列表
export function renderChatList(chatManager, chatCards, searchTerm = '') {
    const template = chatCards.querySelector('.chat-card.template');
    const lowerCaseSearchTerm = searchTerm.toLowerCase();

    // 清除现有的卡片（除了模板）
    Array.from(chatCards.children).forEach(card => {
        if (!card.classList.contains('template')) {
            card.remove();
        }
    });

    // 获取当前对话ID
    const currentChatId = chatManager.getCurrentChat()?.id;

    // 获取所有对话
    const allChats = chatManager.getAllChats();

    // 筛选对话
    const filteredChats = allChats.filter(chat => {
        if (!searchTerm) return true; // 如果没有搜索词，则显示所有
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

    // 添加筛选后的对话卡片
    filteredChats.forEach(chat => {
        const card = template.cloneNode(true);
        card.classList.remove('template');
        card.style.display = '';
        card.dataset.chatId = chat.id;

        const titleElement = card.querySelector('.chat-title');
        titleElement.textContent = chat.title;

        // 设置选中状态
        if (chat.id === currentChatId) {
            card.classList.add('selected');
        } else {
            card.classList.remove('selected');
        }

        chatCards.appendChild(card);
    });
}

// 加载对话内容
export async function loadChatContent(chat, chatContainer) {
    chatContainer.innerHTML = '';
    // 确定要遍历的消息范围
    const messages = chat.messages;
    // console.log('loadChatContent', JSON.stringify(messages));

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

// 切换到指定对话
export async function switchToChat(chatId, chatManager) {
    // console.log('switchToChat', chatId);
    const chat = await chatManager.switchChat(chatId);
    if (chat) {
        await loadChatContent(chat, document.getElementById('chat-container'));

        // 更新对话列表中的选中状态
        document.querySelectorAll('.chat-card').forEach(card => {
            if (card.dataset.chatId === chatId) {
                card.classList.add('selected');
            } else {
                card.classList.remove('selected');
            }
        });
    }
}

// 显示对话列表
export function showChatList(chatListPage, apiSettings, onShow) {
    chatListPage.classList.add('show');
    apiSettings.classList.remove('visible');  // 确保API设置页面被隐藏
    if (onShow) onShow();
}

// 隐藏对话列表
export function hideChatList(chatListPage) {
    chatListPage.classList.remove('show');
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
            await switchToChat(card.dataset.chatId, chatManager);
            if (onHide) onHide();
        }
    });

    // 为删除按钮添加点击事件
    chatCards.addEventListener('click', async (e) => {
        const deleteBtn = e.target.closest('.delete-btn');
        if (!deleteBtn) return;

        const card = deleteBtn.closest('.chat-card');
        if (!card || card.classList.contains('template')) return;

        e.stopPropagation();
        await chatManager.deleteChat(card.dataset.chatId);
        renderChatList(chatManager, chatCards);

        // 如果删除的是当前对话，重新加载聊天内容
        const currentChat = chatManager.getCurrentChat();
        if (currentChat) {
            await loadChatContent(currentChat, document.getElementById('chat-container'));
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

        if (isExtensionEnvironment) {
            const currentTab = await browserAdapter.getCurrentTab();
            if (currentTab) {
                await storageAdapter.set({ webpageSwitches: { [currentTab.id]: true } });
            }
        }

        const newChat = chatManager.createNewChat();
        await switchToChat(newChat.id, chatManager);
        settingsMenu.classList.remove('visible');
        messageInput.focus();
    });

    // 对话列表按钮点击事件
    chatListButton.addEventListener('click', () => {
        showChatList(chatListPage, apiSettings, () => {
            const searchInput = document.getElementById('chat-search-input');
            const chatCards = chatListPage.querySelector('.chat-cards');
            searchInput.value = ''; // 清空搜索框
            renderChatList(chatManager, chatCards);
        });
        settingsMenu.classList.remove('visible');
    });

    // 搜索框事件
    const searchInput = document.getElementById('chat-search-input');
    const clearSearchBtn = chatListPage.querySelector('.clear-search-btn');
    const chatCards = chatListPage.querySelector('.chat-cards');

    searchInput.addEventListener('input', () => {
        const searchTerm = searchInput.value;
        renderChatList(chatManager, chatCards, searchTerm);
        clearSearchBtn.style.display = searchTerm ? 'flex' : 'none';
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