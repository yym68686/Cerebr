import { withDb, storageAdapter } from '../../utils/storage-adapter.js';
import { createSyncClient } from './client.js';
import { SYNC_PORT } from './protocol.js';
import { BROWSER_BRIDGE_VERSION } from './browser-protocol.js';
import { subscribeWebpageSwitches } from '../../utils/webpage-switches.js';
import { startApiSettingsExtensionBridge } from './api-settings-extension.js';
import { ensureApiReplica } from './api-settings.js';
import { applyLiveChat, getLiveFrames, clearLiveChats, settleLiveChat } from './live-chat.js';
const CONFIG = 'cerebr_desktop_pairing_v1';
const STATUS = 'cerebr_desktop_sync_status_v1';
export function startExtensionSync({ browserRequest } = {}) {
    const stopApiBridge = startApiSettingsExtensionBridge();
    let socket,
        client,
        retry,
        heartbeat,
        stopped = false,
        connecting = false;
    let status = { connected: false, error: null };
    const publish = (patch) => {
        status = { ...status, ...patch };
        void chrome.storage.local.set({ [STATUS]: status });
    };
    const connect = async (code) => {
        if (connecting) return;
        clearTimeout(retry);
        connecting = true;
        const config = (await chrome.storage.local.get(CONFIG))[CONFIG];
        if (stopped || (!code && !config?.token)) {
            connecting = false;
            return;
        }
        socket?.close();
        client?.close();
        client = null;
        clearInterval(heartbeat);
        const ws = new WebSocket(`ws://127.0.0.1:${SYNC_PORT}`);
        socket = ws;
        const isCurrent = () => !stopped && socket === ws;
        let queue = Promise.resolve();
        ws.onopen = () =>
            ws.send(
                JSON.stringify(
                    code
                        ? { type: 'pair', code: code.trim().toUpperCase() }
                        : { type: 'auth', token: config.token }
                )
            );
        ws.onmessage = (event) => {
            if (!isCurrent()) return;
            const immediate = JSON.parse(event.data);
            if (client && ['progress', 'live-chat'].includes(immediate.type)) {
                void client.receive(immediate);
                return;
            }
            queue = queue
                .then(async () => {
                    if (!isCurrent()) return;
                    const message = immediate;
                    if (message.type === 'paired' || message.type === 'authenticated') {
                        if (message.token)
                            await chrome.storage.local.set({ [CONFIG]: { token: message.token } });
                        // Migrate navigation metadata through the established adapter.
                        await storageAdapter.get('cerebr_chat_organization_v1');
                        await withDb(ensureApiReplica);
                        const nextClient = await createSyncClient({
                            withDatabase: withDb,
                            send: (m) => {
                                if (ws.readyState === 1) ws.send(JSON.stringify(m));
                            },
                            onStatus: (patch) => { if (isCurrent()) publish(patch); },
                            onProgress: (progress) => {
                                if (progress.phase === 'idle') settleLiveChat(progress.chatId);
                                void chrome.runtime
                                    .sendMessage({ type: 'CEREBR_SYNC_PROGRESS', progress })
                                    .catch(() => {});
                            },
                            onLive: (frame) => {
                                applyLiveChat(frame);
                                void chrome.runtime
                                    .sendMessage({ type: 'CEREBR_SYNC_LIVE', frame })
                                    .catch(() => {});
                            },
                        });
                        if (!isCurrent() || ws.readyState !== 1) {
                            nextClient.close();
                            return;
                        }
                        client = nextClient;
                        client.start();
                        if (browserRequest)
                            ws.send(
                                JSON.stringify({ type: 'browser-ready', version: BROWSER_BRIDGE_VERSION })
                            );
                        publish({ connected: true, error: null });
                        clearInterval(heartbeat);
                        heartbeat = setInterval(() => {
                            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
                        }, 20000);
                    } else if (message.type === 'browser-request' && browserRequest) {
                        // Page extraction can be slow. Keep history and other tab
                        // requests flowing while this independent request runs.
                        void Promise.resolve()
                            .then(() => browserRequest(message.message))
                            .then(
                                (result) => {
                                    if (ws.readyState === 1)
                                        ws.send(
                                            JSON.stringify({
                                                type: 'browser-response',
                                                id: message.id,
                                                result,
                                            })
                                        );
                                },
                                (error) => {
                                    if (ws.readyState === 1)
                                        ws.send(
                                            JSON.stringify({
                                                type: 'browser-response',
                                                id: message.id,
                                                error: error.message,
                                            })
                                        );
                                }
                            );
                    } else if (message.type === 'error') publish({ error: message.error });
                    else await client?.receive(message);
                })
                .catch((error) => {
                    if (!isCurrent()) return;
                    publish({ error: error.message });
                    // An authenticated socket without a replica cannot become
                    // ready. Reconnect using the stored pairing after onclose.
                    if (immediate.type === 'paired' || immediate.type === 'authenticated') ws.close();
                });
        };
        ws.onerror = () => {
            if (socket === ws && !stopped) publish({ connected: false, error: null });
        };
        ws.onclose = () => {
            if (socket !== ws) return;
            socket = null;
            connecting = false;
            client?.close();
            client = null;
            clearLiveChats();
            clearInterval(heartbeat);
            publish({ connected: false });
            if (!stopped) retry = setTimeout(() => void connect(), 5000);
        };
    };
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        // Only extension-owned pages may pair, send data or command synchronization.
        if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
        if (message.type === 'CEREBR_DESKTOP_PAIR') {
            stopped = false;
            connecting = false;
            void connect(message.code).then(() => respond({ ok: true }));
            return true;
        }
        if (message.type === 'CEREBR_DESKTOP_DISCONNECT') {
            stopped = true;
            clearTimeout(retry);
            socket?.close();
            void chrome.storage.local.remove(CONFIG).then(() => {
                publish({ connected: false, error: null });
                respond({ ok: true });
            });
            return true;
        }
        if (message.type === 'CEREBR_DESKTOP_STATUS') {
            respond(status);
            return false;
        }
        if (message.type === 'CEREBR_DESKTOP_LIVE') {
            respond({ frames: getLiveFrames() });
            return false;
        }
        if (message.type === 'CEREBR_DESKTOP_VERIFY') {
            if (!client) {
                respond({ error: '请先连接桌面应用。' });
                return false;
            }
            void client
                .verify()
                .then((result) => respond(result))
                .catch((error) => respond({ error: error.message }));
            return true;
        }
        if (message.type === 'CEREBR_LOCAL_PROGRESS') {
            client?.progress(message.progress);
            respond({ ok: true });
            return false;
        }
        if (message.type === 'CEREBR_LOCAL_LIVE') {
            client?.live(message.frame);
            respond({ ok: true });
            return false;
        }
    });
    const emitBrowserEvent = (event) => {
        if (socket?.readyState === 1 && client) socket.send(JSON.stringify({ type: 'browser-event', event }));
    };
    const unsubscribeSelection = subscribeWebpageSwitches((chatId) =>
        emitBrowserEvent({ type: 'selection-changed', chatId })
    );
    void connect();
    return {
        emitBrowserEvent,
        dispose: () => {
            stopped = true;
            clearTimeout(retry);
            clearInterval(heartbeat);
            socket?.close();
            client?.close();
            unsubscribeSelection();
            stopApiBridge();
        },
    };
}
