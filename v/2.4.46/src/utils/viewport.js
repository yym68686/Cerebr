const KEYBOARD_INSET_MIN_PX = 80;

function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

function getVisualViewportHeight() {
    return window.visualViewport?.height || window.innerHeight;
}

function getKeyboardInsetPx() {
    const vv = window.visualViewport;
    if (!vv) return 0;

    // layoutViewportHeight - visualViewportHeight - offsetTop ≈ keyboard/overlay inset.
    const layoutHeight = window.innerHeight;
    const inset = layoutHeight - vv.height - vv.offsetTop;
    const rounded = Math.round(inset);
    if (!Number.isFinite(rounded)) return 0;
    return rounded >= KEYBOARD_INSET_MIN_PX ? Math.max(0, rounded) : 0;
}

function getChatContainer() {
    return document.getElementById('chat-container');
}

function getEffectiveChatVisibleHeight(chatContainer, keyboardInsetPx) {
    if (!chatContainer) return 0;
    // When the keyboard overlays the bottom of the layout viewport, the chat container still has
    // the same clientHeight, but only (clientHeight - inset) is actually visible.
    return Math.max(0, Math.round(chatContainer.clientHeight - keyboardInsetPx));
}

let lastEffectiveChatHeight = null;
let rafId = 0;

function applyViewportState({ preserveReadingProgress = true } = {}) {
    const chatContainer = getChatContainer();
    const previousEffectiveHeight =
        lastEffectiveChatHeight == null
            ? getEffectiveChatVisibleHeight(chatContainer, getKeyboardInsetPx())
            : lastEffectiveChatHeight;

    const previousScrollTop = chatContainer ? chatContainer.scrollTop : 0;
    const previousBottomY = chatContainer ? previousScrollTop + previousEffectiveHeight : 0;
    const wasPinnedTop = chatContainer ? chatContainer.scrollTop <= 2 : false;

    const visibleHeight = getVisualViewportHeight();
    const vh = visibleHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);

    const keyboardInsetPx = getKeyboardInsetPx();
    document.documentElement.style.setProperty('--keyboard-height', `${keyboardInsetPx}px`);
    document.body.classList.toggle('keyboard-visible', keyboardInsetPx > 0);

    if (!chatContainer || !preserveReadingProgress) {
        lastEffectiveChatHeight = getEffectiveChatVisibleHeight(chatContainer, keyboardInsetPx);
        return;
    }

    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (!chatContainer.isConnected) return;

        const newEffectiveHeight = getEffectiveChatVisibleHeight(chatContainer, keyboardInsetPx);

        // First run: just record dimensions.
        if (lastEffectiveChatHeight == null) {
            lastEffectiveChatHeight = newEffectiveHeight;
            return;
        }

        // If user is pinned to the very top, don't auto-scroll them down when the keyboard opens.
        if (wasPinnedTop && newEffectiveHeight < previousEffectiveHeight) {
            lastEffectiveChatHeight = newEffectiveHeight;
            return;
        }

        const targetScrollTop = previousBottomY - newEffectiveHeight;
        const maxScrollTop = Math.max(0, chatContainer.scrollHeight - chatContainer.clientHeight);
        const clamped = clamp(targetScrollTop, 0, maxScrollTop);

        if (Math.abs(chatContainer.scrollTop - clamped) >= 1) {
            // Avoid auto-scroll tracking treating this as a user scroll gesture.
            chatContainer.__cerebrIgnoreNextScroll = true;
            chatContainer.scrollTop = clamped;
        }

        lastEffectiveChatHeight = newEffectiveHeight;
    });
}

applyViewportState({ preserveReadingProgress: false });

let resizeTimer = 0;
const schedule = (opts) => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => applyViewportState(opts), 80);
};

window.addEventListener('resize', () => schedule({ preserveReadingProgress: true }));

if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => schedule({ preserveReadingProgress: true }));
    window.visualViewport.addEventListener('scroll', () => schedule({ preserveReadingProgress: true }));
}

document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('message-input');
    if (!input) return;

    input.addEventListener('focus', () => {
        // Wait for the keyboard to settle, then preserve the reading position.
        schedule({ preserveReadingProgress: true });
        setTimeout(() => applyViewportState({ preserveReadingProgress: true }), 320);
    });

    input.addEventListener('blur', () => {
        schedule({ preserveReadingProgress: true });
        setTimeout(() => applyViewportState({ preserveReadingProgress: true }), 160);
    });
});
