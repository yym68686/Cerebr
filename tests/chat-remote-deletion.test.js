import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ data: new Map(), handlers: [] }));
vi.mock('../src/utils/storage-adapter.js', () => ({
    isExtensionEnvironment: false, browserAdapter: {},
    storageAdapter: {
        get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(state.data.get(key))])),
        set: async values => { for (const [key, value] of Object.entries(values)) state.data.set(key, structuredClone(value)); },
        remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) state.data.delete(key); },
    },
}));
vi.mock('../src/runtime/sync/replica.js', () => ({ subscribeRemoteChanges: fn => { state.handlers.push(fn); return () => {}; } }));
vi.mock('../src/utils/default-chat.js', () => ({
    DEFAULT_CHAT_KIND: 'default', buildDefaultChatSeedMessages: () => [], getDefaultChatTitle: () => 'Default', resolveDefaultChatLocale: async () => 'en',
}));
import { ChatManager, chatManager } from '../src/domain/chat/chat-store.js';

it('applies remote deletion before flushing a dirty chat and falls back to existing unloaded history', async () => {
    await chatManager.initialize(); await chatManager.flushNow();
    state.data.clear();
    const key = 'cerebr_chat_v2_default';
    state.data.set('cerebr_current_chat_id', 'default');
    state.data.set('cerebr_chats_index_v2', ['default', 'other']);
    state.data.set(key, { id: 'default', title: 'Default', messages: [] });
    state.data.set('cerebr_chat_v2_other', { id: 'other', title: 'Other', messages: [{role:'user',content:'Existing history'}], updatedAt: new Date().toISOString() });
    vi.stubGlobal('requestIdleCallback', () => 1);
    vi.stubGlobal('cancelIdleCallback', () => {});
    const manager = new ChatManager();
    try {
        await manager.initialize();
        expect(manager.allChatsLoaded).toBe(false);
        const saved = manager.saveChats();
        state.data.delete(key);
        state.data.set('cerebr_chats_index_v2', ['other']);
        state.handlers.at(-1)([key]);
        await manager._remoteQueue;
        await saved;
        expect(state.data.has(key)).toBe(false);
        expect([...manager.chats.keys()]).toEqual(['other']);
        expect(manager.currentChatId).toBe('other');
        expect(manager._dirtyChatIds.has('default')).toBe(false);
    } finally { await manager.flushNow(); vi.unstubAllGlobals(); }
});
