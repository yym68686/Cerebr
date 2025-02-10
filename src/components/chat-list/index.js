import { appendMessage } from '../../handlers/message-handler.js';

// 渲染对话列表
export function renderChatList(chatManager, chatCards) {
    const template = chatCards.querySelector('.chat-card.template');

    // 清除现有的卡片（除了模板）
    Array.from(chatCards.children).forEach(card => {
        if (!card.classList.contains('template')) {
            card.remove();
        }
    });

    // 添加所有对话卡片
    chatManager.getAllChats().forEach(chat => {
        const card = template.cloneNode(true);
        card.classList.remove('template');
        card.style.display = '';
        card.dataset.chatId = chat.id;

        const titleElement = card.querySelector('.chat-title');
        titleElement.textContent = chat.title;

        chatCards.appendChild(card);
    });
}

// 切换到指定对话
export async function switchToChat(chatId, chatManager, loadChatContent) {
    const chat = await chatManager.switchChat(chatId);
    await loadChatContent(chat);
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
    loadChatContent,
    onHide
}) {
    // 为每个卡片添加点击事件
    chatCards.addEventListener('click', async (e) => {
        const card = e.target.closest('.chat-card');
        if (!card || card.classList.contains('template')) return;

        if (!e.target.closest('.delete-btn')) {
            await switchToChat(card.dataset.chatId, chatManager, loadChatContent);
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
            await loadChatContent(currentChat);
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

// 加载对话内容
export async function loadChatContent(chat, chatContainer, messageHandlerConfig) {
    chatContainer.innerHTML = '';
    for (const message of chat.messages) {
        await appendMessage({
            text: message,
            sender: message.role === 'user' ? 'user' : 'ai',
            chatContainer,
            skipHistory: true,
            config: messageHandlerConfig
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
    apiSettings,
    loadChatContent
}) {
    // 新建对话按钮点击事件
    newChatButton.addEventListener('click', async () => {
        const newChat = chatManager.createNewChat();
        await switchToChat(newChat.id, chatManager, loadChatContent);
        settingsMenu.classList.remove('visible');
    });

    // 对话列表按钮点击事件
    chatListButton.addEventListener('click', () => {
        showChatList(chatListPage, apiSettings, () => {
            renderChatList(chatManager, chatListPage.querySelector('.chat-cards'));
        });
        settingsMenu.classList.remove('visible');
    });

    // 对话列表返回按钮点击事件
    const chatListBackButton = chatListPage.querySelector('.back-button');
    if (chatListBackButton) {
        chatListBackButton.addEventListener('click', () => hideChatList(chatListPage));
    }
}