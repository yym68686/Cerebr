import { subscribeRemoteChanges } from '../../runtime/sync/replica.js';
import { getLiveChat, getLiveChats, reconcileLiveChat, subscribeLiveChats } from '../../runtime/sync/live-chat.js';
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
    _revision = 0;
    _listeners = new Set();
    subscribe = (listener) => {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    };
    getSnapshot = () => this._revision;
    notify() {
        this._revision += 1;
        this._listeners.forEach(listener => listener());
    }

    constructor() {
        this.storage = storageAdapter;
        this.currentChatId = null;
        this._currentChatIdStorageKey = LEGACY_CURRENT_CHAT_ID_KEY;
        this.chats = new Map();
        this._saveDirty = false;
        this._indexDirty = false;
        this._dirtyChatIds = new Set();
        this._pendingRemovals = new Set();
        this._pendingCurrentChatSelection = null;
        this._migrationQueue = [];
        this._legacyCleanupDone = false;
        this._saveScheduled = false;
        this._scheduledSave = null;
        this._saveInProgress = false;
        this._saveTask = null;
        this._saveRetryTimer = null;
        this._saveRetryAttempt = 0;
        this._throttledSaveTimer = null;
        this._pendingSaveThrottleMs = null;
        this._savePromise = null;
        this._savePromiseResolve = null;
        this._savePromiseReject = null;
        this._initializePromise = null;
        // 首次打开只读当前对话就渲染（见 _loadCurrentChatOnly），其余对话由 loadAllChats() 补齐。
        // 补齐前 this.chats 只是子集，写索引、删除等依赖完整列表的操作都要看这几个状态。
        this._allChatsLoaded = false;
        this._storedIndexIds = null;
        this._fullLoadPromise = null;
        this._unverifiedLastActive = null;
        this.initialize();
        this._remoteQueue = Promise.resolve();
        subscribeLiveChats(() => {
            for (const chat of getLiveChats()) this.chats.set(chat.id, chat);
            this.notify();
        });
        subscribeRemoteChanges((keys) => {
            const chatKeys = keys.filter((key) => key.startsWith(CHAT_V2_PREFIX));
            if (!chatKeys.length) return;
            this._remoteQueue = this._remoteQueue.catch(() => {}).then(async () => {
                await this._initializePromise;
                // Finish an in-flight initial list load before removing rows;
                // otherwise its older snapshot can reinsert a deleted chat.
                if (this._fullLoadPromise) await this._fullLoadPromise;
                const incoming = await this.storage.get(chatKeys);
                for (const key of chatKeys) {
                    if (incoming[key]) continue;
                    const id = key.slice(CHAT_V2_PREFIX.length);
                    this._dirtyChatIds.delete(id);
                    this._migrationQueue = this._migrationQueue.filter(value => value !== id);
                    this.chats.delete(id);
                }
                await this.flushNow();
                const records = await this.storage.get(chatKeys);
                for (const key of chatKeys) {
                    const id = key.slice(CHAT_V2_PREFIX.length);
                    reconcileLiveChat(id, records[key]);
                    if (records[key]) this.chats.set(id, getLiveChat(id) || records[key]);
                    else if (!getLiveChat(id)) this.chats.delete(id);
                }
                if (this._storedIndexIds) this._storedIndexIds = (await this.storage.get(CHATS_INDEX_V2_KEY))[CHATS_INDEX_V2_KEY] || [];
                if (!this.chats.has(this.currentChatId)) {
                    if (!this._allChatsLoaded) await this.loadAllChats();
                    this.currentChatId = this._getMostRecentChat()?.id || null;
                    if (!this.currentChatId) this.currentChatId = (await this.createDefaultChat()).id;
                }
                this.notify();
            }).catch((error) => console.error('[Cerebr] Applying synchronized chat failed', error));
        });
    }

    get allChatsLoaded() {
        return this._allChatsLoaded;
    }

    _getChatActivityTimeMs(chat) {
        const time = chat?.lastUserMessageAt || chat?.updatedAt || chat?.createdAt;
        const ms = Date.parse(time);
        return Number.isFinite(ms) ? ms : 0;
    }

    _getMostRecentChat() {
        let mostRecentChat = null;
        let mostRecentTime = -1;

        for (const chat of this.chats.values()) {
            const activityTime = this._getChatActivityTimeMs(chat);
            if (activityTime > mostRecentTime) {
                mostRecentTime = activityTime;
                mostRecentChat = chat;
            }
        }

        return mostRecentChat;
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
            const result = await this._initializePromise;
            this.notify();
            return result;
        } finally {
            this._initializePromise = null;
        }
    }

    async _readCurrentChatIdCandidates() {
        await this._resolveCurrentChatIdStorageKey();

        // 获取当前对话ID（扩展环境：按 tab 维度；Web 环境：全局）
        const keysToRead = isExtensionEnvironment
            ? [this._currentChatIdStorageKey, LAST_ACTIVE_CHAT_ID_KEY, LEGACY_CURRENT_CHAT_ID_KEY]
            : [this._currentChatIdStorageKey];
        const currentChatResult = await this.storage.get(keysToRead);
        return {
            tabScopedChatId: currentChatResult[this._currentChatIdStorageKey],
            lastActiveChatId: currentChatResult[LAST_ACTIVE_CHAT_ID_KEY],
            legacyChatId: currentChatResult[LEGACY_CURRENT_CHAT_ID_KEY]
        };
    }

    async _initializeImpl() {
        // 还没补齐就重新初始化（如切换 tab）：先补齐，下面的完整加载就和一次性读全部时完全一样
        if (!this._allChatsLoaded && this._storedIndexIds) {
            await this._loadRemainingChatsOnce();
        }
        const isFirstLoad = this.chats.size === 0;

        // 优先加载 v2 索引（按 chatId 分片存储，避免每次写入整个 77MB）
        const [indexResult, candidates] = await Promise.all([
            this.storage.get(CHATS_INDEX_V2_KEY),
            this._readCurrentChatIdCandidates()
        ]);
        const chatIds = indexResult[CHATS_INDEX_V2_KEY];
        const { tabScopedChatId, lastActiveChatId, legacyChatId } = candidates;

        if (Array.isArray(chatIds) && chatIds.length > 0) {
            // 首次打开只读当前对话这一条：读全部对话要几百毫秒，会让侧栏空白到读完为止
            if (isFirstLoad && await this._loadCurrentChatOnly(chatIds, candidates)) {
                return;
            }

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
                        this._scheduleImmediateSave();
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
                    this._scheduleImmediateSave();
                }
            }
        }
        this._allChatsLoaded = true;
        this._storedIndexIds = null;

        // 默认选择逻辑：
        // 1) tab 维度（用户在该 tab 的选择）
        // 2) 跨 tab 最近活跃对话（新开 tab 的默认）
        // 3) 最近提问的对话（旧数据回退到 updatedAt/createdAt）
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

    /**
     * 首次打开的快路径：tab 维度或跨 tab 最近活跃的对话在索引里时，只读这一条。
     * 选中的对话与完整加载一致；更靠后的候选（最新对话、legacy key）要看全部对话才能判断，交给完整加载。
     */
    async _loadCurrentChatOnly(chatIds, { tabScopedChatId, lastActiveChatId }) {
        const indexed = new Set(chatIds);
        const chatId = [tabScopedChatId, lastActiveChatId].find((id) => id && indexed.has(id));
        if (!chatId) return false;

        const key = chatKeyV2(chatId);
        const chat = (await this.storage.get(key))[key];
        // 分片缺失（可能要从 legacy 补齐）或内容对不上：交给完整加载
        if (chat?.id !== chatId) return false;

        this.chats.set(chatId, chat);
        this.currentChatId = chatId;
        this._storedIndexIds = chatIds;
        this._allChatsLoaded = false;

        if (isExtensionEnvironment) {
            // 最近活跃对话在索引里、但不是本次选中的：它的分片还在不在，要等补齐后才知道（见 _verifyLastActiveChatId）
            const unverified = !!lastActiveChatId && lastActiveChatId !== chatId && indexed.has(lastActiveChatId);
            this._unverifiedLastActive = unverified ? { lastActiveChatId, chatId } : null;
            const lastActiveValid = lastActiveChatId === chatId || unverified;
            // 写入与完整加载相同的值；已经一致时省掉这次写入
            if (tabScopedChatId !== chatId || !lastActiveValid) {
                await this.storage.set({
                    [this._currentChatIdStorageKey]: chatId,
                    ...(lastActiveValid ? {} : { [LAST_ACTIVE_CHAT_ID_KEY]: chatId })
                });
            }
        }
        return true;
    }

    /**
     * 确保 this.chats 包含全部对话（首次打开只加载了当前对话）。
     * 可重复调用；并发调用共用同一次读取。
     */
    async loadAllChats() {
        while (!this._allChatsLoaded) {
            if (this._initializePromise) {
                await this._initializePromise;
            } else if (this._storedIndexIds) {
                await this._loadRemainingChatsOnce();
            } else {
                await this.initialize();
            }
        }
    }

    _loadRemainingChatsOnce() {
        if (!this._fullLoadPromise) {
            this._fullLoadPromise = this._loadRemainingChats().finally(() => {
                this._fullLoadPromise = null;
            });
        }
        return this._fullLoadPromise;
    }

    async _loadRemainingChats() {
        const storedIds = this._storedIndexIds;
        // 已在内存里的（当前对话、之后新建的）以内存为准，不能被存储里的旧版本覆盖
        const idsToRead = storedIds.filter((id) => !this.chats.has(id));
        const chatsByKey = await this.storage.get(idsToRead.map(chatKeyV2));

        // 兼容：如果部分 v2 分片缺失，回退从旧的整体存储中补齐，并排队迁移
        const missingIds = idsToRead.filter((id) => !chatsByKey[chatKeyV2(id)]);
        let legacyMap = null;
        if (missingIds.length > 0) {
            const legacyResult = await this.storage.get(LEGACY_CHATS_KEY);
            const legacyChats = legacyResult[LEGACY_CHATS_KEY] || [];
            if (Array.isArray(legacyChats) && legacyChats.length > 0) {
                legacyMap = new Map(legacyChats.map(c => [c.id, c]));
            }
        }

        // 顺序与一次性完整加载相同：索引顺序的 v2 分片，然后是 legacy 补齐的，最后是之后新建的
        const merged = new Map();
        storedIds.forEach((id) => {
            const chat = this.chats.get(id) || chatsByKey[chatKeyV2(id)];
            if (chat) {
                merged.set(chat.id, this.chats.get(chat.id) || chat);
            }
        });
        let migrated = false;
        missingIds.forEach((id) => {
            const chat = legacyMap?.get(id);
            if (chat) {
                merged.set(chat.id, chat);
                this._migrationQueue.push(chat.id);
                migrated = true;
            }
        });
        this.chats.forEach((chat, id) => {
            if (!merged.has(id)) merged.set(id, chat);
        });

        this.chats.clear();
        merged.forEach((chat, id) => this.chats.set(id, chat));
        this._allChatsLoaded = true;
        this._storedIndexIds = null;
        if (migrated) {
            this._saveDirty = true;
            this._scheduleImmediateSave();
        }
        this.notify();
        await this._verifyLastActiveChatId();
    }

    // 完整加载会把指向已不存在对话的“最近活跃”改成当时选中的对话；快路径把这一步挪到补齐之后
    async _verifyLastActiveChatId() {
        const pending = this._unverifiedLastActive;
        this._unverifiedLastActive = null;
        if (!pending || this.chats.has(pending.lastActiveChatId)) return;
        const stored = (await this.storage.get(LAST_ACTIVE_CHAT_ID_KEY))[LAST_ACTIVE_CHAT_ID_KEY];
        // 期间已被改写（切换对话、发消息、其它 tab）：以新值为准
        if (stored !== pending.lastActiveChatId || this.currentChatId !== pending.chatId) return;
        await this.storage.set({ [LAST_ACTIVE_CHAT_ID_KEY]: pending.chatId });
    }

    _getIndexIds() {
        const ids = Array.from(this.chats.keys());
        if (this._allChatsLoaded || !this._storedIndexIds) return ids;
        // 补齐前 this.chats 只是子集：以读到的索引为准，再追加新建的对话，避免把索引截断
        const stored = new Set(this._storedIndexIds);
        return this._storedIndexIds.concat(ids.filter((id) => !stored.has(id)));
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
        modelSelection = this.getDefaultModelSelection?.(),
        titleLocaleBound = undefined
    } = {}) {
        const chatId = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        const chat = {
            id: chatId,
            title,
            messages: Array.isArray(messages) ? messages.map((message) => ({ ...message })) : [],
            createdAt,
            updatedAt: createdAt
        };
        if (modelSelection) chat.modelSelection = { ...modelSelection };
        if (kind) {
            chat.kind = kind;
        }
        if (typeof titleLocaleBound === 'boolean') {
            chat.titleLocaleBound = titleLocaleBound;
        }
        this.chats.set(chatId, chat);
        this._dirtyChatIds.add(chatId);
        this._indexDirty = true;
        this.saveChats({ touchCurrentChat: false });
        return chat;
    }

    setChatModel(chatId, selection) {
        const chat = this.chats.get(chatId);
        if (!chat || !selection?.configId || !selection?.modelName) return;
        if (chat.modelSelection?.configId === selection.configId && chat.modelSelection?.modelName === selection.modelName) return;
        chat.modelSelection = { configId: selection.configId, modelName: selection.modelName };
        this.markChatDirty(chatId, { touchUpdatedAt: false });
        return this.saveChats({ touchCurrentChat: false });
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
        if (!this.chats.has(chatId) && getLiveChat(chatId)) this.chats.set(chatId, getLiveChat(chatId));
        if (!this.chats.has(chatId) && !this._allChatsLoaded) {
            await this.loadAllChats();
        }
        if (!this.chats.has(chatId)) {
            throw new Error('对话不存在');
        }
        this.currentChatId = chatId;
        this._pendingCurrentChatSelection = { chatId };
        // 查看历史只保存当前选择，不修改对话内容或列表顺序。
        this.saveChats({ touchCurrentChat: false });
        return this.chats.get(chatId);
    }

    async deleteChat(chatId) {
        // 选下一个对话、回收 YouTube 字幕缓存都要看全部对话
        if (!this._allChatsLoaded) {
            await this.loadAllChats();
        }
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

        // 旧数据第一次修改时保留原排序位置；编辑、回复、重生成仍可更新 updatedAt。
        chat.lastUserMessageAt ||= chat.updatedAt || chat.createdAt || new Date(0).toISOString();
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
        let latestMatch = null;
        let latestUpdatedAt = -1;

        for (const ref of refs) {
            if (ref?.videoId !== videoId || !ref?.key) {
                continue;
            }

            const updatedAt = Number(ref?.updatedAt) || 0;
            if (updatedAt >= latestUpdatedAt) {
                latestUpdatedAt = updatedAt;
                latestMatch = ref;
            }
        }

        return latestMatch;
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
        if (message.role === 'user') currentChat.lastUserMessageAt = new Date().toISOString();
        this.markChatDirty(currentChat.id);
        if (isExtensionEnvironment) {
            // 避免调用方未 await 导致潜在的 Unhandled Promise Rejection
            void this.storage.set({ [LAST_ACTIVE_CHAT_ID_KEY]: currentChat.id }).catch(() => {});
        }
        this.saveChats({ touchCurrentChat: false });
    }

    async updateMessageAt(chatId, messageIndex, message) {
        const currentChat = this.chats.get(chatId);
        if (!currentChat) {
            throw new Error('对话不存在');
        }

        const normalizedIndex = Number(messageIndex);
        if (!Number.isInteger(normalizedIndex) || normalizedIndex < 0 || normalizedIndex >= currentChat.messages.length) {
            throw new Error('消息不存在');
        }

        currentChat.messages[normalizedIndex] = message;
        this.markChatDirty(currentChat.id);
        if (isExtensionEnvironment) {
            void this.storage.set({ [LAST_ACTIVE_CHAT_ID_KEY]: currentChat.id }).catch(() => {});
        }
        this.saveChats({ touchCurrentChat: false });
        return currentChat.messages[normalizedIndex];
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

    saveChats({ touchCurrentChat = true, throttleMs = 0 } = {}) {
        this._saveDirty = true;
        const saved = this._ensureSavePromise();

        // 兼容：部分调用方会直接 mutate currentChat.messages 后再调用 saveChats()
        if (touchCurrentChat && this.currentChatId) {
            this.markChatDirty(this.currentChatId);
        }

        this._requestSave({ throttleMs });
        this.notify();
        // Return the handled shared promise itself. An async wrapper would create
        // another rejecting promise for fire-and-forget callers.
        return saved;
    }

    /**
     * Best-effort: flush pending chat/index writes ASAP (avoid relying on requestIdleCallback).
     * Useful right after a user/assistant message is completed to reduce the chance of losing it on refresh.
     */
    async flushNow() {
        this._clearThrottledSaveTimer();
        clearTimeout(this._saveRetryTimer);
        this._saveRetryTimer = null;
        this._cancelScheduledSave();
        this._pendingSaveThrottleMs = 0;

        if (!this._saveDirty && !this._saveInProgress) return;

        // Capture before draining: a failed batch rejects and clears this field.
        // Reading it afterwards would incorrectly report a successful flush.
        const saved = this._ensureSavePromise();
        const deadline = { timeRemaining: () => Number.POSITIVE_INFINITY, didTimeout: true };
        const drain = async () => {
            while (this._saveDirty || this._saveTask) {
                this._cancelScheduledSave();
                await this._flushSave(deadline);
            }
        };
        await Promise.all([saved, drain()]);
    }

    async clearCurrentChat() {
        const currentChat = this.getCurrentChat();
        if (currentChat) {
            currentChat.messages = [];
            this._dirtyChatIds.add(currentChat.id);
            this.saveChats();
        }
    }

    _cancelScheduledSave() {
        const scheduled = this._scheduledSave;
        if (!scheduled) return;
        clearTimeout(scheduled.timer);
        if (scheduled.idleId != null && typeof cancelIdleCallback === 'function') {
            cancelIdleCallback(scheduled.idleId);
        }
        this._scheduledSave = null;
        this._saveScheduled = false;
    }

    _scheduleImmediateSave() {
        this._clearThrottledSaveTimer();
        if (this._saveScheduled) return;
        this._saveScheduled = true;
        const scheduled = { idleId: null, timer: null };
        this._scheduledSave = scheduled;

        const run = (deadline) => {
            if (this._scheduledSave !== scheduled) return;
            this._cancelScheduledSave();
            void this._flushSave(deadline).catch(() => {});
        };

        // Idle callbacks can be suspended in a hidden extension sidebar. Keep a
        // timer fallback, and let flushNow bypass both schedulers entirely.
        scheduled.timer = setTimeout(() => run(), typeof requestIdleCallback === 'function' ? 1000 : 0);
        if (typeof requestIdleCallback === 'function') {
            scheduled.idleId = requestIdleCallback(run, { timeout: 1000 });
        }
    }

    _requestSave({ throttleMs = 0 } = {}) {
        clearTimeout(this._saveRetryTimer);
        this._saveRetryTimer = null;
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

    _flushSave(deadline) {
        if (this._saveTask) return this._saveTask;
        if (!this._saveDirty) return Promise.resolve();
        this._ensureSavePromise();
        this._saveTask = this._flushSaveBatch(deadline).finally(() => {
            this._saveTask = null;
        });
        return this._saveTask;
    }

    async _flushSaveBatch(deadline) {
        this._saveInProgress = true;
        let reschedule = false;
        try {
            const shouldYield = () => {
                if (!deadline || deadline.didTimeout || typeof deadline.timeRemaining !== 'function') return false;
                return deadline.timeRemaining() < 10;
            };

            // 1) 处理删除
            if (this._pendingRemovals.size > 0 && !shouldYield()) {
                const keysToRemove = Array.from(this._pendingRemovals);
                this._pendingRemovals.clear();
                try {
                    await this.storage.remove(keysToRemove);
                } catch (error) {
                    keysToRemove.forEach(key => this._pendingRemovals.add(key));
                    throw error;
                }
            }

            // 2) 确保 v2 索引存在/更新（只存 chatId 列表，避免重复大数据）
            if (this._indexDirty && !shouldYield()) {
                this._indexDirty = false;
                try {
                    await this.storage.set({ [CHATS_INDEX_V2_KEY]: this._getIndexIds() });
                } catch (error) {
                    this._indexDirty = true;
                    throw error;
                }
            }

            // 3) 迁移：把 legacy 的 chat 逐步写入 v2（每次写一个，避免长任务）
            if (this._migrationQueue.length > 0 && !shouldYield()) {
                const migrateId = this._migrationQueue.pop();
                const chat = this.chats.get(migrateId);
                if (chat) {
                    try {
                        await this.storage.set({ [chatKeyV2(migrateId)]: chat });
                    } catch (error) {
                        this._migrationQueue.push(migrateId);
                        throw error;
                    }
                }
            }

            // 4) 正常保存：只写入被修改的 chat（避免每次写整份 77MB）
            if (this._dirtyChatIds.size > 0 && !shouldYield()) {
                const [chatId] = this._dirtyChatIds;
                this._dirtyChatIds.delete(chatId);
                const chat = this.chats.get(chatId);
                if (chat) {
                    try {
                        await this.storage.set({ [chatKeyV2(chatId)]: chat });
                    } catch (error) {
                        this._dirtyChatIds.add(chatId);
                        throw error;
                    }
                }
            }

            // 5) Persist the selection in the same retryable queue. Changing the
            // visible chat must not wait for extension storage or a blocked IDB.
            if (this._pendingCurrentChatSelection && !shouldYield()) {
                const selection = this._pendingCurrentChatSelection;
                this._pendingCurrentChatSelection = null;
                try {
                    await this._resolveCurrentChatIdStorageKey();
                    await this.storage.set({
                        [this._currentChatIdStorageKey]: selection.chatId,
                        ...(isExtensionEnvironment ? { [LAST_ACTIVE_CHAT_ID_KEY]: selection.chatId } : {})
                    });
                } catch (error) {
                    this._pendingCurrentChatSelection ||= selection;
                    throw error;
                }
            }

            // 迁移完成后，尝试清理 legacy 大对象（如果存在）；补齐前还不知道有没有分片要从它补
            if (!this._legacyCleanupDone && this._allChatsLoaded && this._migrationQueue.length === 0) {
                // 注意：remove 是幂等的；如果 legacy 已不存在也没关系
                this._legacyCleanupDone = true;
                await this.storage.remove(LEGACY_CHATS_KEY).catch(() => {});
            }

            // 如果还有待处理工作，继续调度；否则完成本次保存
            this._saveDirty = this._pendingRemovals.size > 0 ||
                this._indexDirty ||
                this._migrationQueue.length > 0 ||
                this._dirtyChatIds.size > 0 ||
                this._pendingCurrentChatSelection !== null;

            if (!this._saveDirty) {
                this._saveRetryAttempt = 0;
                this._savePromiseResolve?.();
                this._savePromise = null;
                this._savePromiseResolve = null;
                this._savePromiseReject = null;
                this._pendingSaveThrottleMs = null;
            } else {
                reschedule = true;
            }
        } catch (err) {
            console.error('保存对话失败:', err);
            this._clearThrottledSaveTimer();
            this._pendingSaveThrottleMs = null;
            this._savePromiseReject?.(err);
            this._savePromise = null;
            this._savePromiseResolve = null;
            this._savePromiseReject = null;
            // Keep unsaved work in memory and retry with backoff. A later edit or
            // explicit flush can retry sooner without losing this failed batch.
            this._cancelScheduledSave();
            const delay = Math.min(1000 * 2 ** this._saveRetryAttempt, 30000);
            this._saveRetryAttempt = Math.min(this._saveRetryAttempt + 1, 5);
            clearTimeout(this._saveRetryTimer);
            this._saveRetryTimer = setTimeout(() => {
                this._saveRetryTimer = null;
                this._scheduleImmediateSave();
            }, delay);
            throw err;
        } finally {
            this._saveInProgress = false;
            if (reschedule) {
                const throttleMs = this._pendingSaveThrottleMs;
                this._pendingSaveThrottleMs = null;
                this._requestSave({ throttleMs });
            }
        }
    }
}

// 创建并导出单例实例
export const chatManager = new ChatManager();
