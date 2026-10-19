import { createStore } from '../../app/state/store.js';
import { getDb, isExtensionEnvironment } from '../../utils/storage-adapter.js';
import { createSyncClient } from './client.js';
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
let desktopClient;
export const subscribeRemoteProgress = (fn) => {
    progressListeners.add(fn);
    return () => progressListeners.delete(fn);
};
const progress = (value) => progressListeners.forEach((fn) => fn(value));
export async function startUISync() {
    if (isDesktop) {
        const unsubscribe = globalThis.cerebrDesktop.onMessage(
            (message) => void desktopClient?.receive(message)
        );
        desktopClient = await createSyncClient({
            db: await getDb(),
            send: globalThis.cerebrDesktop.send,
            onStatus: (s) => desktopSyncStore.set(s),
            onProgress: progress,
        });
        desktopClient.start();
        const status = await globalThis.cerebrDesktop.status();
        desktopSyncStore.set(status);
        updateDesktopBrowser(status);
        globalThis.cerebrDesktop.onStatus((s) => {
            desktopSyncStore.set(s);
            updateDesktopBrowser(s);
            if(!s.connected)progress({reset:true});
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
                if(!changes.cerebr_desktop_sync_status_v1.newValue?.connected)progress({reset:true});
            }
        });
        chrome.runtime.onMessage.addListener((message, sender) => {
            if (sender.id === chrome.runtime.id && message.type === 'CEREBR_SYNC_PROGRESS')
                progress(message.progress);
        });
    }
}
export function publishProgress(value) {
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
