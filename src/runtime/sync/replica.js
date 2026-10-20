import {
    CHAT_INDEX,
    CHAT_PREFIX,
    SYNC_META,
    SYNC_RECORDS,
    compareVersions,
    isSyncedKey,
    validRecord,
} from './protocol.js';
const KV = 'keyValueStore';
const channel =
    typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('cerebr-sync-storage-v1') : null;
channel?.unref?.();
const listeners = new Set();
const localListeners = new Set();
const pendingRemoteKeys = new Set();
let remoteNotificationTimer;
channel?.addEventListener('message', (event) => {
    if (event.data?.type === 'remote') listeners.forEach((fn) => fn(event.data.keys));
});
export function subscribeRemoteChanges(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
export function announceRemoteChanges(keys) {
    if (!keys.length) return;
    keys.forEach((key) => pendingRemoteKeys.add(key));
    if (remoteNotificationTimer) return;
    remoteNotificationTimer = setTimeout(() => {
        remoteNotificationTimer = null;
        const batch = [...pendingRemoteKeys];
        pendingRemoteKeys.clear();
        listeners.forEach((fn) => fn(batch));
        channel?.postMessage({ type: 'remote', keys: batch });
    }, 50);
}
export function announceLocalChanges(keys) {
    localListeners.forEach((fn) => fn(keys));
    channel?.postMessage({ type: 'local', keys });
}
export function subscribeLocalChanges(fn) {
    const listener = (event) => {
        if (event.data?.type === 'local') fn(event.data.keys);
    };
    localListeners.add(fn);
    channel?.addEventListener('message', listener);
    return () => {
        localListeners.delete(fn);
        channel?.removeEventListener('message', listener);
    };
}
export function upgradeReplica(db) {
    if (!db.objectStoreNames.contains(SYNC_RECORDS)) {
        const records = db.createObjectStore(SYNC_RECORDS);
        records.createIndex('dirty', 'dirty');
    }
    if (!db.objectStoreNames.contains(SYNC_META)) db.createObjectStore(SYNC_META);
}
const request = (req) =>
    new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
const done = (tx) =>
    new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error || new Error('Sync transaction aborted'));
        tx.onerror = () => {};
    });

// Data and its pending sync revision are committed together, even while offline.
export async function writeLocal(db, values, removals = []) {
    const tx = db.transaction([KV, SYNC_RECORDS, SYNC_META], 'readwrite'),
        complete = done(tx);
    const kv = tx.objectStore(KV),
        records = tx.objectStore(SYNC_RECORDS),
        meta = tx.objectStore(SYNC_META);
    const state = (await request(meta.get('state'))) || { actor: crypto.randomUUID(), clock: 0 };
    let changed = false;
    for (const [key, value, deleted] of [
        ...Object.entries(values).map(([k, v]) => [k, v, false]),
        ...removals.map((k) => [k, null, true]),
    ]) {
        if (isSyncedKey(key)) {
            const old = await request(records.get(key));
            if (old?.deleted === deleted && JSON.stringify(old.value) === JSON.stringify(value)) continue;
            state.clock = Math.max(Date.now(), state.clock + 1, (old?.version.clock || 0) + 1);
            records.put(
                { key, value, deleted, version: { clock: state.clock, actor: state.actor }, dirty: 1 },
                key
            );
            changed = true;
        }
        if (key === CHAT_INDEX && Array.isArray(value)) {
            // Index writes from another open sidebar must not erase remote additions.
            const keys = await request(kv.getAllKeys());
            const ids = new Set([
                ...value,
                ...keys.filter((k) => k.startsWith(CHAT_PREFIX)).map((k) => k.slice(CHAT_PREFIX.length)),
            ]);
            for (const id of ids) if ((await request(records.get(CHAT_PREFIX + id)))?.deleted) ids.delete(id);
            kv.put([...ids], key);
        } else if (deleted) kv.delete(key);
        else kv.put(value, key);
    }
    meta.put(state, 'state');
    await complete;
    if (changed) announceLocalChanges([...Object.keys(values), ...removals].filter(isSyncedKey));
}

export async function seedReplica(db, suppliedKeys) {
    const keys = suppliedKeys || (await request(db.transaction(KV).objectStore(KV).getAllKeys()));
    // Reconnecting is common. Inspect keys first so existing history (including
    // large image records) is not cloned in thousands of read/write transactions.
    const existing = new Set(
        await request(db.transaction(SYNC_RECORDS).objectStore(SYNC_RECORDS).getAllKeys())
    );
    for (const key of keys.filter((key) => isSyncedKey(key) && !existing.has(key))) {
        const tx = db.transaction([KV, SYNC_RECORDS, SYNC_META], 'readwrite'),
            complete = done(tx);
        const records = tx.objectStore(SYNC_RECORDS),
            meta = tx.objectStore(SYNC_META);
        if (!(await request(records.get(key)))) {
            const value = await request(tx.objectStore(KV).get(key));
            const state = (await request(meta.get('state'))) || { actor: crypto.randomUUID(), clock: 0 };
            const clock = Math.max(
                0,
                Number(value?.updatedAt) || Date.parse(value?.updatedAt || value?.createdAt) || 0
            );
            records.put(
                { key, value, deleted: false, version: { clock, actor: state.actor }, dirty: 1 },
                key
            );
            meta.put(state, 'state');
        }
        await complete;
    }
}
export async function replicaRecords(db, { dirtyOnly = false } = {}) {
    const store = db.transaction(SYNC_RECORDS).objectStore(SYNC_RECORDS);
    return request(dirtyOnly ? store.index('dirty').getAll(1) : store.getAll());
}
export async function replicaRecordsWithPrefix(db, prefix) {
    return request(
        db
            .transaction(SYNC_RECORDS)
            .objectStore(SYNC_RECORDS)
            .getAll(IDBKeyRange.bound(prefix, prefix + '\uffff'))
    );
}
export async function acknowledgeRecord(db, record) {
    const tx = db.transaction(SYNC_RECORDS, 'readwrite'),
        complete = done(tx),
        store = tx.objectStore(SYNC_RECORDS);
    const local = await request(store.get(record.key));
    if (local?.dirty && compareVersions(local.version, record.version) === 0)
        store.put({ ...local, dirty: 0 }, record.key);
    await complete;
}
export async function applyRemoteRecord(db, record) {
    if (!validRecord(record)) throw new Error('Invalid sync record');
    const tx = db.transaction([KV, SYNC_RECORDS, SYNC_META], 'readwrite'),
        complete = done(tx);
    const kv = tx.objectStore(KV),
        records = tx.objectStore(SYNC_RECORDS),
        meta = tx.objectStore(SYNC_META);
    const local = await request(records.get(record.key));
    const order = compareVersions(record.version, local?.version);
    if (!local || order > 0) {
        records.put({ ...record, dirty: 0 }, record.key);
        if (record.deleted) kv.delete(record.key);
        else kv.put(record.value, record.key);
        if (record.key.startsWith(CHAT_PREFIX)) {
            const ids = new Set((await request(kv.get(CHAT_INDEX))) || []),
                id = record.key.slice(CHAT_PREFIX.length);
            if (record.deleted) ids.delete(id);
            else ids.add(id);
            kv.put([...ids], CHAT_INDEX);
        }
        const state = (await request(meta.get('state'))) || { actor: crypto.randomUUID(), clock: 0 };
        state.clock = Math.max(state.clock, record.version.clock);
        meta.put(state, 'state');
    } else if (order === 0) {
        if (local.dirty) records.put({ ...local, dirty: 0 }, record.key);
        // Repair a stale materialized chat/index even if the deletion revision
        // was already recorded by another open tab. Notify in-memory views too.
        if (record.deleted) {
            kv.delete(record.key);
            if (record.key.startsWith(CHAT_PREFIX)) {
                const ids = (await request(kv.get(CHAT_INDEX))) || [];
                kv.put(ids.filter(id => CHAT_PREFIX + id !== record.key), CHAT_INDEX);
            }
        }
    }
    await complete;
    if (!local || order > 0 || (order === 0 && record.deleted)) announceRemoteChanges([record.key]);
    return !local || order >= 0;
}
export async function replicaManifest(db, { includeDirty = false, includeCounts = false } = {}) {
    // Keep metadata only. Reconciliation runs after wake and periodically, so
    // retaining a second full copy of every image via getAll would be costly.
    const cursor = db.transaction(SYNC_RECORDS).objectStore(SYNC_RECORDS).openCursor();
    return new Promise((resolve, reject) => {
        const manifest = [];
        cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
            const entry = cursor.result;
            if (!entry) return resolve(manifest);
            const { key, version, deleted, dirty, value } = entry.value;
            manifest.push({ key, version, deleted,
                ...(includeDirty ? { dirty: !!dirty } : {}),
                ...(includeCounts ? { messageCount: value?.messages?.length || 0 } : {}),
            });
            entry.continue();
        };
    });
}
export async function replicaRecord(db, key) {
    return request(db.transaction(SYNC_RECORDS).objectStore(SYNC_RECORDS).get(key));
}
