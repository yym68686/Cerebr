import { storageAdapter } from './storage-adapter.js';

const LEGACY_CHATS_KEY = 'cerebr_chats';
const CHATS_INDEX_V2_KEY = 'cerebr_chats_index_v2';
const CHAT_V2_PREFIX = 'cerebr_chat_v2_';
const CURRENT_CHAT_ID_KEY = 'cerebr_current_chat_id';

function chatKeyV2(chatId) {
    return `${CHAT_V2_PREFIX}${chatId}`;
}

export class ChatManager {
    constructor() {
        this.storage = storageAdapter;
        this.currentChatId = null;
        this.chats = new Map();
        this._saveDirty = false;
        this._indexDirty = false;
        this._dirtyChatIds = new Set();
        this._pendingRemovals = new Set();
        this._migrationQueue = [];
        this._legacyCleanupDone = false;
        this._saveScheduled = false;
        this._saveInProgress = false;
        this._savePromise = null;
        this._savePromiseResolve = null;
        this._savePromiseReject = null;
        this.initialize();
    }

    async initialize() {
        // 优先加载 v2 索引（按 chatId 分片存储，避免每次写入整个 77MB）
        const indexResult = await this.storage.get(CHATS_INDEX_V2_KEY);
        const chatIds = indexResult[CHATS_INDEX_V2_KEY];

        if (Array.isArray(chatIds) && chatIds.length > 0) {
            const keys = chatIds.map(chatKeyV2);
            const chatsByKey = await this.storage.get(keys);

            const missingIds = [];
            chatIds.forEach((id) => {
                const chat = chatsByKey[chatKeyV2(id)];
                if (chat) {
                    this.chats.set(chat.id, chat);
                } else {
                    missingIds.push(id);
                }
            });

            // 兼容：如果部分 v2 分片缺失，回退从旧的整体存储中补齐，并排队迁移
            if (missingIds.length > 0) {
                const legacyResult = await this.storage.get(LEGACY_CHATS_KEY);
                const legacyChats = legacyResult[LEGACY_CHATS_KEY] || [];
                if (Array.isArray(legacyChats) && legacyChats.length > 0) {
                    const legacyMap = new Map(legacyChats.map(c => [c.id, c]));
                    missingIds.forEach((id) => {
                        const chat = legacyMap.get(id);
                        if (chat) {
                            this.chats.set(chat.id, chat);
                            this._migrationQueue.push(chat.id);
                        }
                    });
                    if (this._migrationQueue.length > 0) {
                        this._saveDirty = true;
                        this._scheduleSave();
                    }
                }
            }
        } else {
            // v2 不存在：读取旧存储，并在空闲时迁移到 v2
            const legacyResult = await this.storage.get(LEGACY_CHATS_KEY);
            const savedChats = legacyResult[LEGACY_CHATS_KEY] || [];
            if (Array.isArray(savedChats)) {
                savedChats.forEach(chat => {
                    this.chats.set(chat.id, chat);
                    this._migrationQueue.push(chat.id);
                });
                if (this._migrationQueue.length > 0) {
                    this._indexDirty = true;
                    this._saveDirty = true;
                    this._scheduleSave();
                }
            }
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
        this._dirtyChatIds.add(chatId);
        this._indexDirty = true;
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
        this._pendingRemovals.add(chatKeyV2(chatId));
        this._indexDirty = true;
        this.saveChats();

        // 如果删除的是当前对话，切换到其他对话
        if (chatId === this.currentChatId) {
            const nextChat = Array.from(this.chats.values()).pop();
            if (nextChat) {
                await this.switchChat(nextChat.id);
                this.currentChatId = nextChat.id;
            } else {
                const newChat = this.createNewChat('默认对话');
                await this.switchChat(newChat.id);
                this.currentChatId = newChat.id;
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
        this._dirtyChatIds.add(currentChat.id);
        this.saveChats();
    }

    async updateLastMessage(chatId, message) {
        const currentChat = this.chats.get(chatId);
        if (!currentChat || currentChat.messages.length === 0) {
            // throw new Error('当前没有消息可以更新');
            return;
        }
        if (currentChat.messages[currentChat.messages.length - 1].role === 'user') {
            currentChat.messages.push({
                role: 'assistant',
                updating: true
            });
        }
        if (message.content) {
            currentChat.messages[currentChat.messages.length - 1].content = message.content;
        }
        if (message.reasoning_content) {
            currentChat.messages[currentChat.messages.length - 1].reasoning_content = message.reasoning_content;
        }
        this._dirtyChatIds.add(chatId);
        this.saveChats();
    }

    async popMessage() {
        const currentChat = this.getCurrentChat();
        if (!currentChat) {
            throw new Error('对话不存在');
        }
        currentChat.messages.pop();
        this._dirtyChatIds.add(currentChat.id);
        this.saveChats();
    }

    async saveChats() {
        this._saveDirty = true;

        if (!this._savePromise) {
            this._savePromise = new Promise((resolve, reject) => {
                this._savePromiseResolve = resolve;
                this._savePromiseReject = reject;
            });
            // 防止未 await 的调用产生 Unhandled Promise Rejection
            this._savePromise.catch(() => {});
        }

        // 兼容：部分调用方会直接 mutate currentChat.messages 后再调用 saveChats()
        if (this.currentChatId && !this._dirtyChatIds.has(this.currentChatId)) {
            this._dirtyChatIds.add(this.currentChatId);
        }

        this._scheduleSave();
        return this._savePromise;
    }

    async clearCurrentChat() {
        const currentChat = this.getCurrentChat();
        if (currentChat) {
            currentChat.messages = [];
            this._dirtyChatIds.add(currentChat.id);
            this.saveChats();
        }
    }

    _scheduleSave() {
        if (this._saveScheduled) return;
        this._saveScheduled = true;

        const run = (deadline) => {
            this._saveScheduled = false;
            void this._flushSave(deadline);
        };

        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(run, { timeout: 1000 });
        } else {
            setTimeout(run, 0);
        }
    }

    async _flushSave(deadline) {
        if (this._saveInProgress) return;
        if (!this._saveDirty) return;

        this._saveInProgress = true;
        try {
            const shouldYield = () => {
                if (!deadline || typeof deadline.timeRemaining !== 'function') return false;
                return deadline.timeRemaining() < 10;
            };

            // 1) 处理删除
            if (this._pendingRemovals.size > 0 && !shouldYield()) {
                const keysToRemove = Array.from(this._pendingRemovals);
                this._pendingRemovals.clear();
                await this.storage.remove(keysToRemove);
            }

            // 2) 确保 v2 索引存在/更新（只存 chatId 列表，避免重复大数据）
            if (this._indexDirty && !shouldYield()) {
                this._indexDirty = false;
                await this.storage.set({ [CHATS_INDEX_V2_KEY]: Array.from(this.chats.keys()) });
            }

            // 3) 迁移：把 legacy 的 chat 逐步写入 v2（每次写一个，避免长任务）
            if (this._migrationQueue.length > 0 && !shouldYield()) {
                const migrateId = this._migrationQueue.pop();
                const chat = this.chats.get(migrateId);
                if (chat) {
                    await this.storage.set({ [chatKeyV2(migrateId)]: chat });
                }
            }

            // 4) 正常保存：只写入被修改的 chat（避免每次写整份 77MB）
            if (this._dirtyChatIds.size > 0 && !shouldYield()) {
                const [chatId] = this._dirtyChatIds;
                this._dirtyChatIds.delete(chatId);
                const chat = this.chats.get(chatId);
                if (chat) {
                    await this.storage.set({ [chatKeyV2(chatId)]: chat });
                }
            }

            // 迁移完成后，尝试清理 legacy 大对象（如果存在）
            if (!this._legacyCleanupDone && this._migrationQueue.length === 0) {
                // 注意：remove 是幂等的；如果 legacy 已不存在也没关系
                this._legacyCleanupDone = true;
                await this.storage.remove(LEGACY_CHATS_KEY).catch(() => {});
            }

            // 如果还有待处理工作，继续调度；否则完成本次保存
            this._saveDirty = this._pendingRemovals.size > 0 ||
                this._indexDirty ||
                this._migrationQueue.length > 0 ||
                this._dirtyChatIds.size > 0;

            if (!this._saveDirty) {
                this._savePromiseResolve?.();
                this._savePromise = null;
                this._savePromiseResolve = null;
                this._savePromiseReject = null;
            } else {
                this._scheduleSave();
            }
        } catch (err) {
            console.error('保存对话失败:', err);
            this._savePromiseReject?.(err);
            this._savePromise = null;
            this._savePromiseResolve = null;
            this._savePromiseReject = null;
        } finally {
            this._saveInProgress = false;
        }
    }
}

// 创建并导出单例实例
export const chatManager = new ChatManager();
