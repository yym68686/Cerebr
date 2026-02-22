function roundPx(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0px';
    return `${Math.round(n)}px`;
}

function getViewportMetrics() {
    const vv = window.visualViewport;
    if (!vv) {
        return {
            height: window.innerHeight,
            offsetTop: 0
        };
    }

    const height = Number(vv.height);
    const offsetTop = Number(vv.offsetTop);

    return {
        height: Number.isFinite(height) ? Math.max(0, height) : window.innerHeight,
        // iOS overscroll / toolbar animations can temporarily report negative offsetTop.
        offsetTop: Number.isFinite(offsetTop) ? Math.max(0, offsetTop) : 0
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

function scheduleViewportSettle({ preserveScroll = false, delaysMs } = {}) {
    // iOS Safari keyboard + toolbar animations can update visualViewport metrics with delays.
    // Poll a few times to converge quickly (prevents jumpy input positioning and delayed drop).
    const delays = Array.isArray(delaysMs) && delaysMs.length ? delaysMs : [0, 50, 120, 200, 320, 480, 700, 1000];
    delays.forEach((delayMs) => {
        setTimeout(() => scheduleViewportUpdate({ preserveScroll }), delayMs);
    });
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
    window.visualViewport.addEventListener('scroll', () => scheduleViewportUpdate({ preserveScroll: true }));
}

document.addEventListener('DOMContentLoaded', () => {
    // Establish baseline after layout exists.
    scheduleViewportUpdate({ preserveScroll: false });

    const input = document.getElementById('message-input');
    if (!input) return;

    input.addEventListener('focus', () => {
        applyViewportCssVars();
        scheduleViewportUpdate({ preserveScroll: true });
        scheduleViewportSettle({ preserveScroll: true });
    });

    input.addEventListener('blur', () => {
        applyViewportCssVars();
        scheduleViewportUpdate({ preserveScroll: true });
        scheduleViewportSettle({ preserveScroll: true });
    });

    // Keep viewport vars fresh after touch interactions (e.g., scrolling chat, tapping Done).
    // Some iOS toolbar/viewport changes may not consistently fire resize events for inner scrollers.
    const onInteractionEnd = (event) => {
        const isTouchLike = !!(
            event?.type?.startsWith?.('touch') ||
            event?.pointerType === 'touch'
        );
        if (!isTouchLike) return;

        applyViewportCssVars();
        scheduleViewportUpdate({ preserveScroll: true });
        scheduleViewportSettle({ preserveScroll: true, delaysMs: [0, 120, 320] });
    };

    if (typeof window.PointerEvent !== 'undefined') {
        document.addEventListener('pointerup', onInteractionEnd, { passive: true });
        document.addEventListener('pointercancel', onInteractionEnd, { passive: true });
    } else {
        document.addEventListener('touchend', onInteractionEnd, { passive: true });
        document.addEventListener('touchcancel', onInteractionEnd, { passive: true });
        document.addEventListener('mouseup', onInteractionEnd, { passive: true });
    }
});
