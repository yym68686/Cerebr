import { compareVersions } from './protocol.js';
import {
    acknowledgeRecord,
    applyRemoteRecord,
    replicaManifest,
    replicaRecord,
    replicaRecords,
    seedReplica,
    subscribeLocalChanges,
} from './replica.js';
import { browserSummary } from './summary.js';
export async function createSyncClient({ db, send, onStatus = () => {}, onProgress = () => {} }) {
    await seedReplica(db);
    let ready = false,
        timer = 0,
        queue = Promise.resolve(),
        stopped = false;
    const checks = new Map();
    const transmit = async () => {
        if (!ready || stopped) return;
        for (const record of await replicaRecords(db, { dirtyOnly: true })) send({ type: 'put', record });
        send({ type: 'barrier', id: crypto.randomUUID() });
    };
    const unsubscribe = subscribeLocalChanges(() => {
        if (!timer)
            timer = setTimeout(() => {
                timer = 0;
                queue = queue.then(transmit).catch((e) => onStatus({ error: e.message }));
            }, 100);
    });
    const receive = async (message) => {
        if (stopped) return;
        if (message.type === 'manifest') {
            const local = new Map((await replicaManifest(db)).map((r) => [r.key, r]));
            const needed = [];
            for (const remote of message.records) {
                const ours = local.get(remote.key);
                if (!ours || compareVersions(remote.version, ours.version) > 0) needed.push(remote.key);
                else if (compareVersions(remote.version, ours.version) < 0)
                    send({ type: 'put', record: await replicaRecord(db, remote.key) });
                else await acknowledgeRecord(db, remote);
                local.delete(remote.key);
            }
            for (const key of local.keys()) send({ type: 'put', record: await replicaRecord(db, key) });
            ready = true;
            send({ type: 'get', keys: needed, id: crypto.randomUUID() });
            send({ type: 'barrier', id: crypto.randomUUID() });
        } else if (message.type === 'record') {
            const applied = await applyRemoteRecord(db, message.record);
            if (!applied) send({ type: 'put', record: await replicaRecord(db, message.record.key) });
        } else if (message.type === 'caught-up') {
            onStatus({
                connected: true,
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
    return {
        start() {
            send({ type: 'hello' });
        },
        receive(message) {
            queue = queue.then(() => receive(message)).catch((e) => onStatus({ error: e.message }));
            return queue;
        },
        flush() {
            queue = queue.then(transmit);
            return queue;
        },
        async verify() {
            if (!ready || stopped) throw new Error('请先连接桌面应用并等待首次同步完成。');
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
        close() {
            stopped = true;
            ready = false;
            clearTimeout(timer);
            unsubscribe();
            for (const check of checks.values()) {
                clearTimeout(check.timer);
                check.reject(new Error('同步连接已关闭。'));
            }
            checks.clear();
        },
    };
}
