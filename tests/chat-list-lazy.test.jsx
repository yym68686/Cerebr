import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

// 在导入前写好存储，模块加载时创建的单例就会走“只读当前对话”的快路径
const { memory, bulk } = vi.hoisted(() => {
    const memory = new Map();
    const time = (minutesAgo) => new Date(Date.UTC(2026, 0, 1) - minutesAgo * 60000).toISOString();
    const ids = ['c2', 'c5', 'c1', 'c4', 'c3'];
    const minutesAgo = { c2: 40, c5: 10, c1: 50, c4: 20, c3: 30 };
    for (const id of ids) {
        const at = time(minutesAgo[id]);
        memory.set(`cerebr_chat_v2_${id}`, { id, title: id, messages: [], createdAt: at, updatedAt: at });
    }
    memory.set('cerebr_chats_index_v2', ids);
    memory.set('cerebr_current_chat_id', 'c3');
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    return { memory, bulk: { reads: 0, gate, release: () => release() } };
});
vi.mock('../src/utils/storage-adapter.js', () => ({
    isExtensionEnvironment: false,
    browserAdapter: {},
    storageAdapter: {
        get: async (keys) => {
            const list = Array.isArray(keys) ? keys : [keys];
            if (list.filter((k) => k.startsWith('cerebr_chat_v2_')).length > 1) {
                bulk.reads += 1;
                await bulk.gate;
            }
            return Object.fromEntries(list.map((k) => [k, structuredClone(memory.get(k))]));
        },
        set: async (data) => {
            for (const [k, v] of Object.entries(data)) memory.set(k, structuredClone(v));
        },
        remove: async () => {},
    },
}));
vi.mock('../src/utils/default-chat.js', () => ({
    DEFAULT_CHAT_KIND: 'default',
    buildDefaultChatSeedMessages: () => [],
    getDefaultChatTitle: () => 'Default',
    resolveDefaultChatLocale: async () => 'en',
}));
vi.mock('../src/utils/i18n.js', () => ({ t: (key) => key }));
vi.mock('../src/app/components/Messages.jsx', () => ({ contentText: (content) => String(content ?? '') }));
import { chatManager } from '../src/domain/chat/chat-store.js';
import { ChatNavigation } from '../src/app/components/ChatNavigation.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

it('其余对话补齐前不列出也不显示空状态，打开列表时触发补齐', async () => {
    await vi.waitFor(() => expect(chatManager.currentChatId).toBe('c3'));
    expect(chatManager.allChatsLoaded).toBe(false);

    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = (visible) =>
        act(async () =>
            root.render(
                <ChatNavigation
                    wide={visible}
                    open={false}
                    session={{}}
                    onClose={() => {}}
                    onNavigate={() => {}}
                />
            )
        );

    await render(false);
    expect(bulk.reads).toBe(0);

    await render(true);
    expect(bulk.reads).toBe(1);
    expect(host.querySelectorAll('[data-chat-id]')).toHaveLength(0);
    expect(host.querySelector('.navigation-folder-empty')).toBeNull();

    await act(async () => {
        bulk.release();
        await chatManager.loadAllChats();
        await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const cards = [...host.querySelectorAll('[data-chat-id]')];
    expect(cards.map((card) => card.dataset.chatId)).toEqual(['c5', 'c4', 'c3', 'c2', 'c1']);
    expect(host.querySelector('.navigation-item.is-active').dataset.chatId).toBe('c3');
    expect(host.querySelector('.navigation-folder-empty')).toBeNull();
    expect(bulk.reads).toBe(1);

    await act(async () => root.unmount());
    host.remove();
});
