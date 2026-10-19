import { createStore } from '../app/state/store.js';

export const desktopBrowserStore = createStore({ session: null });
const listeners = new Set();
export function updateDesktopBrowser(status) {
    const session = status.connected ? status.browserSession || null : null;
    desktopBrowserStore.set({ session });
}
export function emitDesktopBrowserEvent(event) {
    for (const listener of listeners) listener(event);
}
export function onDesktopBrowserEvent(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
export function desktopBrowserRequest(message) {
    const session = desktopBrowserStore.getSnapshot().session;
    if (!session) return Promise.reject(new Error('Browser extension is disconnected'));
    return globalThis.cerebrDesktop.browserRequest({ session, message });
}
