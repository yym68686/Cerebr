function roundPx(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0px';
    return `${Math.round(n)}px`;
}

function getViewportHeight() {
    const vv = window.visualViewport;
    return vv ? vv.height : window.innerHeight;
}

function applyViewportCssVars() {
    const rawHeight = getViewportHeight();

    // On iOS Safari the virtual keyboard is an overlay: window.innerHeight always
    // reflects the full layout-viewport height (unaffected by the keyboard), while
    // visualViewport.height shrinks when the keyboard is visible.
    //
    // When the input is focused (keyboard showing) we need the reduced height so that
    // the body (and the input anchored to its bottom) tracks the keyboard.
    //
    // When the input is NOT focused (keyboard closing / closed) the correct height is
    // the full no-keyboard value.  However, after certain interaction paths (e.g. the
    // user tapped a message bubble before opening/closing the keyboard), iOS Safari
    // delays the visualViewport.resize event by hundreds of milliseconds, leaving
    // rawHeight at the stale keyboard-reduced value.  Using Math.max with
    // window.innerHeight gives us the correct full height immediately, bypassing
    // the delayed API update.
    const input = document.getElementById('message-input');
    const isFocused = input && document.activeElement === input;
    const height = isFocused ? rawHeight : Math.max(rawHeight, window.innerHeight);

    // Used by CSS to size the fixed body to the visual viewport height (iOS keyboard, etc.).
    document.documentElement.style.setProperty('--vv-height', roundPx(height));

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
}

document.addEventListener('DOMContentLoaded', () => {
    // Establish baseline after layout exists.
    scheduleViewportUpdate({ preserveScroll: false });

    const input = document.getElementById('message-input');
    if (!input) return;

    const settle = (delayMs) => {
        setTimeout(() => scheduleViewportUpdate({ preserveScroll: true }), delayMs);
    };

    input.addEventListener('focus', () => {
        scheduleViewportUpdate({ preserveScroll: true });
        settle(320);
        settle(700);
    });

    input.addEventListener('blur', () => {
        scheduleViewportUpdate({ preserveScroll: true });
        settle(180);
        settle(480);
    });
});
