// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { IDBKeyRange } from 'fake-indexeddb';
import { createTestSyncDatabase } from './helpers/sync-database.js';
import { createSyncClient } from '../src/runtime/sync/client.js';
import { SyncDatabase } from '../desktop/src/sync-database.ts';
import { applyRemoteRecord, replicaRecord, replicaRecords, writeLocal } from '../src/runtime/sync/replica.js';
import { browserSummary } from '../src/runtime/sync/summary.js';
import {
    migrateCachedWebpageSources, readCachedWebpageSources, readWebpageSourceRecord,
    removeCachedWebpageSources, restoreWebpageSource, webpageSourceKey, writeCachedWebpageSources,
} from '../src/runtime/sync/webpage-sources.js';
import { webpageCacheIdentity } from '../src/utils/webpage-identity.js';

const databases = [], clients = [], servers = [];
const pages = ['a', 'b', 'c'].map((id, i) => ({
    url: `https://example.test/${id}`, title: id, content: `Content ${id}`, tabId: i + 1, updatedAt: 10,
}));
const database = async () => { const db = await createTestSyncDatabase(); databases.push(db); return db; };
afterEach(() => {
    clients.splice(0).forEach((client) => client.close());
    databases.splice(0).forEach((db) => db.close());
    servers.splice(0).forEach((server) => server.close());
    vi.unstubAllGlobals();
});

it('relays per-document removals through local and cloud connections, including offline legacy replicas', async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    const extension = await database(), desktop = await database(), web = await database();
    await writeLocal(extension, { cerebr_webpage_cache_v1_chat: pages });
    const local = new SyncDatabase(':memory:'), cloud = new SyncDatabase(':memory:');
    servers.push(local, cloud);
    const endpoints = [], pending = [];
    async function endpoint(db, server) {
        let client;
        const send = (message) => pending.push(async () => {
            if (message.type === 'hello') await client.receive({ type: 'manifest', records: server.manifest() });
            if (message.type === 'get') for (const key of message.keys) await client.receive({ type: 'record', record: server.get(key) });
            if (message.type === 'put') {
                const result = server.put(message.record);
                for (const peer of endpoints.filter((peer) => peer.server === server))
                    await peer.client.receive({ type: 'record', record: result.record });
            }
        });
        client = await createSyncClient({ db, send });
        endpoints.push({ db, server, client }); clients.push(client); client.start();
    }
    async function sync() {
        for (let round = 0; round < 3; round++) {
            for (const client of clients) await client.flush();
            let count = 0;
            while (pending.length) {
                if (++count > 500) throw new Error('Sync did not converge');
                await pending.shift()();
            }
            await new Promise((resolve) => setTimeout(resolve, 60));
        }
    }
    await endpoint(extension, local); await endpoint(desktop, local);
    await endpoint(desktop, cloud); await endpoint(web, cloud); await sync();
    expect(await readCachedWebpageSources(web, 'chat')).toHaveLength(3);
    const stale = await readWebpageSourceRecord(extension, 'chat', pages[1].url);
    expect(stale.value.tabId).toBeUndefined();

    await removeCachedWebpageSources(desktop, 'chat', pages.slice(1).map((page) => page.url));
    await sync();
    for (const db of [extension, desktop, web])
        expect((await readCachedWebpageSources(db, 'chat')).map((page) => page.title)).toEqual(['a']);
    expect(await applyRemoteRecord(extension, stale)).toBe(false);
    await writeCachedWebpageSources(extension, 'chat', [pages[1]], new Map([
        [webpageCacheIdentity(pages[1].url), { version: stale.version }],
    ]));
    expect(await readWebpageSourceRecord(extension, 'chat', pages[1].url)).toMatchObject({ deleted: true });

    const offline = await database();
    await writeLocal(offline, { cerebr_webpage_cache_v1_chat: pages });
    await endpoint(offline, cloud); await sync();
    expect((await readCachedWebpageSources(offline, 'chat')).map((page) => page.title)).toEqual(['a']);

    await removeCachedWebpageSources(web, 'chat', [pages[0].url]); await sync();
    for (const db of [extension, desktop, web, offline]) expect(await readCachedWebpageSources(db, 'chat')).toEqual([]);
    expect((await browserSummary(await replicaRecords(web))).digest).toBe(cloud.summary(true).digest);

    await restoreWebpageSource(extension, 'chat', pages[0]);
    const restored = await readWebpageSourceRecord(extension, 'chat', pages[0].url);
    expect(await readCachedWebpageSources(extension, 'chat')).toEqual([]);
    await writeCachedWebpageSources(extension, 'chat', [pages[0]], new Map([
        [webpageCacheIdentity(pages[0].url), { version: restored.version }],
    ]));
    await sync();
    expect((await readCachedWebpageSources(web, 'chat')).map((page) => page.title)).toEqual(['a']);
});

it('uses fixed-size keys for long URLs and does not let migration overwrite a removal', async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    const db = await database(), url = 'https://example.test/?query=' + 'x'.repeat(3000);
    const key = await webpageSourceKey('chat', url);
    expect(key.length).toBeLessThan(256);
    await writeLocal(db, {}, [key]);
    await migrateCachedWebpageSources(db, 'chat', [{ url, title: 'Legacy', content: 'Old content', tabId: 77 }]);
    expect(await replicaRecord(db, key)).toMatchObject({ deleted: true });
    expect(await readCachedWebpageSources(db, 'chat')).toEqual([]);
});

it('syncs distinct documents at one URL and deletes only the chosen copy', async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    const source = await database(), web = await database();
    const copies = [
        { ...pages[0], content: 'First chat' },
        { ...pages[0], sourceId: crypto.randomUUID(), content: 'Second chat' },
    ];
    await writeCachedWebpageSources(source, 'chat', copies, new Map());
    for (const record of await replicaRecords(source)) await applyRemoteRecord(web, record);
    expect((await readCachedWebpageSources(web, 'chat')).map((page) => page.content).sort()).toEqual(['First chat', 'Second chat']);
    await removeCachedWebpageSources(web, 'chat', [copies[1]]);
    for (const record of await replicaRecords(web)) await applyRemoteRecord(source, record);
    expect((await readCachedWebpageSources(source, 'chat')).map((page) => page.content)).toEqual(['First chat']);
    expect((await readWebpageSourceRecord(source, 'chat', copies[1])).deleted).toBe(true);
});

it('keeps failed sync rounds in error until a complete reconciliation succeeds', async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    const db = await database(), sent = [], statuses = [];
    const client = await createSyncClient({ db, send: (message) => sent.push(message), onStatus: (status) => statuses.push(status) });
    clients.push(client);
    await client.receive({ type: 'manifest', records: [] });
    await client.receive({ type: 'record', record: { key: 'unknown-record', version: { clock: 1, actor: 'test' }, value: {} } });
    await client.receive({ type: 'caught-up', id: sent.findLast((message) => message.type === 'barrier').id });
    expect(statuses.at(-1)).toMatchObject({ syncing: false, error: 'Invalid sync record' });
    expect(statuses.at(-1).lastSyncAt).toBeUndefined();
    const recovery = client.reconcile();
    await client.receive({ type: 'manifest', records: [] });
    await client.receive({ type: 'caught-up', id: sent.findLast((message) => message.type === 'barrier').id });
    await recovery;
    expect(statuses.at(-1)).toMatchObject({ error: null, lastSyncAt: expect.any(Number) });
});
