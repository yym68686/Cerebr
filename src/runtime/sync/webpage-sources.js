import { WEBPAGE_SOURCE_PREFIX } from './protocol.js';
import { replicaRecord, replicaRecordsWithPrefix, seedReplicaValues, writeLocal } from './replica.js';
import { webpageCacheIdentity } from '../../utils/webpage-identity.js';

export const LEGACY_WEBPAGE_CACHE_PREFIX = 'cerebr_webpage_cache_v1_';
const migrations = new WeakMap();
const read = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});

export function webpageSourceChatId(key) {
    if (!key.startsWith(WEBPAGE_SOURCE_PREFIX)) return null;
    const separator = key.indexOf(':', WEBPAGE_SOURCE_PREFIX.length);
    if (separator < 0) return null;
    try { return decodeURIComponent(key.slice(WEBPAGE_SOURCE_PREFIX.length, separator)); }
    catch { return null; }
}

const prefix = (chatId) => `${WEBPAGE_SOURCE_PREFIX}${encodeURIComponent(chatId)}:`;

export async function webpageSourceKey(chatId, url) {
    const identity = webpageCacheIdentity(url);
    if (!chatId || !identity) return null;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
    return prefix(chatId) + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function migrateCachedWebpageSources(db, chatId, legacyPages) {
    if (!chatId) {
        const keys = await read(db.transaction('keyValueStore').objectStore('keyValueStore').getAllKeys());
        for (const key of keys) {
            if (typeof key === 'string' && key.startsWith(LEGACY_WEBPAGE_CACHE_PREFIX))
                await migrateCachedWebpageSources(db, key.slice(LEGACY_WEBPAGE_CACHE_PREFIX.length));
        }
        return;
    }
    if (!migrations.has(db)) migrations.set(db, new Map());
    const pending = migrations.get(db);
    if (pending.has(chatId)) return pending.get(chatId);
    const migration = (async () => {
        const pages = typeof legacyPages === 'function' ? await legacyPages() :
            legacyPages ?? await read(db.transaction('keyValueStore').objectStore('keyValueStore').get(LEGACY_WEBPAGE_CACHE_PREFIX + chatId));
        const values = {};
        for (const page of Array.isArray(pages) ? pages : []) {
            if (typeof page?.content !== 'string') continue;
            const key = await webpageSourceKey(chatId, page.url);
            if (key) {
                // Browser tab IDs belong to one browser; only document data is shared.
                const { tabId, isCurrent, observedAt, ...document } = page;
                values[key] = document;
            }
        }
        await seedReplicaValues(db, values);
    })();
    pending.set(chatId, migration);
    try { await migration; }
    catch (error) { pending.delete(chatId); throw error; }
}

export async function readCachedWebpageSources(db, chatId) {
    return (await replicaRecordsWithPrefix(db, prefix(chatId)))
        .filter((record) => !record.deleted && typeof record.value?.content === 'string')
        .map((record) => record.value)
        .sort((a, b) => (a.addedAt || a.updatedAt || 0) - (b.addedAt || b.updatedAt || 0) || a.url.localeCompare(b.url));
}

export async function readWebpageSourceRecord(db, chatId, url) {
    const key = await webpageSourceKey(chatId, url);
    return key ? replicaRecord(db, key) : null;
}

export async function writeCachedWebpageSources(db, chatId, pages, revisions) {
    const values = {}, expectedVersions = new Map();
    for (const page of pages) {
        const key = await webpageSourceKey(chatId, page.url);
        if (!key || typeof page.content !== 'string') continue;
        const { tabId, isCurrent, observedAt, ...document } = page;
        const existing = await replicaRecord(db, key);
        if (existing?.deleted) continue;
        values[key] = { ...document, addedAt: existing?.value?.addedAt || existing?.value?.updatedAt || Number(observedAt) || Date.now(), updatedAt: Number(observedAt) || Date.now() };
        expectedVersions.set(key, revisions.get(webpageCacheIdentity(page.url))?.version);
    }
    await writeLocal(db, values, [], { expectedVersions });
}

export async function removeCachedWebpageSources(db, chatId, urls) {
    const keys = (await Promise.all(urls.map((url) => webpageSourceKey(chatId, url)))).filter(Boolean);
    await writeLocal(db, {}, keys);
}

export async function clearCachedWebpageSources(db, chatId) {
    const records = await replicaRecordsWithPrefix(db, prefix(chatId));
    await writeLocal(db, {}, records.filter((record) => !record.deleted).map((record) => record.key));
}

export async function restoreWebpageSource(db, chatId, tab) {
    const record = await readWebpageSourceRecord(db, chatId, tab.url);
    if (record?.deleted) {
        // An explicit re-selection permits the next question to read the page.
        // It does not cache content before that question is asked.
        await writeLocal(db, { [record.key]: { url: tab.url, title: tab.title } });
    }
}
