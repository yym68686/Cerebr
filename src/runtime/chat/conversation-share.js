import { chatManager } from '../../domain/chat/chat-store.js';
import { normalizeShareSnapshot, SHARE_ID } from '../../domain/chat/share-snapshot.js';
import { storageAdapter, getDb } from '../../utils/storage-adapter.js';
import { getCachedWebpagesForChat } from '../../utils/webpage-switches.js';
import { CHAT_PREFIX, CHAT_INDEX } from '../sync/protocol.js';
import { writeLocal, announceRemoteChanges } from '../sync/replica.js';
import { webpageSourceKey } from '../sync/webpage-sources.js';
import { CLOUD_SYNC_URL } from '../sync/cloud-sync.js';

export function shareUrl(id, href = location.href) {
    if (!SHARE_ID.test(id)) throw new Error('share_invalid');
    const url = new URL(href);
    if (!['https:', 'http:'].includes(url.protocol)) return `https://cerebr.fugue.pro/#/share/${id}`;
    url.search = '';
    url.hash = `/share/${id}`;
    return url.href;
}

export function shareIdFromHash(hash) {
    const match = /^#\/share\/([0-9a-f]{48})\/?$/.exec(hash);
    return match?.[1] || null;
}

async function request(path, { method = 'GET', body, authenticated = false, signal } = {}) {
    // Large document snapshots go directly to HTTP, not through extension IPC.
    const auth = authenticated
        ? (await storageAdapter.get('cerebr_cloud_auth_v1')).cerebr_cloud_auth_v1
        : null;
    if (authenticated && !auth?.token) throw new Error('share_login_required');
    const response = await fetch(`${CLOUD_SYNC_URL}/api/shares${path}`, {
        method,
        headers: {
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(auth ? { Authorization: `Bearer ${auth.token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
    });
    if (response.status === 401) throw new Error('share_login_required');
    if (response.status === 404) throw new Error('share_unavailable');
    let result;
    try {
        result = await response.json();
    } catch {
        throw new Error('share_request_failed');
    }
    if (!response.ok) throw new Error(result.error || 'share_request_failed');
    return { result, ownerId: auth?.user?.id };
}

async function snapshotFor(chatId) {
    await chatManager.loadAllChats();
    const chat = chatManager.chats.get(chatId);
    if (!chat?.messages.length) throw new Error('share_empty');
    if (chat.messages.some((message) => message.updating)) throw new Error('share_busy');
    return normalizeShareSnapshot({ version: 1, chat,
        pages: (await getCachedWebpagesForChat(chatId)).filter((page) => /^https?:\/\//i.test(page.url)) });
}

export async function publishConversation(chatId, update = false) {
    const snapshot = await snapshotFor(chatId);
    const chat = chatManager.chats.get(chatId);
    const { result, ownerId } = await request(update ? `/${chat.sharing?.id}` : '', {
        method: update ? 'PUT' : 'POST',
        body: update ? { snapshot } : { chatId, snapshot },
        authenticated: true,
    });
    if (!SHARE_ID.test(result.shareId)) throw new Error('share_invalid');
    chat.sharing = { id: result.shareId, ownerId };
    chatManager.markChatDirty(chatId, { touchUpdatedAt: false });
    chatManager.saveChats({ touchCurrentChat: false });
    await chatManager.flushNow();
    return shareUrl(result.shareId);
}

export async function revokeConversation(chatId) {
    const chat = chatManager.chats.get(chatId);
    if (!SHARE_ID.test(chat?.sharing?.id)) throw new Error('share_unavailable');
    await request(`/${chat.sharing.id}`, { method: 'DELETE', authenticated: true });
    delete chat.sharing;
    chatManager.markChatDirty(chatId, { touchUpdatedAt: false });
    chatManager.saveChats({ touchCurrentChat: false });
    await chatManager.flushNow();
}

// Stable local ID differs from the private source ID. This also deduplicates
// imports arriving through different hosts, browser tabs or synced devices.
export async function importedChatId(id) {
    if (!SHARE_ID.test(id)) throw new Error('share_invalid');
    const bytes = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cerebr-share:${id}`))
    );
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes.slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function importConversation(id, { signal } = {}) {
    const chatId = await importedChatId(id),
        key = CHAT_PREFIX + chatId;
    await chatManager.loadAllChats();
    await chatManager.flushNow();
    // An already imported copy remains available even after the link is revoked.
    const existing = chatManager.chats.get(chatId) || (await storageAdapter.get(key))[key];
    if (existing) {
        chatManager.chats.set(chatId, existing);
        chatManager.notify();
        return chatId;
    }
    const { result } = await request(`/${id}`, { signal });
    if (result.shareId !== id) throw new Error('share_invalid');
    const snapshot = normalizeShareSnapshot(result.snapshot),
        now = new Date().toISOString();
    const selection = chatManager.getDefaultModelSelection?.();
    const chat = {
        id: chatId,
        ...snapshot.chat,
        createdAt: now,
        updatedAt: now,
        importedShareId: id,
        ...(selection ? { modelSelection: { ...selection } } : {}),
    };
    const values = { [key]: chat, [CHAT_INDEX]: [chatId] };
    for (const page of snapshot.pages) {
        const sourceKey = await webpageSourceKey(chatId, page);
        if (!sourceKey) throw new Error('share_invalid');
        values[sourceKey] = { ...page, addedAt: Date.now(), updatedAt: Date.now() };
    }
    signal?.throwIfAborted();
    await writeLocal(await getDb(), values, [], { ifAbsent: key });
    // If another tab imported first, always use its existing, possibly edited copy.
    const stored = (await storageAdapter.get(key))[key];
    if (!stored) throw new Error('share_import_failed');
    chatManager.chats.set(chatId, stored);
    chatManager.notify();
    announceRemoteChanges(Object.keys(values));
    return chatId;
}
