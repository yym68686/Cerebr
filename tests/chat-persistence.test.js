import { describe, expect, it, vi } from 'vitest';
const memory = vi.hoisted(() => new Map());
vi.mock('../src/utils/storage-adapter.js', () => ({
    isExtensionEnvironment: false,
    browserAdapter: {},
    storageAdapter: {
        get: async (keys) =>
            Object.fromEntries(
                (Array.isArray(keys) ? keys : [keys]).map((k) => [k, structuredClone(memory.get(k))])
            ),
        set: async (data) => {
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
describe('chat persistence under idle scheduling', () => {
    it('persists a background question without consuming the newer blank draft', async () => {
        const manager = new ChatManager();
        await manager.initialize();
        const first = manager.createNewChat('First');
        const second = manager.createChat({ title: 'Second', persist: false });
        await manager.switchChat(second.id);
        await manager.addMessageToChat(first.id, { role: 'user', content: 'Background question' });
        await manager.flushNow();
        expect(manager.currentChatId).toBe(second.id);
        expect(manager.createNewChat().id).toBe(second.id);
        expect(manager.getAllChats().some(chat => chat.id === first.id)).toBe(true);
        expect(manager.getAllChats().some(chat => chat.id === second.id)).toBe(false);
        expect(memory.get(manager._newChatStorageKey()).id).toBe(second.id);
    });
    it('reschedules a yielded write and persists edits before a reload', async () => {
        await chatManager.initialize();
        await chatManager.flushNow();
        const callbacks = [];
        vi.stubGlobal('requestIdleCallback', (cb) => {
            callbacks.push(cb);
            return callbacks.length;
        });
        const manager = new ChatManager();
        await manager.initialize();
        await manager.flushNow();
        const chat = manager.getCurrentChat();
        await manager.addMessageToCurrentChat({ role: 'user', content: 'before' });
        await manager.flushNow();
        await manager.updateMessageAt(chat.id, 0, { role: 'user', content: 'edited' });
        callbacks.length = 0;
        manager._saveScheduled = false;
        await manager._flushSave({ timeRemaining: () => 0, didTimeout: false });
        expect(callbacks.length).toBe(1);
        await manager._flushSave({ timeRemaining: () => 0, didTimeout: true });
        expect(memory.get(`cerebr_chat_v2_${chat.id}`).messages[0].content).toBe('edited');
        const reloaded = new ChatManager();
        await reloaded.initialize();
        expect(reloaded.getCurrentChat().messages[0].content).toBe('edited');
        vi.unstubAllGlobals();
    });
});
