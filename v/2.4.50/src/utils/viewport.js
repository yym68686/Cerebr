function roundPx(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0px';
    return `${Math.round(n)}px`;
}

function toNumberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function getViewportMetrics() {
    const vv = window.visualViewport;
    if (!vv) {
        return {
            height: window.innerHeight,
            offsetTop: 0
        };
    }

    const height = toNumberOr(vv.height, window.innerHeight);
    let offsetTop = toNumberOr(vv.offsetTop, 0);

    // iOS Safari (esp. after scrolling inner containers) can report a transient negative offsetTop.
    // Applying it directly makes the fixed layout "jump" upward before settling.
    if (offsetTop < 0) offsetTop = 0;

    return {
        height,
        offsetTop
    };
}

function applyViewportCssVars() {
    const { height, offsetTop } = getViewportMetrics();

    // Used by CSS to keep the fixed app container aligned to the *visual* viewport (iOS keyboard, etc.).
    document.documentElement.style.setProperty('--vv-height', roundPx(height));
    document.documentElement.style.setProperty('--vv-offset-top', roundPx(offsetTop));

    // Backward-compatible: some older rules may still reference --vh.
    document.documentElement.style.setProperty('--vh', `${(Number(height) || 0) * 0.01}px`);
}

function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

function getInputOverlapPx(chatContainer) {
    const inputContainer = document.getElementById('input-container');
    if (!chatContainer || !inputContainer) return 0;

    const containerRect = chatContainer.getBoundingClientRect();
    const inputRect = inputContainer.getBoundingClientRect();
    return Math.max(0, containerRect.bottom - inputRect.top);
}

function getEffectiveChatVisibleHeight(chatContainer) {
    if (!chatContainer) return 0;
    const overlapPx = getInputOverlapPx(chatContainer);
    return Math.max(0, Math.round(chatContainer.clientHeight - overlapPx));
}

let lastEffectiveChatHeight = null;
let scheduleRafId = 0;
let pendingPreserveScroll = false;

let settleToken = 0;

function settleViewport({ preserveScroll = false, maxMs = 1400 } = {}) {
    const token = ++settleToken;
    const startAt = performance.now();
    let last = getViewportMetrics();
    let stableFrames = 0;

    scheduleViewportUpdate({ preserveScroll });

    const tick = () => {
        if (token !== settleToken) return;

        const now = performance.now();
        const current = getViewportMetrics();
        const heightDelta = Math.abs(current.height - last.height);
        const topDelta = Math.abs(current.offsetTop - last.offsetTop);
        const changed = heightDelta > 0.5 || topDelta > 0.5;

        if (changed) {
            stableFrames = 0;
            last = current;
            scheduleViewportUpdate({ preserveScroll });
        } else {
            stableFrames += 1;
        }

        if (stableFrames >= 6) return;
        if (now - startAt >= maxMs) return;
        requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
}

function applyViewportUpdate({ preserveScroll } = {}) {
    const chatContainer = document.getElementById('chat-container');
    const previousEffectiveHeight =
        chatContainer && lastEffectiveChatHeight != null
            ? lastEffectiveChatHeight
            : (chatContainer ? getEffectiveChatVisibleHeight(chatContainer) : null);
    const previousBottomY =
        chatContainer && previousEffectiveHeight != null
            ? chatContainer.scrollTop + previousEffectiveHeight
            : null;

    applyViewportCssVars();

    if (!chatContainer) return;

    requestAnimationFrame(() => {
        if (!chatContainer.isConnected) return;

        const newEffectiveHeight = getEffectiveChatVisibleHeight(chatContainer);

        if (preserveScroll && previousBottomY != null && lastEffectiveChatHeight != null) {
            const targetScrollTop = previousBottomY - newEffectiveHeight;
            const maxScrollTop = Math.max(0, chatContainer.scrollHeight - chatContainer.clientHeight);
            chatContainer.scrollTop = clamp(targetScrollTop, 0, maxScrollTop);
        }

        lastEffectiveChatHeight = newEffectiveHeight;
    });
}

function scheduleViewportUpdate({ preserveScroll = false } = {}) {
    pendingPreserveScroll = pendingPreserveScroll || preserveScroll;
    if (scheduleRafId) return;

    scheduleRafId = requestAnimationFrame(() => {
        const preserve = pendingPreserveScroll;
        pendingPreserveScroll = false;
        scheduleRafId = 0;
        applyViewportUpdate({ preserveScroll: preserve });
    });
}

// Initial vars early (DOM may not be ready yet).
applyViewportCssVars();

window.addEventListener('resize', () => scheduleViewportUpdate({ preserveScroll: true }));

if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => scheduleViewportUpdate({ preserveScroll: true }));
    // iOS may change visualViewport.offsetTop without firing a window resize.
    window.visualViewport.addEventListener('scroll', () => scheduleViewportUpdate({ preserveScroll: false }));
}

document.addEventListener('DOMContentLoaded', () => {
    // Establish baseline after layout exists.
    scheduleViewportUpdate({ preserveScroll: false });

    const input = document.getElementById('message-input');
    if (!input) return;

    input.addEventListener('focus', () => {
        settleViewport({ preserveScroll: true, maxMs: 1600 });
    });

    input.addEventListener('blur', () => {
        settleViewport({ preserveScroll: true, maxMs: 1800 });
    });
});
