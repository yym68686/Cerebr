import { storageAdapter } from './storage-adapter.js';

const CHATS_KEY = 'cerebr_chats';
const CURRENT_CHAT_ID_KEY = 'cerebr_current_chat_id';

export class ChatManager {
    constructor() {
        this.storage = storageAdapter;
        this.currentChatId = null;
        this.chats = new Map();
        this.initialize();
    }

    async initialize() {
        // 加载所有对话
        const result = await this.storage.get(CHATS_KEY);
        const savedChats = result[CHATS_KEY] || [];
        if (Array.isArray(savedChats)) {
            savedChats.forEach(chat => {
                this.chats.set(chat.id, chat);
            });
        }

        // 获取当前对话ID
        const currentChatResult = await this.storage.get(CURRENT_CHAT_ID_KEY);
        this.currentChatId = currentChatResult[CURRENT_CHAT_ID_KEY];

        // 如果没有当前对话，创建一个默认对话
        if (!this.currentChatId || !this.chats.has(this.currentChatId)) {
            const defaultChat = this.createNewChat('默认对话');
            this.currentChatId = defaultChat.id;
            await this.storage.set({ [CURRENT_CHAT_ID_KEY]: this.currentChatId });
        }
    }

    createNewChat(title = '新对话') {
        const chatId = Date.now().toString();
        const chat = {
            id: chatId,
            title: title,
            messages: [],
            createdAt: new Date().toISOString()
        };
        this.chats.set(chatId, chat);
        this.saveChats();
        return chat;
    }

    async switchChat(chatId) {
        if (!this.chats.has(chatId)) {
            throw new Error('对话不存在');
        }
        this.currentChatId = chatId;
        await this.storage.set({ [CURRENT_CHAT_ID_KEY]: chatId });
        return this.chats.get(chatId);
    }

    async deleteChat(chatId) {
        if (!this.chats.has(chatId)) {
            throw new Error('对话不存在');
        }
        this.chats.delete(chatId);
        await this.saveChats();

        // 如果删除的是当前对话，切换到其他对话
        if (chatId === this.currentChatId) {
            const nextChat = this.chats.values().next().value;
            if (nextChat) {
                await this.switchChat(nextChat.id);
            } else {
                const newChat = this.createNewChat('默认对话');
                await this.switchChat(newChat.id);
            }
        }
    }

    getCurrentChat() {
        return this.chats.get(this.currentChatId);
    }

    getAllChats() {
        return Array.from(this.chats.values()).sort((a, b) =>
            new Date(b.createdAt) - new Date(a.createdAt)
        );
    }

    async addMessageToCurrentChat(message) {
        const currentChat = this.getCurrentChat();
        if (!currentChat) {
            throw new Error('当前没有活动的对话');
        }
        currentChat.messages.push(message);
        await this.saveChats();
    }

    async updateLastMessage(message) {
        const currentChat = this.getCurrentChat();
        if (!currentChat || currentChat.messages.length === 0) {
            throw new Error('当前没有消息可以更新');
        }
        currentChat.messages[currentChat.messages.length - 1].content = message.content;
        if (message.reasoning_content) {
            currentChat.messages[currentChat.messages.length - 1].reasoning_content = message.reasoning_content;
        }
        await this.saveChats();
    }

    async saveChats() {
        await this.storage.set({ [CHATS_KEY]: Array.from(this.chats.values()) });
    }

    async clearCurrentChat() {
        const currentChat = this.getCurrentChat();
        if (currentChat) {
            currentChat.messages = [];
            await this.saveChats();
        }
    }
}

// 创建并导出单例实例
export const chatManager = new ChatManager();