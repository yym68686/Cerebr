import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => new Map());
const state = vi.hoisted(() => ({ extension: false, gets: [], sets: [], beforeGet: null }));
vi.mock('../src/utils/storage-adapter.js', () => ({
    get isExtensionEnvironment() {
        return state.extension;
    },
    browserAdapter: { getCurrentTab: async () => ({ id: 7 }) },
    storageAdapter: {
        get: async (keys) => {
            const list = Array.isArray(keys) ? keys : [keys];
            state.gets.push(list);
            await state.beforeGet?.(list);
            return Object.fromEntries(list.map((k) => [k, structuredClone(memory.get(k))]));
        },
        set: async (data) => {
            state.sets.push(Object.keys(data));
            for (const [k, v] of Object.entries(data)) memory.set(k, structuredClone(v));
        },
        remove: async (keys) => {
            for (const k of Array.isArray(keys) ? keys : [keys]) memory.delete(k);
        },
    },
}));
vi.mock('../src/utils/default-chat.js', () => ({
    DEFAULT_CHAT_KIND: 'default',
    buildDefaultChatSeedMessages: () => [],
    getDefaultChatTitle: () => 'Default',
    resolveDefaultChatLocale: async () => 'en',
}));
import { ChatManager, chatManager } from '../src/domain/chat/chat-store.js';

const INDEX = 'cerebr_chats_index_v2';
const LEGACY_CHATS = 'cerebr_chats';
const LEGACY_CURRENT = 'cerebr_current_chat_id';
const TAB = 'cerebr_current_chat_id_v1_tab_7';
const LAST_ACTIVE = 'cerebr_last_active_chat_id_v1';
const chatKey = (id) => `cerebr_chat_v2_${id}`;
const makeChat = (id, minutesAgo, content = id) => {
    const time = new Date(Date.UTC(2026, 0, 1) - minutesAgo * 60000).toISOString();
    return { id, title: id, messages: [{ role: 'user', content }], createdAt: time, updatedAt: time };
};
// 索引顺序与时间顺序不同，才能看出 Map 顺序是否和一次性完整加载一致
const CHATS = [
    makeChat('c2', 40),
    makeChat('c5', 10),
    makeChat('c1', 50),
    makeChat('c4', 20),
    makeChat('c3', 30),
];
const INDEX_ORDER = CHATS.map((c) => c.id);

function seed({ index = INDEX_ORDER, missing = [], legacy = null, mismatch = null, ...keys } = {}) {
    for (const chat of CHATS) {
        if (missing.includes(chat.id)) continue;
        memory.set(chatKey(chat.id), chat.id === mismatch ? { ...chat, id: `${chat.id}x` } : chat);
    }
    memory.set(INDEX, index);
    if (legacy) memory.set(LEGACY_CHATS, legacy);
    for (const [k, v] of Object.entries(keys)) if (v !== undefined) memory.set(k, v);
}
// 一次读两条以上对话分片的，就是补齐全部对话的那次批量读取
const isBulkRead = (keys) => keys.filter((k) => k.startsWith('cerebr_chat_v2_')).length > 1;
const bulkReads = () => state.gets.filter(isBulkRead);

const managers = [];
async function openManager(Manager = ChatManager) {
    const manager = new Manager();
    managers.push(manager);
    await manager.initialize();
    return manager;
}
// 参照：不走快路径，首次初始化就一次性读全部对话（改动前的行为）
class FullLoadManager extends ChatManager {
    async _loadCurrentChatOnly() {
        return false;
    }
}
function gateBulkRead() {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    state.beforeGet = (keys) => (isBulkRead(keys) ? gate : undefined);
    return () => release();
}

beforeAll(async () => {
    await chatManager.initialize();
    await chatManager.flushNow();
});
beforeEach(() => {
    memory.clear();
    state.extension = false;
    state.gets.length = 0;
    state.sets.length = 0;
    state.beforeGet = null;
});
afterEach(async () => {
    state.beforeGet = null;
    await Promise.all(managers.splice(0).map((manager) => manager.flushNow()));
});

describe('首次打开只加载当前对话', () => {
    it('只读当前对话就完成初始化，补齐后与索引顺序一致', async () => {
        seed({ [LEGACY_CURRENT]: 'c3' });
        const manager = await openManager();
        expect(manager.currentChatId).toBe('c3');
        expect([...manager.chats.keys()]).toEqual(['c3']);
        expect(manager.allChatsLoaded).toBe(false);
        expect(bulkReads()).toHaveLength(0);

        const current = manager.getCurrentChat();
        await manager.loadAllChats();
        expect(manager.allChatsLoaded).toBe(true);
        expect([...manager.chats.keys()]).toEqual(INDEX_ORDER);
        expect(manager.getCurrentChat()).toBe(current);
        expect(bulkReads()).toHaveLength(1);
        expect(bulkReads()[0]).not.toContain(chatKey('c3'));
    });

    it('补齐后的内存与存储和一次性完整加载完全相同', async () => {
        const scenarios = [];
        for (const extension of [false, true])
            for (const tab of [undefined, 'c3', 'c4', 'zz'])
                for (const lastActive of extension ? [undefined, 'c3', 'c2', 'c4', 'zz'] : [undefined])
                    for (const legacyCurrent of extension ? [undefined, 'c1'] : [undefined])
                        for (const missing of [[], ['c4']])
                            for (const legacy of [
                                null,
                                [makeChat('c4', 20, 'legacy'), makeChat('c1', 50, 'legacy')],
                            ])
                                for (const mismatch of [null, 'c2'])
                                    for (const index of [INDEX_ORDER, [...INDEX_ORDER, 'c5']])
                                        scenarios.push({
                                            extension,
                                            tab,
                                            lastActive,
                                            legacyCurrent,
                                            missing,
                                            legacy,
                                            mismatch,
                                            index,
                                        });

        const run = async (Manager, { extension, tab, lastActive, legacyCurrent, ...data }) => {
            memory.clear();
            state.extension = extension;
            seed(
                extension
                    ? { ...data, [TAB]: tab, [LAST_ACTIVE]: lastActive, [LEGACY_CURRENT]: legacyCurrent }
                    : { ...data, [LEGACY_CURRENT]: tab }
            );
            const manager = await openManager(Manager);
            const partial = !manager.allChatsLoaded;
            await manager.loadAllChats();
            await manager.flushNow();
            return [
                partial,
                {
                    current: manager.currentChatId,
                    order: [...manager.chats.keys()],
                    chats: structuredClone(Object.fromEntries(manager.chats)),
                    storage: Object.fromEntries(memory),
                },
            ];
        };

        const mismatches = [];
        let fastPathTaken = 0;
        for (const scenario of scenarios) {
            const [partial, lazy] = await run(ChatManager, scenario);
            const [, full] = await run(FullLoadManager, scenario);
            if (partial) fastPathTaken += 1;
            try {
                expect(lazy).toEqual(full);
            } catch {
                mismatches.push(JSON.stringify({ ...scenario, legacy: !!scenario.legacy }));
            }
        }
        expect(mismatches).toEqual([]);
        // 确认大部分场景确实走了快路径，而不是都回退成了完整加载
        expect(fastPathTaken).toBeGreaterThan(scenarios.length / 3);
    });

    it('没有可用的当前对话、分片缺失或内容对不上时，直接完整加载', async () => {
        for (const data of [
            { [LEGACY_CURRENT]: 'zz' },
            { [LEGACY_CURRENT]: 'c4', missing: ['c4'] },
            { [LEGACY_CURRENT]: 'c3', mismatch: 'c3' },
            {},
        ]) {
            memory.clear();
            seed(data);
            const manager = await openManager();
            expect(manager.allChatsLoaded).toBe(true);
            expect(manager.chats.size).toBeGreaterThan(1);
        }
    });

    it('并发调用 loadAllChats 只读取一次', async () => {
        seed({ [LEGACY_CURRENT]: 'c3' });
        const manager = new ChatManager();
        managers.push(manager);
        await Promise.all([manager.loadAllChats(), manager.loadAllChats(), manager.initialize()]);
        await manager.loadAllChats();
        expect(manager.allChatsLoaded).toBe(true);
        expect([...manager.chats.keys()]).toEqual(INDEX_ORDER);
        expect(bulkReads()).toHaveLength(1);
    });
});

describe('补齐之前的操作', () => {
    it('新建对话写索引时保留尚未读入的对话', async () => {
        seed({ [LEGACY_CURRENT]: 'c3' });
        const manager = await openManager();
        const created = manager.createChat({ title: 'new' });
        await manager.flushNow();
        expect(memory.get(INDEX)).toEqual([...INDEX_ORDER, created.id]);

        await manager.loadAllChats();
        expect([...manager.chats.keys()]).toEqual([...INDEX_ORDER, created.id]);
        expect(manager.getAllChats()).toHaveLength(6);
    });

    it('补齐期间对当前对话的修改不会被存储里的旧版本覆盖', async () => {
        seed({ [LEGACY_CURRENT]: 'c3' });
        const manager = await openManager();
        const current = manager.getCurrentChat();
        const release = gateBulkRead();
        const loading = manager.loadAllChats();
        await vi.waitFor(() => expect(bulkReads()).toHaveLength(1));
        await manager.addMessageToCurrentChat({ role: 'assistant', content: 'during load' });
        release();
        await loading;

        expect(manager.getCurrentChat()).toBe(current);
        expect(current.messages.at(-1).content).toBe('during load');
        await manager.flushNow();
        expect(memory.get(chatKey('c3')).messages.at(-1).content).toBe('during load');
    });

    it('删除当前对话时先补齐，再切到剩余对话里最新的', async () => {
        seed({ [LEGACY_CURRENT]: 'c3' });
        const manager = await openManager();
        await manager.deleteChat('c3');
        expect(manager.currentChatId).toBe('c5');
        expect([...manager.chats.keys()]).toEqual(INDEX_ORDER.filter((id) => id !== 'c3'));
        await manager.flushNow();
        expect(memory.get(INDEX)).toEqual(INDEX_ORDER.filter((id) => id !== 'c3'));
        expect(memory.has(chatKey('c3'))).toBe(false);
    });

    it('可以切换到还没读入的对话', async () => {
        seed({ [LEGACY_CURRENT]: 'c3' });
        const manager = await openManager();
        await manager.switchChat('c1');
        expect(manager.currentChatId).toBe('c1');
        expect(manager.allChatsLoaded).toBe(true);
        await expect(manager.switchChat('zz')).rejects.toThrow('对话不存在');
    });

    it('重新初始化（切换 tab）时先补齐，顺序与完整加载一致', async () => {
        seed({ [LEGACY_CURRENT]: 'c3' });
        const manager = await openManager();
        await manager.initialize();
        expect(manager.allChatsLoaded).toBe(true);
        expect(manager.currentChatId).toBe('c3');
        expect([...manager.chats.keys()]).toEqual(INDEX_ORDER);
    });

    it('补齐前不清理 legacy 存储，补齐后迁移缺失的分片再清理', async () => {
        const legacyC4 = makeChat('c4', 20, 'legacy');
        seed({ [LEGACY_CURRENT]: 'c3', missing: ['c4'], legacy: [legacyC4] });
        const manager = await openManager();
        await manager.addMessageToCurrentChat({ role: 'assistant', content: 'saved before load' });
        await manager.flushNow();
        expect(memory.get(LEGACY_CHATS)).toEqual([legacyC4]);

        await manager.loadAllChats();
        expect(manager.chats.get('c4')).toEqual(legacyC4);
        await manager.flushNow();
        expect(memory.get(chatKey('c4'))).toEqual(legacyC4);
        expect(memory.has(LEGACY_CHATS)).toBe(false);
    });
});

describe('扩展环境的当前对话记录', () => {
    beforeEach(() => {
        state.extension = true;
    });

    it('tab 记录与最近活跃都有效时不写存储', async () => {
        seed({ [TAB]: 'c3', [LAST_ACTIVE]: 'c2' });
        const manager = await openManager();
        expect(manager.currentChatId).toBe('c3');
        await manager.loadAllChats();
        expect(state.sets).toEqual([]);
        expect(memory.get(LAST_ACTIVE)).toBe('c2');
    });

    it('新 tab 打开最近活跃的对话并记下 tab 维度的选择', async () => {
        seed({ [LAST_ACTIVE]: 'c2' });
        const manager = await openManager();
        expect(manager.currentChatId).toBe('c2');
        expect(manager.allChatsLoaded).toBe(false);
        expect(memory.get(TAB)).toBe('c2');
        expect(memory.get(LAST_ACTIVE)).toBe('c2');
    });

    it('最近活跃指向已丢失的对话时，补齐后改指向当前对话', async () => {
        seed({ [TAB]: 'c3', [LAST_ACTIVE]: 'c4', missing: ['c4'] });
        const manager = await openManager();
        expect(manager.currentChatId).toBe('c3');
        expect(memory.get(LAST_ACTIVE)).toBe('c4');
        await manager.loadAllChats();
        expect(memory.get(LAST_ACTIVE)).toBe('c3');
    });

    it('补齐前最近活跃已被改写时保留新值', async () => {
        seed({ [TAB]: 'c3', [LAST_ACTIVE]: 'c4', missing: ['c4'] });
        const otherTab = await openManager();
        memory.set(LAST_ACTIVE, 'c2');
        await otherTab.loadAllChats();
        expect(memory.get(LAST_ACTIVE)).toBe('c2');

        memory.clear();
        seed({ [TAB]: 'c3', [LAST_ACTIVE]: 'c4', missing: ['c4'] });
        const switched = await openManager();
        const created = switched.createNewChat('new');
        await switched.switchChat(created.id);
        await switched.loadAllChats();
        await switched.flushNow();
        expect(memory.get(LAST_ACTIVE)).toBe(created.id);
    });
});

describe('对话列表按新提问排序', () => {
    const order = (manager) => manager.getAllChats().map((chat) => chat.id);
    const originalOrder = ['c5', 'c4', 'c3', 'c2', 'c1'];
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
    });
    afterEach(() => vi.useRealTimers());

    it.each([false, true])('切换只保存选择，刷新后也不改变顺序（extension=%s）', async (extension) => {
        state.extension = extension;
        seed(extension ? { [TAB]: 'c3', [LAST_ACTIVE]: 'c3' } : { [LEGACY_CURRENT]: 'c3' });
        const manager = await openManager();
        await manager.switchChat('c1');
        expect(order(manager)).toEqual(originalOrder);
        await manager.flushNow();
        expect(memory.get(extension ? TAB : LEGACY_CURRENT)).toBe('c1');
        if (extension) expect(memory.get(LAST_ACTIVE)).toBe('c1');
        expect(state.sets.flat()).not.toContain(chatKey('c1'));
        expect(memory.get(chatKey('c1'))).toEqual(CHATS.find((chat) => chat.id === 'c1'));

        const reloaded = await openManager();
        await reloaded.loadAllChats();
        expect(reloaded.currentChatId).toBe('c1');
        expect(order(reloaded)).toEqual(originalOrder);
    });

    it('旧对话的回复、编辑、重命名和普通保存都不改变顺序', async () => {
        seed({ [LEGACY_CURRENT]: 'c1' });
        const manager = await openManager();
        await manager.loadAllChats();
        await manager.updateLastMessage('c1', { content: 'continued answer' });
        await manager.updateMessageAt('c1', 0, { role: 'user', content: 'edited question' });
        manager.renameChat('c1', 'Renamed');
        await manager.addMessageToCurrentChat({ role: 'assistant', content: 'completed answer' });
        manager.getCurrentChat().messages.at(-1).content = 'saved answer';
        manager.saveChats();
        expect(order(manager)).toEqual(originalOrder);
        await manager.flushNow();

        const reloaded = await openManager();
        await reloaded.loadAllChats();
        expect(order(reloaded)).toEqual(originalOrder);
        expect(reloaded.getCurrentChat().title).toBe('Renamed');
        expect(reloaded.getCurrentChat().messages.at(-1).content).toBe('saved answer');
    });

    it('发送新问题时移到顶部，较早问题的后续回复不会再次抢到顶部', async () => {
        seed({ [LEGACY_CURRENT]: 'c3' });
        const manager = await openManager();
        await manager.switchChat('c1');
        await manager.addMessageToCurrentChat({ role: 'user', content: 'First new question' });
        expect(order(manager)).toEqual(['c1', 'c5', 'c4', 'c3', 'c2']);
        vi.setSystemTime(new Date('2026-10-20T00:01:00Z'));
        await manager.switchChat('c2');
        await manager.addMessageToCurrentChat({ role: 'user', content: 'Second new question' });
        vi.setSystemTime(new Date('2026-10-20T00:02:00Z'));
        await manager.updateLastMessage('c1', { content: 'Late answer' });
        await manager.flushNow();
        const reloaded = await openManager();
        await reloaded.loadAllChats();
        expect(order(reloaded)).toEqual(['c2', 'c1', 'c5', 'c4', 'c3']);
    });

    it('新建空对话显示在顶部，之前查看的旧对话保持原位置', async () => {
        seed({ [LEGACY_CURRENT]: 'c1' });
        const manager = await openManager();
        await manager.loadAllChats();
        const created = manager.createNewChat('New chat');
        await manager.switchChat(created.id);
        expect(order(manager)).toEqual([created.id, ...originalOrder]);
    });
});
