import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { SyncDatabase } from './sync-database';
import { chmodSync } from 'node:fs';
import { BrowserBroker } from './browser-broker';
import { BROWSER_BRIDGE_VERSION } from '../../src/runtime/sync/browser-protocol.js';
import { SYNC_PORT, SYNC_PROTOCOL } from '../../src/runtime/sync/protocol.js';
const parent = (process as any).parentPort;
const db = new SyncDatabase(process.argv[2]);
chmodSync(process.argv[2], 0o600);
const peers = new Map<any, { origin: string; actor?: string }>();
const activeProgress = new Map<string, { source: any; progress: any }>();
const liveChats = new Map<string, { source: any; frame: any }>();
let pairingCode = randomBytes(5).toString('hex').toUpperCase(),
    pairingExpires = Date.now() + 600000;
const tokenHash = (s: string) => Buffer.from(s);
const equals = (a: string, b: string) => a.length === b.length && timingSafeEqual(tokenHash(a), tokenHash(b));
const send = (socket: any, message: any) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
};
const browserBroker = new BrowserBroker((message) => parent.postMessage(message), send);
const broadcast = (message: any, except?: any) => {
    parent.postMessage({ event: 'sync-message', message });
    for (const socket of peers.keys()) if (socket !== except) send(socket, message);
};
const status = () => ({
    connected: true,
    peers: peers.size,
    browserSession: browserBroker.session,
    pairingCode: Date.now() < pairingExpires ? pairingCode : null,
    ...db.summary(),
});
const publishStatus = () => parent.postMessage({ event: 'status', status: status() });
const clearProgress = (source: any) => {
    for (const [id, view] of liveChats) if (view.source === source) liveChats.delete(id);
    for (const [chatId, active] of activeProgress)
        if (active.source === source) {
            activeProgress.delete(chatId);
            broadcast({ type: 'progress', progress: { chatId, phase: 'idle' } });
        }
};
function handle(message: any, reply: (m: any) => void, source?: any) {
    if (message.type === 'hello') {
        reply({ type: 'manifest', records: db.manifest(), protocol: SYNC_PROTOCOL });
        for (const { progress } of activeProgress.values()) reply({ type: 'progress', progress });
        for (const { frame } of liveChats.values()) reply({ type: 'live-chat', frame });
    } else if (message.type === 'get' && Array.isArray(message.keys)) {
        for (const key of message.keys) {
            const record = db.get(key);
            if (record) reply({ type: 'record', record });
        }
        reply({ type: 'caught-up', id: message.id });
    } else if (message.type === 'put') {
        const result = db.put(message.record);
        reply({ type: 'record', record: result.record });
        if (result.changed) broadcast({ type: 'record', record: result.record }, source);
    } else if (message.type === 'live-chat') {
        const frame = message.frame;
        if (
            !frame ||
            typeof frame.chatId !== 'string' ||
            typeof frame.requestId !== 'string' ||
            !Number.isSafeInteger(frame.sequence) ||
            !Number.isFinite(frame.startedAt) ||
            !['idle', 'thinking', 'replying'].includes(frame.phase)
        )
            return;
        const previous = liveChats.get(frame.chatId);
        if (
            previous &&
            (previous.frame.startedAt > frame.startedAt ||
                (previous.frame.requestId === frame.requestId && previous.frame.sequence >= frame.sequence))
        )
            return;
        let chat = frame.chat || (previous && previous.frame.requestId === frame.requestId ? previous.frame.chat : null);
        if (
            !chat ||
            chat.id !== frame.chatId ||
            typeof chat.title !== 'string' ||
            !Array.isArray(chat.messages)
        )
            return;
        if (
            frame.message &&
            Number.isSafeInteger(frame.index) &&
            frame.index >= 0 &&
            frame.index <= chat.messages.length
        )
            chat = { ...chat, messages: [...chat.messages.slice(0, frame.index), frame.message] };
        const snapshot = { ...frame, chat };
        delete snapshot.message;
        delete snapshot.index;
        liveChats.set(frame.chatId, { source, frame: snapshot });
        // Avoid echoing a local stream back into its own mutable chat object.
        if (source !== undefined) parent.postMessage({ event: 'sync-message', message });
        for (const socket of peers.keys()) if (socket !== source) send(socket, message);
        // Finished snapshots only bridge the short gap until durable history arrives.
        if (frame.phase === 'idle')
            setTimeout(() => {
                if (liveChats.get(frame.chatId)?.frame === snapshot) liveChats.delete(frame.chatId);
            }, 30000).unref();
    } else if (message.type === 'progress') {
        const progress = message.progress;
        // Older clients used idle with a null ID. Clear their own entries so
        // upgrading one side cannot leave a permanent activity indicator.
        if (progress?.phase === 'idle' && progress.chatId == null) {
            clearProgress(source);
            return;
        }
        if (
            progress &&
            typeof progress.chatId === 'string' &&
            ['idle', 'thinking', 'replying'].includes(progress.phase)
        ) {
            if (progress.phase === 'idle') {
                if (
                    activeProgress.has(progress.chatId) &&
                    activeProgress.get(progress.chatId)?.source !== source
                )
                    return;
                activeProgress.delete(progress.chatId);
            } else
                activeProgress.set(progress.chatId, {
                    source,
                    progress: {
                        chatId: progress.chatId,
                        phase: progress.phase,
                        startedAt: progress.startedAt,
                    },
                });
            broadcast(
                {
                    type: 'progress',
                    progress: {
                        chatId: progress.chatId,
                        phase: progress.phase,
                        startedAt: progress.startedAt,
                    },
                },
                source
            );
        }
    } else if (message.type === 'ping') reply({ type: 'pong' });
    else if (message.type === 'barrier') {
        reply({ type: 'caught-up', id: message.id, summary: db.summary(message.verify === true) });
        publishStatus();
    }
}
parent.on('message', ({ data }: any) => {
    try {
        if (data.kind === 'clear-desktop-progress') clearProgress(undefined);
        if (data.kind === 'browser-request') browserBroker.request(data.requestId, data.payload);
        if (data.kind === 'message')
            handle(data.message, (message) => parent.postMessage({ event: 'sync-message', message }));
        if (data.kind === 'status') parent.postMessage({ requestId: data.requestId, result: status() });
        if (data.kind === 'pairing') {
            pairingCode = randomBytes(5).toString('hex').toUpperCase();
            pairingExpires = Date.now() + 600000;
            parent.postMessage({ requestId: data.requestId, result: status() });
            publishStatus();
        }
        if (data.kind === 'close') {
            db.close();
            process.exit(0);
        }
    } catch (error: any) {
        parent.postMessage({ requestId: data.requestId, error: error.message });
    }
});
const server = createServer((req, res) => {
    res.writeHead(404);
    res.end();
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 * 1024, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin || '';
    if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin) && !/^moz-extension:\/\/[a-z0-9-]+$/.test(origin)) {
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
        const timeout = setTimeout(() => ws.close(), 5000);
        let authenticated = false,
            queue = Promise.resolve();
        ws.on('message', (raw) => {
            queue = queue
                .then(() => {
                    const msg = JSON.parse(raw.toString());
                    if (!authenticated) {
                        const known = db.setting('peer:' + origin);
                        if (
                            msg.type === 'pair' &&
                            Date.now() < pairingExpires &&
                            typeof msg.code === 'string' &&
                            equals(msg.code, pairingCode)
                        ) {
                            const token = randomBytes(32).toString('hex');
                            db.setting('peer:' + origin, { token });
                            send(ws, { type: 'paired', token });
                            authenticated = true;
                            pairingExpires = 0;
                        } else if (
                            msg.type === 'auth' &&
                            known &&
                            typeof msg.token === 'string' &&
                            equals(msg.token, known.token)
                        ) {
                            authenticated = true;
                            send(ws, { type: 'authenticated', protocol: SYNC_PROTOCOL });
                        } else {
                            send(ws, {
                                type: 'error',
                                error: 'Pairing code or connection credential is invalid',
                            });
                            ws.close();
                            return;
                        }
                        clearTimeout(timeout);
                        peers.set(ws, { origin });
                        publishStatus();
                        return;
                    }
                    if (msg.type === 'browser-ready' && msg.version === BROWSER_BRIDGE_VERSION) {
                        browserBroker.add(ws);
                        publishStatus();
                    } else if (msg.type === 'browser-response') browserBroker.response(ws, msg);
                    else if (msg.type === 'browser-event') browserBroker.event(ws, msg.event);
                    else handle(msg, (message) => send(ws, message), ws);
                })
                .catch((error) => send(ws, { type: 'error', error: error.message }));
        });
        ws.on('close', () => {
            clearTimeout(timeout);
            peers.delete(ws);
            browserBroker.remove(ws);
            clearProgress(ws);
            publishStatus();
        });
        ws.on('error', () => {});
    });
});
server.on('error', (error) => parent.postMessage({ event: 'error', error: error.message }));
// Port 0 is reserved for the isolated bundled-worker smoke test.
server.listen(process.env.CEREBR_SYNC_TEST_PORT === '0' ? 0 : SYNC_PORT, '127.0.0.1', () => {
    parent.postMessage({ event: 'ready', port: (server.address() as any).port });
    publishStatus();
});
process.on('SIGTERM', () => {
    db.close();
    process.exit(0);
});
