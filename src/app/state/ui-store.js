import { createStore } from './store.js';
export const uiStore = createStore({
    page: null,
    menu: false,
    webpageMenu: false,
    navigationOpen: false,
    context: null,
    image: null,
    toasts: [],
    editing: null,
    localRequests: {},
    phase: 'idle',
    requestChatId: null,
    requestStartedAt: null,
    remoteProgress: {},
    remoteStartedAt: {},
});
export const openPage = (page) =>
    uiStore.set({ page, menu: false, webpageMenu: false, context: null, navigationOpen: false });
export function notify(message, { type = 'info', durationMs = 1600 } = {}) {
    if (!message) return;
    const id = crypto.randomUUID();
    uiStore.set((s) => ({ ...s, toasts: [...s.toasts, { id, message, type }] }));
    setTimeout(() => {
        uiStore.set((s) => ({
            ...s,
            toasts: s.toasts.map((t) => (t.id === id ? { ...t, hiding: true } : t)),
        }));
        setTimeout(() => uiStore.set((s) => ({ ...s, toasts: s.toasts.filter((t) => t.id !== id) })), 180);
    }, durationMs);
}
