import { createStore } from '../../app/state/store.js';
import { getDb, storageAdapter, isExtensionEnvironment } from '../../utils/storage-adapter.js';
import { createSyncClient } from './client.js';
import { ensureApiReplica } from './api-settings.js';

export const CLOUD_SYNC_URL = 'https://cerebr-sync.fugue.pro';
const AUTH = 'cerebr_cloud_auth_v1',
    DEVICE = 'cerebr_cloud_device_v1',
    STATUS = 'cerebr_cloud_status_v1';
export const cloudSyncStore = createStore({
    user: null,
    connected: false,
    connecting: false,
    error: null,
    lastSyncAt: null,
});
const liveListeners = new Set(),
    progressListeners = new Set();
export const subscribeCloudLive = (fn) => {
    liveListeners.add(fn);
    return () => liveListeners.delete(fn);
};
export const subscribeCloudProgress = (fn) => {
    progressListeners.add(fn);
    return () => progressListeners.delete(fn);
};
let socket,
    client,
    authData,
    retry,
    heartbeat,
    stopped = false,
    generation = 0,
    lastReceived = 0,
    lastReconciled = 0,
    recovering = null,
    initialized;
const background = isExtensionEnvironment && typeof document === 'undefined';
const emitStatus = (patch) => {
    cloudSyncStore.set(patch);
    if (background) void chrome.storage.local.set({ [STATUS]: cloudSyncStore.getSnapshot() });
};
const emitLive = (frame) => {
    liveListeners.forEach((fn) => fn(frame));
    if (background) void chrome.runtime.sendMessage({ type: 'CEREBR_CLOUD_LIVE', frame }).catch(() => {});
};
const emitProgress = (progress) => {
    progressListeners.forEach((fn) => fn(progress));
    if (background)
        void chrome.runtime.sendMessage({ type: 'CEREBR_CLOUD_PROGRESS', progress }).catch(() => {});
};
async function api(path, body, token = authData?.token) {
    const response = await fetch(CLOUD_SYNC_URL + '/api' + path, {
        method: body ? 'POST' : 'GET',
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '同步服务连接失败。');
    return result;
}
async function metadata() {
    let device = (await storageAdapter.get(DEVICE))[DEVICE];
    if (!device) {
        device = { id: crypto.randomUUID() };
        await storageAdapter.set({ [DEVICE]: device });
    }
    const platform = globalThis.cerebrDesktop ? 'desktop' : isExtensionEnvironment ? 'extension' : 'web';
    const os =
        globalThis.cerebrDesktop?.platform || navigator.userAgentData?.platform || navigator.platform || '';
    return {
        ...device,
        platform,
        name:
            platform === 'web'
                ? location.hostname
                : platform === 'desktop'
                  ? `Cerebr Desktop · ${os}`
                  : `Cerebr Extension · ${os}`,
        origin: location.origin,
        version:
            typeof __CEREBR_VERSION__ !== 'undefined'
                ? __CEREBR_VERSION__
                : chrome.runtime.getManifest().version,
    };
}
const send = (message) => {
    if (socket?.readyState === 1) socket.send(JSON.stringify(message));
};
let statsDue = 0, statsTimer;
async function reportStats() {
    if (Date.now() - statsDue < 10000) {
        if (!statsTimer) statsTimer = setTimeout(() => { statsTimer = null; void reportStats().catch(() => {}); }, 10000 - (Date.now() - statsDue));
        return;
    }
    clearTimeout(statsTimer); statsTimer = null;
    statsDue = Date.now();
    // The client already maintains these totals incrementally. Heartbeats and
    // catch-up rounds must not reread the entire history (including images).
    const counts = cloudSyncStore.getSnapshot().localSummary;
    if (counts) send({ type: 'client-stats', chats: counts.chats, messages: counts.messages });
}
async function connect() {
    if (stopped || !authData?.token) return;
    const current = ++generation;
    clearTimeout(retry);
    clearInterval(heartbeat);
    clearTimeout(statsTimer); statsTimer = null; statsDue = 0;
    client?.close();
    client = null;
    socket?.close();
    emitStatus({ connecting: true, connected: false, syncing: false, verification: null, error: null, user: authData.user });
    const device = await metadata();
    if (current !== generation) return;
    const ws = new WebSocket(CLOUD_SYNC_URL.replace(/^http/, 'ws') + '/sync');
    socket = ws;
    lastReceived = Date.now();
    lastReconciled = Date.now();
    let queue = Promise.resolve(),
        authenticationError = false;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: authData.token, client: device }));
    ws.onmessage = (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        if (current !== generation) return;
        lastReceived = Date.now();
        if (client && ['progress', 'live-chat'].includes(message.type)) {
            void client.receive(message);
            return;
        }
        queue = queue
            .then(async () => {
                if (current !== generation) return;
                if (message.type === 'authenticated') {
                    authData.user = message.user;
                    await storageAdapter.set({ [AUTH]: authData });
                    await ensureApiReplica();
                    client = await createSyncClient({
                        db: await getDb(),
                        send,
                        onLive: emitLive,
                        onProgress: emitProgress,
                        onStatus: (s) => {
                            emitStatus({ ...s, ...(s.connected !== undefined || s.error ? { connecting: false } : {}), ...(s.error ? { syncing: false } : {}) });
                            if (s.lastSyncAt) void reportStats().catch(() => {});
                        },
                    });
                    if (current !== generation) {
                        client.close();
                        return;
                    }
                    client.start();
                    heartbeat = setInterval(() => {
                        if (Date.now() - lastReceived > 45000) {
                            // WebSockets can remain OPEN after sleep or a network
                            // change. Replace the stale connection explicitly.
                            void connect();
                            return;
                        }
                        send({ type: 'ping' });
                        if (!cloudSyncStore.getSnapshot().syncing && Date.now() - lastReconciled > 30000) void recoverSync();
                    }, 15000);
                } else if (message.type === 'auth-error') {
                    authenticationError = true;
                    emitStatus({ connected: false, connecting: false, error: message.error });
                } else await client?.receive(message);
            })
            .catch((error) => emitStatus({ error: error.message, connecting: false }));
    };
    ws.onclose = (event) => {
        if (current !== generation) return;
        client?.close();
        client = null;
        clearInterval(heartbeat);
        clearTimeout(statsTimer); statsTimer = null;
        emitStatus({
            connected: false,
            connecting: false,
            syncing: false,
            ...(event.code === 4003 ? { error: '同步已被暂停或账号已封禁，请联系管理员。' } : {}),
        });
        if (authenticationError || event.code === 4003) stopped = true;
        if (!stopped && !authenticationError && event.code !== 4003)
            retry = setTimeout(() => void connect(), 5000);
    };
    ws.onerror = () => emitStatus({ error: '暂时无法连接云端，本地聊天已保留。' });
}
async function recoverSync() {
    if (stopped || !authData?.token || recovering) return recovering;
    if (!client || socket?.readyState !== 1 || Date.now() - lastReceived > 45000) {
        if (!cloudSyncStore.getSnapshot().connecting) await connect();
        return;
    }
    if (cloudSyncStore.getSnapshot().connecting) return;
    const current = generation;
    lastReconciled = Date.now();
    recovering = client.reconcile().catch((error) => {
        if (current !== generation || stopped) return;
        emitStatus({ error: error.message, syncing: false });
        void connect();
    }).finally(() => { recovering = null; });
    return recovering;
}
async function runAction(action, payload) {
    if (action === 'login' || action === 'register') {
        const result = await api('/auth/' + action, payload, null);
        authData = result;
        stopped = false;
        await storageAdapter.set({ [AUTH]: result });
        emitStatus({ user: result.user, error: null });
        void connect();
        return { ok: true };
    }
    if (action === 'logout') {
        stopped = true;
        generation++;
        clearTimeout(retry);
        clearInterval(heartbeat);
        clearTimeout(statsTimer); statsTimer = null;
        socket?.close();
        client?.close();
        client = null;
        try {
            await api('/auth/logout', {});
        } catch {}
        authData = null;
        await storageAdapter.remove(AUTH);
        emitStatus({
            user: null,
            connected: false,
            connecting: false,
            syncing: false,
            error: null,
            verification: null,
            summary: null,
            localSummary: null,
        });
        return { ok: true };
    }
    if (action === 'connect') {
        stopped = false;
        void connect();
        return { ok: true };
    }
    if (action === 'verify') {
        if (!client) throw new Error('请先连接云端同步。');
        // A mismatch is repairable, not a permanent "waiting" state. Refresh
        // manifests before checking, and retry once if another device wrote
        // while the digest was being calculated.
        let verification = await client.verify();
        if (!verification.matches) verification = await client.verify();
        emitStatus({ verification });
        return verification;
    }
    throw new Error('Unknown sync action');
}
export async function cloudSyncAction(action, payload) {
    if (isExtensionEnvironment && !background) {
        const result = await chrome.runtime.sendMessage({ type: 'CEREBR_CLOUD_ACTION', action, payload });
        if (result?.error) throw new Error(result.error);
        return result;
    }
    return runAction(action, payload);
}
export function publishCloudLive(frame) {
    if (isExtensionEnvironment && !background)
        void chrome.runtime
            .sendMessage({ type: 'CEREBR_CLOUD_SEND', message: { type: 'live-chat', frame } })
            .catch(() => {});
    else client?.live(frame);
}
export function publishCloudProgress(progress) {
    if (isExtensionEnvironment && !background)
        void chrome.runtime
            .sendMessage({ type: 'CEREBR_CLOUD_SEND', message: { type: 'progress', progress } })
            .catch(() => {});
    else client?.progress(progress);
}
export function startCloudSync() {
    if (initialized) return initialized;
    initialized = (async () => {
        if (isExtensionEnvironment && !background) {
            const state = (await chrome.storage.local.get(STATUS))[STATUS];
            if (state) cloudSyncStore.set(state);
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area === 'local' && changes[STATUS]) cloudSyncStore.set(changes[STATUS].newValue);
            });
            chrome.runtime.onMessage.addListener((message, sender) => {
                if (sender.id !== chrome.runtime.id) return;
                if (message.type === 'CEREBR_CLOUD_LIVE') emitLive(message.frame);
                if (message.type === 'CEREBR_CLOUD_PROGRESS') emitProgress(message.progress);
            });
            return;
        }
        if (background)
            chrome.runtime.onMessage.addListener((m, sender, respond) => {
                if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')))
                    return;
                if (m.type === 'CEREBR_CLOUD_ACTION') {
                    void runAction(m.action, m.payload).then(respond, (e) => respond({ error: e.message }));
                    return true;
                }
                if (m.type === 'CEREBR_CLOUD_SEND') {
                    if (m.message?.type === 'live-chat') client?.live(m.message.frame);
                    if (m.message?.type === 'progress') client?.progress(m.message.progress);
                    respond({ ok: true });
                    return false;
                }
            });
        authData = (await storageAdapter.get(AUTH))[AUTH];
        if (typeof window !== 'undefined') {
            const resume = () => {
                if (document.visibilityState !== 'hidden') void recoverSync();
            };
            window.addEventListener('online', resume);
            window.addEventListener('pageshow', resume);
            window.addEventListener('focus', resume);
            document.addEventListener('visibilitychange', resume);
        }
        if (authData?.token) void connect();
    })();
    return initialized;
}
