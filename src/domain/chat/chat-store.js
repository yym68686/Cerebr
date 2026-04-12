import { storageAdapter, browserAdapter, isExtensionEnvironment } from '../../utils/storage-adapter.js';
import {
    DEFAULT_CHAT_KIND,
    buildDefaultChatSeedMessages,
    getDefaultChatTitle,
    resolveDefaultChatLocale
} from '../../utils/default-chat.js';

const LEGACY_CHATS_KEY = 'cerebr_chats';
const CHATS_INDEX_V2_KEY = 'cerebr_chats_index_v2';
const CHAT_V2_PREFIX = 'cerebr_chat_v2_';
const LEGACY_CURRENT_CHAT_ID_KEY = 'cerebr_current_chat_id';
const CURRENT_CHAT_ID_BY_TAB_PREFIX = 'cerebr_current_chat_id_v1_tab_';
// 最新活跃对话（跨 tab 的“默认回退”），避免依赖陈旧的 legacy key
const LAST_ACTIVE_CHAT_ID_KEY = 'cerebr_last_active_chat_id_v1';

const YT_TRANSCRIPT_REF_FIELD = 'youtubeTranscriptRefs';
const STREAM_PARTIAL_SAVE_THROTTLE_MS = 750;

function chatKeyV2(chatId) {
    return `${CHAT_V2_PREFIX}${chatId}`;
}

export class ChatManager {
    constructor() {
        this.storage = storageAdapter;
        this.currentChatId = null;
        this._currentChatIdStorageKey = LEGACY_CURRENT_CHAT_ID_KEY;
        this.chats = new Map();
        this._saveDirty = false;
        this._indexDirty = false;
        this._dirtyChatIds = new Set();
        this._pendingRemovals = new Set();
        this._migrationQueue = [];
        this._legacyCleanupDone = false;
        this._saveScheduled = false;
        this._saveInProgress = false;
        this._throttledSaveTimer = null;
        this._pendingSaveThrottleMs = null;
        this._savePromise = null;
        this._savePromiseResolve = null;
        this._savePromiseReject = null;
        this._initializePromise = null;
        this.initialize();
    }

    _nextTick() {
        return new Promise((resolve) => setTimeout(resolve, 0));
    }

    _getChatActivityTimeMs(chat) {
        const time = chat?.updatedAt || chat?.createdAt;
        const ms = Date.parse(time);
        return Number.isFinite(ms) ? ms : 0;
    }

    _getMostRecentChat() {
        const chats = Array.from(this.chats.values());
        if (chats.length === 0) return null;
        chats.sort((a, b) => this._getChatActivityTimeMs(b) - this._getChatActivityTimeMs(a));
        return chats[0] || null;
    }

    async _resolveCurrentChatIdStorageKey() {
        if (!isExtensionEnvironment) {
            this._currentChatIdStorageKey = LEGACY_CURRENT_CHAT_ID_KEY;
            return this._currentChatIdStorageKey;
        }

        try {
            const tab = await browserAdapter.getCurrentTab();
            const tabId = tab?.id;
            if (typeof tabId === 'number' && Number.isFinite(tabId) && tabId >= 0) {
                this._currentChatIdStorageKey = `${CURRENT_CHAT_ID_BY_TAB_PREFIX}${tabId}`;
                return this._currentChatIdStorageKey;
            }
        } catch {
            // ignore
        }

        this._currentChatIdStorageKey = LEGACY_CURRENT_CHAT_ID_KEY;
        return this._currentChatIdStorageKey;
    }

    async initialize() {
        if (this._initializePromise) {
            return this._initializePromise;
        }

        this._initializePromise = this._initializeImpl();
        try {
            return await this._initializePromise;
        } finally {
            this._initializePromise = null;
        }
    }

    async _initializeImpl() {
        await this._resolveCurrentChatIdStorageKey();

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

        // 获取当前对话ID（扩展环境：按 tab 维度；Web 环境：全局）
        const keysToRead = isExtensionEnvironment
            ? [this._currentChatIdStorageKey, LAST_ACTIVE_CHAT_ID_KEY, LEGACY_CURRENT_CHAT_ID_KEY]
            : [this._currentChatIdStorageKey];
        const currentChatResult = await this.storage.get(keysToRead);
        const tabScopedChatId = currentChatResult[this._currentChatIdStorageKey];
        const lastActiveChatId = currentChatResult[LAST_ACTIVE_CHAT_ID_KEY];
        const legacyChatId = currentChatResult[LEGACY_CURRENT_CHAT_ID_KEY];

        // 默认选择逻辑：
        // 1) tab 维度（用户在该 tab 的选择）
        // 2) 跨 tab 最近活跃对话（新开 tab 的默认）
        // 3) 最“新”的对话（按 updatedAt/createdAt）
        // 4) legacy key（仅作为兼容兜底，不应长期依赖）
        const preferredCandidates = [
            tabScopedChatId,
            lastActiveChatId,
            this._getMostRecentChat()?.id,
            legacyChatId
        ].filter(Boolean);

        this.currentChatId = preferredCandidates.find((id) => this.chats.has(id)) || null;

        // 迁移：tab 维度不存在时回退 legacy 全局 key；同时写入 tab 维度 key（不再写回 legacy，避免跨 tab 干扰）
        if (isExtensionEnvironment && this.currentChatId) {
            const lastActiveValid = !!lastActiveChatId && this.chats.has(lastActiveChatId);
            await this.storage.set({
                [this._currentChatIdStorageKey]: this.currentChatId,
                ...(lastActiveValid ? {} : { [LAST_ACTIVE_CHAT_ID_KEY]: this.currentChatId })
            });
        }

        // 如果仍没有当前对话：优先使用“最新”对话，否则创建一个默认对话
        if (!this.currentChatId || !this.chats.has(this.currentChatId)) {
            const fallback = this._getMostRecentChat();
            if (fallback?.id) {
                this.currentChatId = fallback.id;
            } else {
                const defaultChat = await this.createDefaultChat();
                this.currentChatId = defaultChat.id;
            }

            await this.storage.set({
                [this._currentChatIdStorageKey]: this.currentChatId,
                ...(isExtensionEnvironment ? { [LAST_ACTIVE_CHAT_ID_KEY]: this.currentChatId } : {})
            });
        }
    }

    createNewChat(title = '新对话') {
        return this.createChat({
            title
        });
    }

    createChat({
        title = '新对话',
        messages = [],
        kind = null,
        titleLocaleBound = undefined
    } = {}) {
        const chatId = Date.now().toString();
        const createdAt = new Date().toISOString();
        const chat = {
            id: chatId,
            title,
            messages: Array.isArray(messages) ? messages.map((message) => ({ ...message })) : [],
            createdAt,
            updatedAt: createdAt
        };
        if (kind) {
            chat.kind = kind;
        }
        if (typeof titleLocaleBound === 'boolean') {
            chat.titleLocaleBound = titleLocaleBound;
        }
        this.chats.set(chatId, chat);
        this._dirtyChatIds.add(chatId);
        this._indexDirty = true;
        this.saveChats();
        return chat;
    }

    async createDefaultChat() {
        const locale = await resolveDefaultChatLocale();
        return this.createChat({
            title: getDefaultChatTitle(locale),
            kind: DEFAULT_CHAT_KIND,
            titleLocaleBound: true,
            messages: buildDefaultChatSeedMessages(locale)
        });
    }

    renameChat(chatId, title) {
        if (!this.chats.has(chatId)) {
            throw new Error('对话不存在');
        }

        const normalizedTitle = String(title || '').trim();
        if (!normalizedTitle) {
            throw new Error('对话标题不能为空');
        }

        const chat = this.chats.get(chatId);
        if (!chat) {
            throw new Error('对话不存在');
        }

        if (chat.title === normalizedTitle) {
            return chat;
        }

        chat.title = normalizedTitle;
        if (chat.kind === DEFAULT_CHAT_KIND) {
            chat.titleLocaleBound = false;
        }
        this.markChatDirty(chatId, { touchUpdatedAt: false });
        this.saveChats({ touchCurrentChat: false });
        return chat;
    }

    async switchChat(chatId) {
        if (!this.chats.has(chatId)) {
            throw new Error('对话不存在');
        }
        this.currentChatId = chatId;
        const chat = this.chats.get(chatId);
        if (chat) {
            chat.updatedAt = new Date().toISOString();
            this._dirtyChatIds.add(chatId);
            this.saveChats();
        }
        await this._resolveCurrentChatIdStorageKey();
        await this.storage.set({
            [this._currentChatIdStorageKey]: chatId,
            ...(isExtensionEnvironment ? { [LAST_ACTIVE_CHAT_ID_KEY]: chatId } : {})
        });
        return this.chats.get(chatId);
    }

    async deleteChat(chatId) {
        if (!this.chats.has(chatId)) {
            throw new Error('对话不存在');
        }

        const deletedChat = this.chats.get(chatId);
        const deletedRefs = Array.isArray(deletedChat?.[YT_TRANSCRIPT_REF_FIELD])
            ? deletedChat[YT_TRANSCRIPT_REF_FIELD]
            : [];
        const deletedKeys = Array.from(new Set(deletedRefs.map(r => r?.key).filter(Boolean)));

        this.chats.delete(chatId);
        this._pendingRemovals.add(chatKeyV2(chatId));
        this._indexDirty = true;
        this.saveChats();

        // 清理不再被任何对话引用的 YouTube 字幕缓存
        if (deletedKeys.length > 0) {
            const stillReferenced = new Set();
            for (const chat of this.chats.values()) {
                const refs = Array.isArray(chat?.[YT_TRANSCRIPT_REF_FIELD]) ? chat[YT_TRANSCRIPT_REF_FIELD] : [];
                refs.forEach((ref) => {
                    if (ref?.key) stillReferenced.add(ref.key);
                });
            }

            const keysToRemove = deletedKeys.filter((k) => !stillReferenced.has(k));
            if (keysToRemove.length > 0) {
                await this.storage.remove(keysToRemove).catch(() => {});
            }
        }

        // 如果删除的是当前对话，切换到其他对话
        if (chatId === this.currentChatId) {
            const nextChat = this._getMostRecentChat();
            if (nextChat) {
                await this.switchChat(nextChat.id);
                this.currentChatId = nextChat.id;
            } else {
                const newChat = await this.createDefaultChat();
                await this.switchChat(newChat.id);
                this.currentChatId = newChat.id;
            }
        }
    }

    markChatDirty(chatId, { touchUpdatedAt = true } = {}) {
        if (!chatId) return false;
        const chat = this.chats.get(chatId);
        if (!chat) return false;

        if (touchUpdatedAt) {
            chat.updatedAt = new Date().toISOString();
        }
        this._dirtyChatIds.add(chatId);
        return true;
    }

    /**
     * 记录当前对话引用的 YouTube 字幕缓存 key（用于跨消息复用 & 删除对话时 GC）。
     * @param {string} chatId
     * @param {{key: string, videoId?: string, lang?: string, updatedAt?: number}} ref
     */
    addYouTubeTranscriptRef(chatId, ref) {
        if (!chatId || !ref?.key) return;
        const chat = this.chats.get(chatId);
        if (!chat) return;

        if (!Array.isArray(chat[YT_TRANSCRIPT_REF_FIELD])) {
            chat[YT_TRANSCRIPT_REF_FIELD] = [];
        }

        const exists = chat[YT_TRANSCRIPT_REF_FIELD].some((r) => r?.key === ref.key);
        if (!exists) {
            chat[YT_TRANSCRIPT_REF_FIELD].push({
                key: ref.key,
                videoId: ref.videoId || null,
                lang: ref.lang || null,
                updatedAt: ref.updatedAt || Date.now()
            });
        } else {
            // Update metadata if present
            const idx = chat[YT_TRANSCRIPT_REF_FIELD].findIndex((r) => r?.key === ref.key);
            if (idx >= 0) {
                const current = chat[YT_TRANSCRIPT_REF_FIELD][idx] || {};
                chat[YT_TRANSCRIPT_REF_FIELD][idx] = {
                    ...current,
                    videoId: ref.videoId || current.videoId || null,
                    lang: ref.lang || current.lang || null,
                    updatedAt: ref.updatedAt || Date.now()
                };
            }
        }

        this._dirtyChatIds.add(chatId);
        this.saveChats();
    }

    /**
     * 找到某个对话里对某个视频的字幕引用（优先最新）。
     * @param {string} chatId
     * @param {string} videoId
     */
    getYouTubeTranscriptRef(chatId, videoId) {
        if (!chatId || !videoId) return null;
        const chat = this.chats.get(chatId);
        if (!chat) return null;
        const refs = Array.isArray(chat?.[YT_TRANSCRIPT_REF_FIELD]) ? chat[YT_TRANSCRIPT_REF_FIELD] : [];
        const matches = refs.filter((r) => r?.videoId === videoId && r?.key);
        if (matches.length === 0) return null;
        matches.sort((a, b) => (b?.updatedAt || 0) - (a?.updatedAt || 0));
        return matches[0];
    }

    getCurrentChat() {
        return this.chats.get(this.currentChatId);
    }

    getAllChats() {
        return Array.from(this.chats.values()).sort((a, b) =>
            this._getChatActivityTimeMs(b) - this._getChatActivityTimeMs(a)
        );
    }

    async addMessageToCurrentChat(message) {
        const currentChat = this.getCurrentChat();
        if (!currentChat) {
            throw new Error('当前没有活动的对话');
        }
        currentChat.messages.push(message);
        currentChat.updatedAt = new Date().toISOString();
        this._dirtyChatIds.add(currentChat.id);
        if (isExtensionEnvironment) {
            // 避免调用方未 await 导致潜在的 Unhandled Promise Rejection
            void this.storage.set({ [LAST_ACTIVE_CHAT_ID_KEY]: currentChat.id }).catch(() => {});
        }
        this.saveChats();
    }

    async updateLastMessage(chatId, message, { throttleMs = STREAM_PARTIAL_SAVE_THROTTLE_MS } = {}) {
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
        this.markChatDirty(chatId);
        this.saveChats({ touchCurrentChat: false, throttleMs });
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

    _ensureSavePromise() {
        if (this._savePromise) return this._savePromise;

        this._savePromise = new Promise((resolve, reject) => {
            this._savePromiseResolve = resolve;
            this._savePromiseReject = reject;
        });
        // 防止未 await 的调用产生 Unhandled Promise Rejection
        this._savePromise.catch(() => {});
        return this._savePromise;
    }

    _clearThrottledSaveTimer() {
        if (!this._throttledSaveTimer) return;
        clearTimeout(this._throttledSaveTimer);
        this._throttledSaveTimer = null;
    }

    async saveChats({ touchCurrentChat = true, throttleMs = 0 } = {}) {
        this._saveDirty = true;
        this._ensureSavePromise();

        // 兼容：部分调用方会直接 mutate currentChat.messages 后再调用 saveChats()
        if (touchCurrentChat && this.currentChatId) {
            const chat = this.chats.get(this.currentChatId);
            if (chat) {
                chat.updatedAt = new Date().toISOString();
            }
            if (!this._dirtyChatIds.has(this.currentChatId)) {
                this._dirtyChatIds.add(this.currentChatId);
            }
        }

        this._requestSave({ throttleMs });
        return this._savePromise;
    }

    /**
     * Best-effort: flush pending chat/index writes ASAP (avoid relying on requestIdleCallback).
     * Useful right after a user/assistant message is completed to reduce the chance of losing it on refresh.
     */
    async flushNow({ maxRounds = 64 } = {}) {
        this._clearThrottledSaveTimer();
        this._pendingSaveThrottleMs = 0;

        if (!this._saveDirty && !this._saveInProgress) return;

        // Ensure a promise exists for callers that want to await persistence.
        if (!this._savePromise && this._saveDirty) {
            this._ensureSavePromise();
        }

        const deadline = { timeRemaining: () => Number.POSITIVE_INFINITY, didTimeout: true };
        for (let i = 0; i < maxRounds; i++) {
            if (!this._saveDirty) break;
            if (this._saveInProgress) {
                await this._nextTick();
                continue;
            }
            await this._flushSave(deadline);
        }

        if (this._saveDirty) {
            console.warn('[Cerebr] Chat persistence flush did not finish before maxRounds; will continue in background.');
        }

        await (this._savePromise || Promise.resolve());
    }

    async clearCurrentChat() {
        const currentChat = this.getCurrentChat();
        if (currentChat) {
            currentChat.messages = [];
            this._dirtyChatIds.add(currentChat.id);
            this.saveChats();
        }
    }

    _scheduleImmediateSave() {
        this._clearThrottledSaveTimer();
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

    _requestSave({ throttleMs = 0 } = {}) {
        const normalizedThrottleMs = Math.max(0, Number(throttleMs) || 0);

        if (normalizedThrottleMs <= 0) {
            this._pendingSaveThrottleMs = 0;
            if (this._saveInProgress) {
                this._clearThrottledSaveTimer();
                return;
            }
            this._scheduleImmediateSave();
            return;
        }

        if (this._pendingSaveThrottleMs !== 0) {
            this._pendingSaveThrottleMs = normalizedThrottleMs;
        }

        if (this._saveInProgress || this._saveScheduled || this._throttledSaveTimer) {
            return;
        }

        this._throttledSaveTimer = setTimeout(() => {
            this._throttledSaveTimer = null;
            this._pendingSaveThrottleMs = null;
            this._scheduleImmediateSave();
        }, normalizedThrottleMs);
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
                this._pendingSaveThrottleMs = null;
            } else {
                const nextThrottleMs = this._pendingSaveThrottleMs;
                this._pendingSaveThrottleMs = null;
                this._requestSave({ throttleMs: nextThrottleMs });
            }
        } catch (err) {
            console.error('保存对话失败:', err);
            this._clearThrottledSaveTimer();
            this._pendingSaveThrottleMs = null;
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
