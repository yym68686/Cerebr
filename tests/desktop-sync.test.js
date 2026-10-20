// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { SyncDatabase } from '../desktop/src/sync-database.ts';
import {
    applyRemoteRecord,
    replicaManifest,
    replicaRecord,
    replicaRecords,
    seedReplica,
    upgradeReplica,
    writeLocal,
} from '../src/runtime/sync/replica.js';
import { createSyncClient } from '../src/runtime/sync/client.js';
import { browserSummary } from '../src/runtime/sync/summary.js';
const databases = [];
async function database() {
    const factory = new IDBFactory();
    const db = await new Promise((resolve, reject) => {
        const req = factory.open('test', 2);
        req.onupgradeneeded = () => {
            req.result.createObjectStore('keyValueStore');
            upgradeReplica(req.result);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    databases.push(db);
    return db;
}
const chat = (id, text) => ({
    id,
    title: 'Test ' + id,
    messages: [{ role: 'user', content: text }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
});
const read = (db, key) =>
    new Promise((resolve) => {
        const r = db.transaction('keyValueStore').objectStore('keyValueStore').get(key);
        r.onsuccess = () => resolve(r.result);
    });
afterEach(() => {
    databases.splice(0).forEach((db) => db.close());
});
it('persists images, reasoning and quotes together with their offline sync revision', async () => {
    const a = await database(),
        b = await database();
    const value = chat('one', 'hello');
    value.messages.push(
        { role: 'assistant', reasoning_content: 'thinking', content: 'answer' },
        {
            role: 'user',
            content: [
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
                { type: 'text', text: 'photo' },
            ],
            selectionQuotes: ['quote'],
        }
    );
    await writeLocal(a, { cerebr_chat_v2_one: value });
    const [record] = await replicaRecords(a, { dirtyOnly: true });
    expect(record.value).toEqual(value);
    await applyRemoteRecord(b, record);
    expect(await read(b, record.key)).toEqual(value);
    expect(await read(b, 'cerebr_chats_index_v2')).toEqual(['one']);
    expect(await replicaRecords(b, { dirtyOnly: true })).toEqual([]);
});
it('does not resurrect deleted chats after a stale peer reconnects or writes its old index', async () => {
    const a = await database(),
        b = await database();
    await writeLocal(a, { cerebr_chat_v2_one: chat('one', 'hi') });
    const old = await replicaRecord(a, 'cerebr_chat_v2_one');
    await applyRemoteRecord(b, old);
    await writeLocal(a, {}, ['cerebr_chat_v2_one']);
    const deleted = await replicaRecord(a, old.key);
    await applyRemoteRecord(b, deleted);
    await writeLocal(b, { cerebr_chats_index_v2: ['one'] });
    expect(await read(b, 'cerebr_chats_index_v2')).toEqual([]);
    expect(await applyRemoteRecord(a, old)).toBe(false);
    expect(await read(b, old.key)).toBeUndefined();
});
it('keeps remote additions when a sidebar writes an index based on older state', async () => {
    const a = await database();
    await applyRemoteRecord(a, {
        key: 'cerebr_chat_v2_remote',
        value: chat('remote', 'remote'),
        deleted: false,
        version: { clock: 2, actor: 'b' },
    });
    await writeLocal(a, { cerebr_chats_index_v2: ['local'] });
    expect(await read(a, 'cerebr_chats_index_v2')).toEqual(['local', 'remote']);
});
it('preserves a newer unsent edit when a delayed acknowledgement arrives', async () => {
    const a = await database();
    await writeLocal(a, { cerebr_chat_v2_one: chat('one', 'first') });
    const first = await replicaRecord(a, 'cerebr_chat_v2_one');
    await writeLocal(a, { cerebr_chat_v2_one: chat('one', 'second') });
    await applyRemoteRecord(a, first);
    expect((await replicaRecord(a, first.key)).value.messages[0].content).toBe('second');
    expect(await replicaRecords(a, { dirtyOnly: true })).toHaveLength(1);
});
it('synchronizes two independent replicas through the desktop database and converges after offline edits', async () => {
    const a = await database(),
        b = await database(),
        server = new SyncDatabase(':memory:');
    await writeLocal(a, {
        cerebr_chat_v2_a: chat('a', 'extension'),
        cerebr_chat_organization_v1: { folders: [{ id: 'f', name: 'Folder' }], assignments: { a: 'f' } },
        cerebr_reading_progress_v1_a: { anchorIndex: 3 },
        cerebr_draft_v1_a: { content: 'draft', quotes: ['quote'] },
    });
    await writeLocal(b, { cerebr_chat_v2_b: chat('b', 'desktop') });
    const clients = [],
        pending = [];
    async function endpoint(db) {
        let client;
        const send = (message) => {
            pending.push(async () => {
                if (message.type === 'hello')
                    await client.receive({ type: 'manifest', records: server.manifest() });
                if (message.type === 'get')
                    for (const key of message.keys)
                        await client.receive({ type: 'record', record: server.get(key) });
                if (message.type === 'put') {
                    const result = server.put(message.record);
                    for (const other of clients)
                        await other.receive({ type: 'record', record: result.record });
                }
            });
        };
        client = await createSyncClient({ db, send });
        clients.push(client);
        client.start();
        return client;
    }
    const ca = await endpoint(a),
        cb = await endpoint(b);
    async function drain() {
        let n = 0;
        while (pending.length) {
            if (++n > 100) throw new Error('sync loop');
            await pending.shift()();
        }
    }
    await drain();
    expect(await replicaManifest(a)).toEqual(await replicaManifest(b));
    expect(server.summary().chats).toBe(2);
    cb.close();
    clients.splice(clients.indexOf(cb), 1);
    await writeLocal(b, { cerebr_chat_v2_b: chat('b', 'edited offline') });
    await writeLocal(a, {}, ['cerebr_chat_v2_a']);
    await ca.flush();
    await drain();
    const reconnect = await endpoint(b);
    await drain();
    expect(await read(a, 'cerebr_chat_v2_b')).toEqual(await read(b, 'cerebr_chat_v2_b'));
    expect(await read(b, 'cerebr_chat_v2_a')).toBeUndefined();
    expect(server.summary().chats).toBe(1);
    ca.close();
    reconnect.close();
    server.close();
});
it('retains a recovery revision when two devices edit the same chat concurrently', () => {
    const server = new SyncDatabase(':memory:');
    const key = 'cerebr_chat_v2_one';
    server.put({ key, value: chat('one', 'a'), version: { clock: 100, actor: 'a' }, deleted: false });
    server.put({ key, value: chat('one', 'b'), version: { clock: 101, actor: 'b' }, deleted: false });
    expect(server.get(key).value.messages[0].content).toBe('b');
    expect(server.summary().revisions).toBe(1);
    server.close();
});
it('rejects unsupported data keys and malformed chat records', () => {
    const server = new SyncDatabase(':memory:');
    expect(() => server.put({ key: 'apiKey', value: 'secret', version: { clock: 1, actor: 'a' } })).toThrow();
    expect(() =>
        server.put({
            key: 'cerebr_chat_v2_one',
            value: chat('wrong', 'hi'),
            version: { clock: 1, actor: 'a' },
        })
    ).toThrow();
    server.close();
});
it('verifies the exact history bytes using the same digest in Chromium and the desktop worker', async () => {
    const db = await database(),
        server = new SyncDatabase(':memory:');
    await writeLocal(db, { cerebr_chat_v2_a: chat('a', 'hello'), cerebr_draft_v1_a: { text: 'draft' } });
    const records = await replicaRecords(db);
    records.forEach((record) => server.put(record));
    expect((await browserSummary(records.reverse())).digest).toEqual(server.summary(true).digest);
    records[0].value = { text: 'changed' };
    expect((await browserSummary(records)).digest).not.toEqual(server.summary(true).digest);
    server.close();
});
it('acknowledges local and cloud connections independently and relays records received on the other connection', async () => {
    const db = await database(), localSent = [], cloudSent = [];
    const local = await createSyncClient({ db, send: (m) => localSent.push(m) });
    const cloud = await createSyncClient({ db, send: (m) => cloudSent.push(m) });
    try {
        await local.receive({ type: 'manifest', records: [] });
        await cloud.receive({ type: 'manifest', records: [] });
        await writeLocal(db, { cerebr_chat_v2_both: chat('both', 'Question') });
        await local.flush();
        const record = localSent.find((m) => m.type === 'put').record;
        await local.receive({ type: 'record', record });
        expect(await replicaRecords(db, { dirtyOnly: true })).toEqual([]);
        await cloud.flush();
        expect(cloudSent.some((m) => m.type === 'put' && m.record.key === record.key)).toBe(true);
        await cloud.receive({ type: 'record', record });
        cloudSent.length = 0;
        const remote = { ...record, key: 'cerebr_chat_v2_remote', value: chat('remote', 'From extension'), version: { clock: record.version.clock + 1, actor: 'remote' } };
        await local.receive({ type: 'record', record: remote });
        await vi.waitFor(() => expect(cloudSent.some((m) => m.type === 'put' && m.record.key === remote.key)).toBe(true));
        await cloud.receive({ type: 'record', record: remote });
        cloudSent.length = 0;
        await cloud.flush();
        expect(cloudSent.filter((m) => m.type === 'put')).toEqual([]);
    } finally { local.close(); cloud.close(); }
});
