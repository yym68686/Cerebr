import { addRootScrollListener, getClientHeight, getScrollHeight, getScrollTop, removeRootScrollListener, scrollToTop } from './scroll-root.js';

const READING_PROGRESS_KEY_PREFIX = 'cerebr_reading_progress_v1_';

function keyForChatId(chatId) {
    return `${READING_PROGRESS_KEY_PREFIX}${chatId}`;
}

function clamp(value, min, max) {
    if (Number.isNaN(value)) return min;
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

function getFirstVisibleMessageState(chatContainer, marginPx = 12) {
    const messages = chatContainer.querySelectorAll('.message');
    if (!messages.length) return null;

    const scrollTop = getScrollTop();
    const containerTopDoc = chatContainer.getBoundingClientRect().top + scrollTop;
    const visibleTop = (scrollTop + marginPx) - containerTopDoc;

    // Binary search for the first message whose bottom >= visibleTop.
    let lo = 0;
    let hi = messages.length - 1;
    let ans = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const el = messages[mid];
        const bottom = el.offsetTop + el.offsetHeight;
        if (bottom >= visibleTop) {
            ans = mid;
            hi = mid - 1;
        } else {
            lo = mid + 1;
        }
    }

    const anchor = messages[ans];
    if (!anchor) return null;

    const anchorTopDoc = containerTopDoc + anchor.offsetTop;
    const anchorOffsetPx = Math.round(scrollTop - anchorTopDoc);
    return {
        anchorIndex: ans,
        anchorOffsetPx
    };
}

export function createReadingProgressManager({
    chatContainer,
    getActiveChatId,
    storage
}) {
    let isStarted = false;
    let isRestoring = false;
    let saveTimer = null;
    let pendingChatId = null;
    let pendingPayload = null;
    let lastSavedChatId = null;
    let lastSavedPayload = null;
    let pendingRestoreChatId = null;

    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

    const saveNow = async (chatId = getActiveChatId?.()) => {
        if (!chatId) return;
        if (!chatContainer?.isConnected) return;
        if (isRestoring) return;

        const anchorState = getFirstVisibleMessageState(chatContainer);
        if (!anchorState) return;

        const payload = {
            v: 1,
            ...anchorState,
            updatedAt: Date.now()
        };

        // Avoid hammering storage when nothing changed.
        if (lastSavedChatId === chatId && lastSavedPayload) {
            if (lastSavedPayload.anchorIndex === payload.anchorIndex &&
                lastSavedPayload.anchorOffsetPx === payload.anchorOffsetPx) {
                return;
            }
        }

        lastSavedChatId = chatId;
        lastSavedPayload = payload;
        await storage.set({ [keyForChatId(chatId)]: payload });
    };

    const flushPending = async () => {
        if (!pendingChatId || !pendingPayload) return;
        const chatId = pendingChatId;
        const payload = pendingPayload;
        pendingChatId = null;
        pendingPayload = null;

        if (lastSavedChatId === chatId && lastSavedPayload) {
            if (lastSavedPayload.anchorIndex === payload.anchorIndex &&
                lastSavedPayload.anchorOffsetPx === payload.anchorOffsetPx) {
                return;
            }
        }

        lastSavedChatId = chatId;
        lastSavedPayload = payload;
        await storage.set({ [keyForChatId(chatId)]: payload });
    };

    const queueSave = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => void flushPending(), 120);
    };

    const onScroll = () => {
        if (!isStarted) return;
        if (isRestoring) return;
        // While we have a pending restore, don't overwrite stored progress with the initial top position.
        if (pendingRestoreChatId) return;

        const chatId = getActiveChatId?.();
        if (!chatId) return;
        if (!chatContainer?.isConnected) return;

        const anchorState = getFirstVisibleMessageState(chatContainer);
        if (!anchorState) return;

        const payload = {
            v: 1,
            ...anchorState,
            updatedAt: Date.now()
        };

        pendingChatId = chatId;
        pendingPayload = payload;
        queueSave();
    };

    const onVisibilityChange = () => {
        if (document.visibilityState === 'hidden') {
            clearTimeout(saveTimer);
            void saveNow();
        }
    };

    const onBeforeUnload = () => {
        clearTimeout(saveTimer);
        void saveNow();
    };

    const restore = async (chatId) => {
        if (!chatId) return false;
        if (!chatContainer?.isConnected) return false;

        pendingRestoreChatId = chatId;
        isRestoring = true;
        try {
            const key = keyForChatId(chatId);
            const result = await storage.get(key);
            const state = result?.[key];

            // Allow one layout tick after messages are rendered.
            await nextFrame();
            await nextFrame();

            const messages = chatContainer.querySelectorAll('.message');
            if (!messages.length) return false;

            let targetScrollTop;
            if (!state || typeof state !== 'object') {
                targetScrollTop = getScrollHeight();
            } else {
                const anchorIndex = typeof state.anchorIndex === 'number' ? state.anchorIndex : 0;
                const anchorOffsetPx = typeof state.anchorOffsetPx === 'number' ? state.anchorOffsetPx : 0;
                if (anchorIndex >= messages.length) {
                    return false;
                }
                const clampedIndex = clamp(anchorIndex, 0, messages.length - 1);
                const anchor = messages[clampedIndex];
                const scrollTopNow = getScrollTop();
                const containerTopDoc = chatContainer.getBoundingClientRect().top + scrollTopNow;
                targetScrollTop = containerTopDoc + (anchor?.offsetTop || 0) + anchorOffsetPx;
            }

            const maxScrollTop = Math.max(0, getScrollHeight() - getClientHeight());
            scrollToTop(clamp(targetScrollTop, 0, maxScrollTop), 'auto');
            return true;
        } catch {
            return false;
        } finally {
            pendingRestoreChatId = null;
            isRestoring = false;
        }
    };

    const clear = async (chatId) => {
        if (!chatId) return;
        await storage.remove(keyForChatId(chatId));
    };

    const start = () => {
        if (isStarted) return;
        isStarted = true;
        addRootScrollListener(onScroll, { passive: true });
        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('beforeunload', onBeforeUnload);
    };

    const stop = () => {
        if (!isStarted) return;
        isStarted = false;
        clearTimeout(saveTimer);
        saveTimer = null;
        pendingChatId = null;
        pendingPayload = null;
        pendingRestoreChatId = null;
        removeRootScrollListener(onScroll);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('beforeunload', onBeforeUnload);
    };

    return {
        start,
        stop,
        restore,
        clear,
        saveNow
    };
}
