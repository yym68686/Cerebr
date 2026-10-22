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
            textFiles: [{id:'f',name:'notes.txt',size:4,textLength:4}],
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
it('reconnects an acknowledged history without rewriting its records while still acknowledging offline writes', async () => {
    const db = await database();
    for (let i = 0; i < 40; i++) {
        await applyRemoteRecord(db, {
            key: `cerebr_chat_v2_${i}`, value: chat(String(i), 'Synced history'),
            version: { clock: i + 1, actor: 'remote' }, deleted: false,
        });
    }
    const manifest = await replicaManifest(db);
    const transactions = vi.spyOn(db, 'transaction');
    const client = await createSyncClient({ db, send: () => {} });
    try {
        await client.receive({ type: 'manifest', records: manifest });
        expect(transactions.mock.calls.filter(([, mode]) => mode === 'readwrite')).toHaveLength(0);
        transactions.mockRestore();
        await writeLocal(db, { cerebr_chat_v2_offline: chat('offline', 'Unacknowledged') });
        expect(await replicaRecords(db, { dirtyOnly: true })).toHaveLength(1);
        await client.receive({ type: 'manifest', records: await replicaManifest(db) });
        expect(await replicaRecords(db, { dirtyOnly: true })).toEqual([]);
        expect((await replicaRecord(db, 'cerebr_chat_v2_offline')).value.messages[0].content).toBe('Unacknowledged');
    } finally { transactions.mockRestore(); client.close(); }
});
it('synchronizes two independent replicas through the desktop database and converges after offline edits', async () => {
    const a = await database(),
        b = await database(),
        server = new SyncDatabase(':memory:');
    await writeLocal(a, {
        cerebr_chat_v2_a: chat('a', 'extension'),
        cerebr_chat_organization_v1: { folders: [{ id: 'f', name: 'Folder' }], assignments: { a: 'f' } },
        cerebr_reading_progress_v1_a: { anchorIndex: 3 },
        cerebr_draft_v1_a: { content: 'draft', quotes: ['quote'], textFiles: [{id:'f',name:'notes.txt',text:'body',size:4}] },
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

it('publishes incremental local counts before initial sync finishes without double-counting acknowledgements', async () => {
    const db = await database(), status = {}, sent = [], onStatus = vi.fn((patch) => Object.assign(status, patch));
    const client = await createSyncClient({ db, send: message => sent.push(message), onStatus });
    const record = (id, clock, count, deleted = false) => ({
        key: `cerebr_chat_v2_${id}`, version: { clock, actor: 'remote' }, deleted,
        value: deleted ? null : { ...chat(id, 'Question'), messages: Array.from({ length: count }, () => ({ role: 'user', content: 'Message' })) },
    });
    try {
        await client.receive({ type: 'manifest', records: [] });
        expect(status.localSummary).toEqual({ chats: 0, messages: 0 });
        expect(status.syncing).toBe(true);
        const first = record('first', 1, 2), second = record('second', 2, 3);
        await client.receive({ type: 'record', record: first });
        await vi.waitFor(() => expect(status.localSummary).toEqual({ chats: 1, messages: 2 }));
        expect(status.connected).not.toBe(true);
        await client.receive({ type: 'record', record: first });
        await client.receive({ type: 'record', record: second });
        await vi.waitFor(() => expect(status.localSummary).toEqual({ chats: 2, messages: 5 }));
        await client.receive({ type: 'record', record: record('first', 3, 4) });
        await client.receive({ type: 'record', record: first }); // stale replay
        await client.receive({ type: 'record', record: record('second', 4, 0, true) });
        await client.receive({ type: 'caught-up', id: sent.find(m => m.type === 'barrier').id, summary: { chats: 1, messages: 4 } });
        expect(status.localSummary).toEqual({ chats: 1, messages: 4 });
        expect(status.syncing).toBe(false);
        expect(status.connected).toBe(true);
        // Closing cancels pending UI updates rather than reviving an old connection.
        await client.receive({ type: 'record', record: record('third', 5, 1) });
        client.close();
        const calls = onStatus.mock.calls.length;
        await new Promise(resolve => setTimeout(resolve, 250));
        expect(onStatus).toHaveBeenCalledTimes(calls);
    } finally { client.close(); }
});

it('shows existing offline history immediately and includes pending local edits during sync', async () => {
    const db = await database(), status = {};
    await writeLocal(db, { cerebr_chat_v2_offline: chat('offline', 'Offline question') });
    const client = await createSyncClient({ db, send: () => {}, onStatus: patch => Object.assign(status, patch) });
    try {
        await client.receive({ type: 'manifest', records: [] });
        expect(status.localSummary).toEqual({ chats: 1, messages: 1 });
        await writeLocal(db, { cerebr_chat_v2_next: chat('next', 'Another question') });
        await client.flush();
        await vi.waitFor(() => expect(status.localSummary).toEqual({ chats: 2, messages: 2 }));
        expect(status.syncing).toBe(true);
    } finally { client.close(); }
});

it('repairs a missed deletion on an open connection before verifying', async () => {
    const db = await database(), server = new SyncDatabase(':memory:'), sent = [], status = {};
    const key = 'cerebr_chat_v2_default';
    await writeLocal(db, { [key]: chat('default', 'Welcome') });
    server.put(await replicaRecord(db, key));
    const client = await createSyncClient({ db, send: m => sent.push(m), onStatus: s => Object.assign(status, s) });
    async function drain() {
        while (sent.length) {
            const m = sent.shift();
            if (m.type === 'hello') await client.receive({ type: 'manifest', records: server.manifest() });
            if (m.type === 'get') {
                for (const key of m.keys) await client.receive({ type: 'record', record: server.get(key) });
                await client.receive({ type: 'caught-up', id: m.id });
            }
            if (m.type === 'put') await client.receive({ type: 'record', record: server.put(m.record).record });
            if (m.type === 'barrier') await client.receive({ type: 'caught-up', id: m.id, summary: server.summary(!!m.verify) });
        }
    }
    try {
        client.start(); await drain();
        const old = server.get(key);
        server.put({ ...old, value: null, deleted: true, version: { clock: old.version.clock + 1, actor: 'desktop' } });
        // The deletion broadcast was missed while this web tab was suspended.
        expect(await read(db, key)).toBeDefined();
        const verification = client.verify();
        await vi.waitFor(() => expect(sent.some(m => m.type === 'hello')).toBe(true));
        await drain();
        await vi.waitFor(() => expect(sent.some(m => m.verify)).toBe(true));
        await drain();
        expect((await verification).matches).toBe(true);
        expect(await read(db, key)).toBeUndefined();
        expect(status.localSummary).toEqual({ chats: 0, messages: 0 });
        expect(status.syncing).toBe(false);
    } finally { client.close(); server.close(); }
});

it('repairs a stale materialized chat when a known tombstone is replayed', async () => {
    const db = await database(), key = 'cerebr_chat_v2_removed';
    await writeLocal(db, { [key]: chat('removed', 'old') });
    const previous = await replicaRecord(db, key);
    const tombstone = { key, value: null, deleted: true, version: { clock: previous.version.clock + 1, actor: 'desktop' } };
    await applyRemoteRecord(db, tombstone);
    // Simulate a stale IndexedDB materialized copy left by an interrupted old client.
    const tx = db.transaction('keyValueStore', 'readwrite');
    tx.objectStore('keyValueStore').put(chat('removed', 'stale'), key);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    expect(await read(db, key)).toBeDefined();
    await applyRemoteRecord(db, tombstone);
    expect(await read(db, key)).toBeUndefined();
});

it('matches PostgreSQL JSONB history regardless of nested object property order', async () => {
    const record = { key: 'cerebr_chat_v2_jsonb', value: { ...chat('jsonb', 'Hello'), messages: [{ role: 'assistant', content: 'Hello', metadata: { b: 2, a: 1 } }] }, deleted: false, version: { clock: 1, actor: 'test' } };
    const reordered = JSON.parse(JSON.stringify(record, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value));
    expect((await browserSummary([record])).digest).toBe((await browserSummary([reordered])).digest);
    reordered.value.messages[0].content = 'Changed';
    expect((await browserSummary([record])).digest).not.toBe((await browserSummary([reordered])).digest);
});
