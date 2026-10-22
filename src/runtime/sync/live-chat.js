// Live views are transient. Durable history still uses versioned replica records.
const views = new Map(),
    listeners = new Set();
export const subscribeLiveChats = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
};
export const getLiveChat = (id) => views.get(id)?.chat;
export const getLiveChats = () => [...views.values()].map((view) => view.chat);
export const getLiveFrames = () => [...views.values()].map((view) => ({ ...view, chatId: view.chat.id }));
export function settleLiveChat(id) { const view = views.get(id); if (view) view.phase = 'idle'; }
export function applyLiveChat(frame) {
    if (
        !frame ||
        typeof frame.chatId !== 'string' ||
        typeof frame.requestId !== 'string' ||
        !Number.isSafeInteger(frame.sequence)
    )
        return false;
    const previous = views.get(frame.chatId);
    if (previous?.startedAt > frame.startedAt || (!frame.chat && previous?.requestId !== frame.requestId))
        return false;
    if (previous?.requestId === frame.requestId && previous.sequence >= frame.sequence) return false;
    if (previous?.phase === 'idle' && previous.startedAt >= frame.startedAt && frame.phase !== 'idle') return false;
    const chat = frame.chat || previous?.chat;
    if (!chat || chat.id !== frame.chatId || !Array.isArray(chat.messages)) return false;
    let next = chat;
    if (
        frame.message &&
        Number.isSafeInteger(frame.index) &&
        frame.index >= 0 &&
        frame.index <= chat.messages.length
    ) {
        next = { ...chat, messages: [...chat.messages.slice(0, frame.index), frame.message] };
    }
    views.set(frame.chatId, {
        requestId: frame.requestId,
        sequence: frame.sequence,
        phase: frame.phase,
        startedAt: frame.startedAt,
        chat: next,
    });
    listeners.forEach((fn) => fn());
    return true;
}
export function reconcileLiveChat(chatId, durable) {
    const view = views.get(chatId);
    if (!view) return;
    if (
        !durable ||
        (view.phase === 'idle' && (
            Date.parse(durable.updatedAt) > Date.parse(view.chat.updatedAt) ||
            JSON.stringify(view.chat.messages) === JSON.stringify(durable.messages?.slice(0, view.chat.messages.length))
        ))
    ) {
        views.delete(chatId);
        listeners.forEach((fn) => fn());
    }
}
export function clearLiveChats() {
    views.clear();
    listeners.forEach((fn) => fn());
}
export function clearLiveChat(id) {
    views.delete(id);
}
