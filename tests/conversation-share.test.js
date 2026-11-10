import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { webcrypto } from 'node:crypto';
const state = vi.hoisted(() => ({ chats: new Map() }));
vi.mock('../src/domain/chat/chat-store.js', () => ({
    chatManager: {
        chats: state.chats,
        loadAllChats: async () => {},
        flushNow: async () => {},
        notify: vi.fn(),
        getDefaultModelSelection: () => ({ configId: 'recipient-api', modelName: 'recipient-model' }),
        markChatDirty: vi.fn(),
        saveChats: vi.fn(),
    },
}));
vi.mock('../src/runtime/sync/cloud-sync.js', () => ({ CLOUD_SYNC_URL: 'https://cerebr-sync.fugue.pro' }));
const id = 'a'.repeat(48),
    otherId = 'b'.repeat(48);
let service, storage, getDb, snapshot, fetcher;
beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    vi.stubGlobal('crypto', webcrypto);
    state.chats.clear();
    ({ storageAdapter: storage, getDb } = await import('../src/utils/storage-adapter.js'));
    service = await import('../src/runtime/chat/conversation-share.js');
    snapshot = {
        version: 1,
        chat: {
            title: 'Shared',
            apiKey: 'private',
            modelSelection: { configId: 'private' },
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'PDF text' },
                        { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } },
                    ],
                    textFiles: [
                        {
                            id: 'pdf',
                            name: 'paper.pdf',
                            size: 3,
                            textLength: 3,
                            originalPdf: 'data:application/pdf;base64,YWJj',
                        },
                    ],
                    selectionQuotes: ['quotation'],
                    selectionQuestion: 'question',
                    apiKey: 'private',
                },
                {
                    role: 'assistant',
                    content: 'answer',
                    reasoning_content: 'reasoning',
                    requestId: 'private',
                },
            ],
        },
        pages: [
            {
                url: 'https://example.test/',
                title: 'Article',
                content: 'Cached text',
                tabId: 123,
                isCurrent: true,
            },
        ],
    };
    fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ shareId: id, snapshot }) }));
    vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

it('uses hash links on either host and preserves project subpaths', () => {
    expect(service.shareUrl(id, 'https://cerebr.yym68686.top/?secret=x')).toBe(
        `https://cerebr.yym68686.top/#/share/${id}`
    );
    expect(service.shareUrl(id, 'https://yym68686.github.io/Cerebr/index.html')).toBe(
        `https://yym68686.github.io/Cerebr/index.html#/share/${id}`
    );
    expect(service.shareUrl(id, 'chrome-extension://extension/index.html')).toBe(
        `https://cerebr.fugue.pro/#/share/${id}`
    );
    expect(service.shareIdFromHash(`#/share/${id}`)).toBe(id);
    expect(service.shareIdFromHash('#/share/private-chat-id')).toBe(null);
});

it('imports documents and webpage caches atomically into synced records, using the recipient model', async () => {
    const chatId = await service.importConversation(id),
        key = `cerebr_chat_v2_${chatId}`;
    const chat = (await storage.get(key))[key];
    expect(chat.modelSelection).toEqual({ configId: 'recipient-api', modelName: 'recipient-model' });
    expect(chat.apiKey).toBeUndefined();
    expect(chat.messages[0].apiKey).toBeUndefined();
    expect(chat.messages[1].requestId).toBeUndefined();
    expect(chat.messages[0].textFiles[0].originalPdf).toBe('data:application/pdf;base64,YWJj');
    expect(chat.messages[0].selectionQuotes).toEqual(['quotation']);
    expect(chat.messages[1].reasoning_content).toBe('reasoning');
    const { readCachedWebpageSources } = await import('../src/runtime/sync/webpage-sources.js');
    const pages = await readCachedWebpageSources(await getDb(), chatId);
    expect(pages[0]).toMatchObject({ url: 'https://example.test/', content: 'Cached text' });
    expect(pages[0].tabId).toBeUndefined();
    expect((await storage.get('cerebr_chats_index_v2')).cerebr_chats_index_v2).toContain(chatId);
    const { replicaRecord } = await import('../src/runtime/sync/replica.js');
    expect((await replicaRecord(await getDb(), key)).dirty).toBe(1);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBeUndefined();
});

it('deduplicates concurrent imports and never overwrites a continued conversation or removed source', async () => {
    const ids = await Promise.all([service.importConversation(id), service.importConversation(id)]);
    expect(ids[0]).toBe(ids[1]);
    const key = `cerebr_chat_v2_${ids[0]}`,
        chat = state.chats.get(ids[0]);
    chat.messages.push({ role: 'user', content: 'Continued privately' });
    await storage.set({ [key]: chat });
    const { removeCachedWebpageSources, readCachedWebpageSources } =
        await import('../src/runtime/sync/webpage-sources.js');
    await removeCachedWebpageSources(await getDb(), ids[0], ['https://example.test/']);
    fetcher.mockRejectedValue(new Error('Revoked or offline'));
    state.chats.clear(); // Reload still locates the local copy without fetching.
    expect(await service.importConversation(id)).toBe(ids[0]);
    expect(state.chats.get(ids[0]).messages.at(-1).content).toBe('Continued privately');
    expect(await readCachedWebpageSources(await getDb(), ids[0])).toEqual([]);
    expect(await service.importedChatId(otherId)).not.toBe(ids[0]);
});

it('does not leave a partial chat on malformed responses or cancelled imports', async () => {
    snapshot.pages[0].url = 'javascript:alert(1)';
    await expect(service.importConversation(id)).rejects.toThrow('share_invalid');
    expect(state.chats.size).toBe(0);
    snapshot.pages = [];
    const controller = new AbortController();
    controller.abort();
    await expect(service.importConversation(id, { signal: controller.signal })).rejects.toThrow();
    expect(
        (await storage.get(`cerebr_chat_v2_${await service.importedChatId(id)}`))[
            `cerebr_chat_v2_${await service.importedChatId(id)}`
        ]
    ).toBeUndefined();
});

it('never publishes local file paths from a cached webpage list', async () => {
    const { saveCachedWebpagesForChat } = await import('../src/utils/webpage-switches.js');
    state.chats.set('source', {
        id: 'source', title: 'Shared', messages: [{ role: 'user', content: 'Question' }],
    });
    await saveCachedWebpagesForChat('source', [
        { url: 'file:///Users/owner/private.pdf', title: 'Private file', content: 'private' },
        { url: 'https://example.test/', title: 'Web page', content: 'public' },
    ]);
    await storage.set({ cerebr_cloud_auth_v1: { token: 'owner-token', user: { id: 'owner' } } });
    await service.publishConversation('source');
    const body = JSON.parse(fetcher.mock.calls.at(-1)[1].body);
    expect(body.snapshot.pages.map((page) => page.url)).toEqual(['https://example.test/']);
});

it('requires login to publish, strips credentials and never uploads other conversations', async () => {
    state.chats.set('source', { id: 'source', ...snapshot.chat });
    await expect(service.publishConversation('source')).rejects.toThrow('share_login_required');
    await storage.set({ cerebr_cloud_auth_v1: { token: 'owner-token', user: { id: 'owner' } } });
    await service.publishConversation('source');
    const request = fetcher.mock.calls.at(-1)[1],
        body = JSON.parse(request.body);
    expect(request.headers.Authorization).toBe('Bearer owner-token');
    expect(body.chatId).toBe('source');
    expect(body.snapshot.chat.modelSelection).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('private');
    expect(state.chats.get('source').sharing).toEqual({ id, ownerId: 'owner' });
});
