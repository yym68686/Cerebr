import { CHAT_PREFIX, compareVersions } from './protocol.js';
import {
    acknowledgeRecord,
    applyRemoteRecord,
    replicaManifest,
    replicaRecord,
    replicaRecords,
    seedReplica,
    subscribeLocalChanges,
    subscribeRemoteChanges,
} from './replica.js';
import { browserSummary } from './summary.js';
export async function createSyncClient({
    db,
    send,
    onStatus = () => {},
    onProgress = () => {},
    onLive = () => {},
}) {
    await seedReplica(db);
    let ready = false,
        timer = 0,
        queue = Promise.resolve(),
        stopped = false;
    const checks = new Map();
    let reconciliation = null, reconciliationBarrier = null;
    const acknowledged = new Map();
    const pending = new Set();
    let scan = true;
    // Counts describe the records already available locally, including offline
    // edits. Keep only their contributions, never duplicate image payloads.
    const counted = new Map();
    let chats = 0, messages = 0, countsTimer, countsChanged = false;
    const publishCounts = () => {
        clearTimeout(countsTimer);
        countsTimer = null;
        if (stopped || !countsChanged) return;
        countsChanged = false;
        onStatus({ localSummary: { chats, messages } });
    };
    const countRecord = (record) => {
        if (!record) return;
        const previous = counted.get(record.key);
        if (previous && compareVersions(record.version, previous.version) <= 0) return;
        const chat = record.key.startsWith(CHAT_PREFIX) && !record.deleted ? 1 : 0;
        const count = chat ? (record.messageCount ?? record.value?.messages?.length ?? 0) : 0;
        counted.set(record.key, { version: record.version, chat, messages: count });
        chats += chat - (previous?.chat || 0);
        messages += count - (previous?.messages || 0);
        countsChanged = true;
        // Limit React and extension-storage updates during large imports, while
        // continuing to show progress before the final server barrier arrives.
        if (!countsTimer) countsTimer = setTimeout(publishCounts, 200);
    };
    const transmit = async () => {
        if (!ready || stopped) return;
        if (scan) {
            scan = false;
            for (const item of await replicaManifest(db))
                if (compareVersions(item.version, acknowledged.get(item.key)) > 0) pending.add(item.key);
        }
        const keys = [...pending];
        pending.clear();
        for (const key of keys) {
            const record = await replicaRecord(db, key);
            countRecord(record);
            if (record && compareVersions(record.version, acknowledged.get(key)) > 0)
                send({ type: 'put', record });
        }
        send({ type: 'barrier', id: crypto.randomUUID() });
    };
    const schedule = (keys) => {
        if (keys) keys.forEach((key) => pending.add(key));
        else scan = true;
        if (!timer)
            timer = setTimeout(() => {
                timer = 0;
                queue = queue.then(transmit).catch((e) => onStatus({ error: e.message }));
            }, 100);
    };
    const unsubscribe = subscribeLocalChanges(schedule);
    // A write received from the local bridge must also reach the cloud (and
    // vice versa). Acknowledgements belong to this connection, not the record.
    const unsubscribeRemote = subscribeRemoteChanges(schedule);
    const receive = async (message) => {
        if (stopped) return;
        if (message.type === 'manifest') {
            onStatus({ syncing: true });
            const local = new Map((await replicaManifest(db, { includeDirty: true, includeCounts: true })).map((r) => [r.key, r]));
            counted.clear();
            chats = messages = 0;
            countsChanged = true;
            local.forEach(countRecord);
            publishCounts();
            const needed = [];
            for (const remote of message.records) {
                acknowledged.set(remote.key, remote.version);
                const ours = local.get(remote.key);
                if (!ours || compareVersions(remote.version, ours.version) > 0) needed.push(remote.key);
                else if (compareVersions(remote.version, ours.version) < 0)
                    send({ type: 'put', record: await replicaRecord(db, remote.key) });
                else if (remote.deleted)
                    await applyRemoteRecord(db, { ...remote, value: null });
                else if (ours.dirty) await acknowledgeRecord(db, remote);
                local.delete(remote.key);
            }
            for (const key of local.keys()) send({ type: 'put', record: await replicaRecord(db, key) });
            ready = true;
            scan = false;
            send({ type: 'get', keys: needed, id: crypto.randomUUID() });
            reconciliationBarrier = crypto.randomUUID();
            send({ type: 'barrier', id: reconciliationBarrier });
        } else if (message.type === 'record') {
            acknowledged.set(message.record.key, message.record.version);
            const applied = await applyRemoteRecord(db, message.record);
            const record = applied ? message.record : await replicaRecord(db, message.record.key);
            countRecord(record);
            if (!applied) send({ type: 'put', record });
        } else if (message.type === 'caught-up') {
            // A get response only acknowledges that batch. Complete the round
            // after the barrier sent after all uploads and downloads.
            if ((reconciliation || reconciliationBarrier) && message.id !== reconciliationBarrier && !checks.has(message.id)) return;
            if (message.id === reconciliationBarrier) {
                reconciliationBarrier = null;
                clearTimeout(reconciliation?.timer);
                const round = reconciliation;
                reconciliation = null;
                round?.resolve();
            }
            publishCounts();
            onStatus({
                connected: true,
                syncing: false,
                lastSyncAt: Date.now(),
                error: null,
                ...(message.summary ? { summary: message.summary } : {}),
            });
            const check = checks.get(message.id);
            if (check && message.summary) {
                checks.delete(message.id);
                clearTimeout(check.timer);
                try {
                    const local = await browserSummary(await replicaRecords(db));
                    const verification = {
                        local,
                        remote: message.summary,
                        matches: local.digest === message.summary.digest,
                        checkedAt: Date.now(),
                    };
                    onStatus({ verification });
                    check.resolve(verification);
                } catch (error) {
                    check.reject(error);
                }
            }
        } else if (message.type === 'progress') onProgress(message.progress);
        else if (message.type === 'error') onStatus({ error: message.error });
    };
    const reconcile = () => {
        if (stopped) return Promise.reject(new Error('同步连接已关闭。'));
        if (reconciliation) return reconciliation.promise;
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        const round = { promise, resolve, reject };
        reconciliation = round;
        round.timer = setTimeout(() => {
            if (reconciliation !== round) return;
            reconciliation = null;
            reject(new Error('同步响应超时，请重新连接。'));
        }, 30000);
        onStatus({ syncing: true, verification: null });
        // A suspended tab may miss events despite retaining an open socket.
        send({ type: 'hello' });
        return promise;
    };
    return {
        reconcile,
        start() {
            send({ type: 'hello' });
        },
        receive(message) {
            if (message.type === 'live-chat') {
                if (!stopped) onLive(message.frame);
                return Promise.resolve();
            }
            if (message.type === 'progress') {
                if (!stopped) onProgress(message.progress);
                return Promise.resolve();
            }
            queue = queue.then(() => receive(message)).catch((e) => onStatus({ error: e.message }));
            return queue;
        },
        flush() {
            queue = queue.then(transmit);
            return queue;
        },
        async verify() {
            if (!ready || stopped) throw new Error('请先连接同步并等待首次同步完成。');
            await reconcile();
            await queue;
            await transmit();
            return new Promise((resolve, reject) => {
                const id = crypto.randomUUID();
                const timer = setTimeout(() => {
                    checks.delete(id);
                    reject(new Error('同步校验超时，请在连接恢复后重试。'));
                }, 60000);
                checks.set(id, { resolve, reject, timer });
                send({ type: 'barrier', id, verify: true });
            });
        },
        progress(progress) {
            if (ready) send({ type: 'progress', progress });
        },
        live(frame) {
            if (ready && !stopped) send({ type: 'live-chat', frame });
        },
        close() {
            stopped = true;
            ready = false;
            clearTimeout(timer);
            clearTimeout(countsTimer);
            clearTimeout(reconciliation?.timer);
            reconciliation?.reject(new Error('同步连接已关闭。'));
            reconciliation = null;
            unsubscribe();
            unsubscribeRemote();
            for (const check of checks.values()) {
                clearTimeout(check.timer);
                check.reject(new Error('同步连接已关闭。'));
            }
            checks.clear();
        },
    };
}
