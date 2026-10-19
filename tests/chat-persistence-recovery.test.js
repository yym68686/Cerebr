import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => new Map());
vi.mock('../src/utils/storage-adapter.js', () => ({
    isExtensionEnvironment: false,
    browserAdapter: {},
    storageAdapter: {
        get: async (keys) => Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(memory.get(key))])
        ),
        set: vi.fn(async (data) => {
            for (const [key, value] of Object.entries(data)) memory.set(key, structuredClone(value));
        }),
        remove: vi.fn(async (keys) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) memory.delete(key);
        }),
    },
}));
vi.mock('../src/utils/default-chat.js', () => ({
    DEFAULT_CHAT_KIND: 'default',
    buildDefaultChatSeedMessages: () => [],
    getDefaultChatTitle: () => 'Default',
    resolveDefaultChatLocale: async () => 'en',
}));
import { ChatManager, chatManager } from '../src/domain/chat/chat-store.js';
import { storageAdapter } from '../src/utils/storage-adapter.js';

const indexKey = 'cerebr_chats_index_v2';
const chatKey = 'cerebr_chat_v2_saved';
let manager;
beforeAll(async () => {
    await chatManager.initialize();
    await chatManager.flushNow();
});
beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', vi.fn(() => 1));
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    memory.clear();
    memory.set(indexKey, ['saved']);
    memory.set('cerebr_current_chat_id', 'saved');
    memory.set(chatKey, { id: 'saved', messages: [{ role: 'assistant', content: 'old' }] });
    manager = new ChatManager();
    await manager.initialize();
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('chat persistence recovery', () => {
    it('switches chats immediately and retries failed selection writes', async () => {
        manager.chats.set('other', { id: 'other', messages: [] });
        manager._indexDirty = true;
        await manager.switchChat('other');
        expect(manager.currentChatId).toBe('other');
        expect(memory.get('cerebr_current_chat_id')).toBe('saved');
        const failure = new Error('Selection write failed');
        const write = storageAdapter.set.getMockImplementation();
        storageAdapter.set.mockImplementation(async (data) => {
            if ('cerebr_current_chat_id' in data) throw failure;
            await write(data);
        });
        await expect(manager.flushNow()).rejects.toBe(failure);
        expect(manager.getCurrentChat().id).toBe('other');
        storageAdapter.set.mockImplementation(write);
        await manager.flushNow();
        expect(memory.get('cerebr_current_chat_id')).toBe('other');
    });

    it('falls back to a timer when the browser never invokes idle callbacks', async () => {
        manager.getCurrentChat().messages[0].content = 'complete answer';
        const saved = manager.saveChats();
        await vi.advanceTimersByTimeAsync(1000);
        await saved;
        expect(memory.get(chatKey).messages[0].content).toBe('complete answer');
    });

    it('automatically retries a transient failure without another user action', async () => {
        manager.getCurrentChat().messages[0].content = 'complete answer';
        const failure = new Error('Storage temporarily unavailable');
        const saved = manager.saveChats();
        const rejected = saved.catch(error => error);
        storageAdapter.set.mockRejectedValueOnce(failure);
        await vi.advanceTimersByTimeAsync(1000);
        expect(await rejected).toBe(failure);
        await vi.advanceTimersByTimeAsync(2000);
        expect(memory.get(chatKey).messages[0].content).toBe('complete answer');
        expect(manager._saveDirty).toBe(false);
    });

    it('preserves edits arriving during an in-flight write and drains concurrent flushes', async () => {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const write = storageAdapter.set.getMockImplementation();
        storageAdapter.set.mockImplementationOnce(async (data) => {
            const snapshot = structuredClone(data);
            await gate;
            await write(snapshot);
        });
        manager.getCurrentChat().messages[0].content = 'partial';
        const saved = manager.saveChats();
        const first = manager.flushNow();
        manager.getCurrentChat().messages[0].content = 'complete answer';
        const updated = manager.saveChats();
        const second = manager.flushNow();
        release();
        await Promise.all([saved, updated, first, second]);
        expect(memory.get(chatKey).messages[0].content).toBe('complete answer');
        expect(manager._saveInProgress).toBe(false);
        expect(manager._saveTask).toBe(null);
    });

    it('flushes completed replies even when the idle callback never runs', async () => {
        manager.getCurrentChat().messages[0].content = 'complete answer';
        const saved = manager.saveChats();
        await manager.flushNow();
        await saved;
        expect(memory.get(chatKey).messages[0].content).toBe('complete answer');
    });

    it('rejects a failed flush and retries the same dirty chat without another edit', async () => {
        const failure = new Error('Transient write failure');
        manager.getCurrentChat().messages[0].content = 'complete answer';
        const saved = manager.saveChats();
        const rejected = expect(saved).rejects.toBe(failure);
        storageAdapter.set.mockRejectedValueOnce(failure);
        await expect(manager.flushNow()).rejects.toBe(failure);
        await rejected;
        expect(memory.get(chatKey).messages[0].content).toBe('old');
        await manager.flushNow();
        expect(memory.get(chatKey).messages[0].content).toBe('complete answer');
    });

    it('retains a failed index update for the next flush', async () => {
        manager.chats.set('new', { id: 'new', messages: [] });
        manager._indexDirty = true;
        const saved = manager.saveChats({ touchCurrentChat: false });
        const failure = new Error('Index write failed');
        const rejected = expect(saved).rejects.toBe(failure);
        storageAdapter.set.mockRejectedValueOnce(failure);
        await expect(manager.flushNow()).rejects.toBe(failure);
        await rejected;
        await manager.flushNow();
        expect(memory.get(indexKey)).toEqual(['saved', 'new']);
    });

    it('retains failed removals for the next flush', async () => {
        manager._pendingRemovals.add('cerebr_chat_v2_deleted');
        memory.set('cerebr_chat_v2_deleted', { id: 'deleted' });
        const saved = manager.saveChats({ touchCurrentChat: false });
        const failure = new Error('Remove failed');
        const rejected = expect(saved).rejects.toBe(failure);
        storageAdapter.remove.mockRejectedValueOnce(failure);
        await expect(manager.flushNow()).rejects.toBe(failure);
        await rejected;
        await manager.flushNow();
        expect(memory.has('cerebr_chat_v2_deleted')).toBe(false);
    });

    it('retains a failed migration and its legacy copy until the write succeeds', async () => {
        const legacy = [{ id: 'legacy', messages: [{ role: 'assistant', content: 'keep me' }] }];
        memory.set('cerebr_chats', legacy);
        manager.chats.set('legacy', legacy[0]);
        manager._migrationQueue.push('legacy');
        manager._allChatsLoaded = true;
        const saved = manager.saveChats({ touchCurrentChat: false });
        const failure = new Error('Migration failed');
        const rejected = expect(saved).rejects.toBe(failure);
        storageAdapter.set.mockRejectedValueOnce(failure);
        await expect(manager.flushNow()).rejects.toBe(failure);
        await rejected;
        expect(memory.get('cerebr_chats')).toEqual(legacy);
        await manager.flushNow();
        expect(memory.get('cerebr_chat_v2_legacy')).toEqual(legacy[0]);
        expect(memory.has('cerebr_chats')).toBe(false);
    });
});
