import { createStore } from '../../app/state/store.js';
import { getDb, isExtensionEnvironment } from '../../utils/storage-adapter.js';
import { createSyncClient } from './client.js';
import { startCloudSync, publishCloudLive, publishCloudProgress, subscribeCloudLive, subscribeCloudProgress } from './cloud-sync.js';
import { applyLiveChat, clearLiveChat, clearLiveChats, settleLiveChat } from './live-chat.js';
import { updateDesktopBrowser, emitDesktopBrowserEvent } from '../../platform/desktop-browser.js';
export const isDesktop = !!globalThis.cerebrDesktop;
export const desktopSyncStore = createStore({
    connected: false,
    lastSyncAt: null,
    error: null,
    peers: 0,
    pairingCode: null,
});
const progressListeners = new Set();
const latestProgress = new Map();
const localRequests = new Set();
let desktopClient;
export const subscribeRemoteProgress = (fn) => {
    progressListeners.add(fn);
    for (const value of latestProgress.values()) fn(value);
    return () => progressListeners.delete(fn);
};
const progress = (value) => {
    if (value.reset) {
        clearLiveChats();
        latestProgress.clear();
    } else if (value.phase === 'idle') { latestProgress.delete(value.chatId); settleLiveChat(value.chatId); }
    else latestProgress.set(value.chatId, value);
    progressListeners.forEach((fn) => fn(value));
};
const live = (frame) => {
    if (localRequests.has(frame.chatId)) return;
    if (applyLiveChat(frame))
        progress({ chatId: frame.chatId, phase: frame.phase, startedAt: frame.startedAt });
};
export async function startUISync() {
    subscribeCloudLive(live);
    subscribeCloudProgress(progress);
    void startCloudSync().catch((error)=>console.error('[Cerebr] Cloud sync initialization failed',error));
    if (isDesktop) {
        const unsubscribe = globalThis.cerebrDesktop.onMessage(
            (message) => void desktopClient?.receive(message)
        );
        desktopClient = await createSyncClient({
            db: await getDb(),
            send: globalThis.cerebrDesktop.send,
            onStatus: (s) => desktopSyncStore.set(s),
            onProgress: progress,
            onLive: live,
        });
        desktopClient.start();
        const status = await globalThis.cerebrDesktop.status();
        desktopSyncStore.set(status);
        updateDesktopBrowser(status);
        globalThis.cerebrDesktop.onStatus((s) => {
            desktopSyncStore.set(s);
            updateDesktopBrowser(s);
            if (!s.connected) progress({ reset: true });
        });
        globalThis.cerebrDesktop.onBrowserEvent(emitDesktopBrowserEvent);
        return unsubscribe;
    }
    if (isExtensionEnvironment) {
        const status = await chrome.runtime.sendMessage({ type: 'CEREBR_DESKTOP_STATUS' }).catch(() => null);
        if (status) desktopSyncStore.set(status);
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.cerebr_desktop_sync_status_v1) {
                desktopSyncStore.set(changes.cerebr_desktop_sync_status_v1.newValue);
                if (!changes.cerebr_desktop_sync_status_v1.newValue?.connected) progress({ reset: true });
            }
        });
        chrome.runtime.onMessage.addListener((message, sender) => {
            if (sender.id === chrome.runtime.id && message.type === 'CEREBR_SYNC_PROGRESS')
                progress(message.progress);
            if (sender.id === chrome.runtime.id && message.type === 'CEREBR_SYNC_LIVE') live(message.frame);
        });
        const snapshot = await chrome.runtime.sendMessage({ type: 'CEREBR_DESKTOP_LIVE' }).catch(() => null);
        for (const frame of snapshot?.frames || []) live(frame);
    }
}
export function publishLiveChat(frame) {
    if (frame.phase === 'thinking') {
        localRequests.add(frame.chatId);
        clearLiveChat(frame.chatId);
    }
    if (frame.phase === 'idle') localRequests.delete(frame.chatId);
    publishCloudLive(frame);
    if (isDesktop) desktopClient?.live(frame);
    else if (isExtensionEnvironment)
        void chrome.runtime.sendMessage({ type: 'CEREBR_LOCAL_LIVE', frame }).catch(() => {});
}
export function publishProgress(value) {
    publishCloudProgress(value);
    if (isDesktop) desktopClient?.progress(value);
    else if (isExtensionEnvironment)
        void chrome.runtime.sendMessage({ type: 'CEREBR_LOCAL_PROGRESS', progress: value }).catch(() => {});
}
export async function pairDesktop(code) {
    return chrome.runtime.sendMessage({ type: 'CEREBR_DESKTOP_PAIR', code });
}
export async function disconnectDesktopSync() {
    await chrome.runtime.sendMessage({ type: 'CEREBR_DESKTOP_DISCONNECT' });
    desktopSyncStore.set({ connected: false, verification: null });
}
export async function refreshDesktopPairing() {
    desktopSyncStore.set(await globalThis.cerebrDesktop.pairing());
}
export async function verifyDesktopSync() {
    const result = isDesktop
        ? await desktopClient.verify()
        : await chrome.runtime.sendMessage({ type: 'CEREBR_DESKTOP_VERIFY' });
    if (result.error) throw new Error(result.error);
    desktopSyncStore.set({ verification: result });
    return result;
}
