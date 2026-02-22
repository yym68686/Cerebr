import { getScrollTop, scrollToTop } from './scroll-root.js';

const KEYBOARD_VISIBLE_THRESHOLD_PX = 120;
const AUTO_SCROLL_CAPTURE_DELAY_MS = 140;
const AUTO_SCROLL_RESTORE_DELAY_MS = 80;
const AUTO_SCROLL_MIN_DELTA_PX = 12;

// 用于存储“布局视口”的基准高度（无 VisualViewport 时退化使用）
let originalViewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

let messageInput = null;
let keyboardVisible = false;

let keyboardFixState = null;
let captureTimer = null;
let restoreTimer = null;
let fallbackRestoreTimer = null;

const clamp = (value, min, max) => {
    if (!Number.isFinite(value)) return min;
    if (value < min) return min;
    if (value > max) return max;
    return value;
};

const getLayoutViewportHeight = () => (
    window.innerHeight || document.documentElement.clientHeight || 0
);

const getKeyboardHeightPx = () => {
    const layoutHeight = getLayoutViewportHeight();
    const vv = window.visualViewport;
    if (vv && Number.isFinite(vv.height)) {
        const offsetTop = Number.isFinite(vv.offsetTop) ? vv.offsetTop : 0;
        return Math.max(0, layoutHeight - vv.height - offsetTop);
    }

    // Fallback: some browsers shrink layout viewport when keyboard opens.
    return Math.max(0, originalViewportHeight - layoutHeight);
};

const shouldTreatKeyboardVisible = (keyboardHeightPx) => keyboardHeightPx > KEYBOARD_VISIBLE_THRESHOLD_PX;

const setViewportVars = () => {
    // 获取实际视口高度
    const vh = getLayoutViewportHeight() * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);

    const keyboardHeightPx = getKeyboardHeightPx();
    const isVisible = shouldTreatKeyboardVisible(keyboardHeightPx);

    document.documentElement.style.setProperty('--keyboard-height', `${isVisible ? Math.round(keyboardHeightPx) : 0}px`);
    document.body.classList.toggle('keyboard-visible', isVisible);

    // When using the fallback path, keep the baseline updated.
    if (!window.visualViewport && !isVisible) {
        originalViewportHeight = getLayoutViewportHeight();
    }

    return isVisible;
};

const markIgnoreNextScrollIfPossible = () => {
    const chatContainer = document.getElementById('chat-container');
    if (!chatContainer) return;
    chatContainer.__cerebrIgnoreNextScroll = true;
};

const clearTimers = () => {
    if (captureTimer) clearTimeout(captureTimer);
    if (restoreTimer) clearTimeout(restoreTimer);
    if (fallbackRestoreTimer) clearTimeout(fallbackRestoreTimer);
    captureTimer = null;
    restoreTimer = null;
    fallbackRestoreTimer = null;
};

const captureAutoScrollDelta = () => {
    if (!keyboardFixState || keyboardFixState.captured) return;
    const current = getScrollTop();
    const delta = current - keyboardFixState.startScrollTop;
    keyboardFixState.autoScrollDelta = delta;
    keyboardFixState.captured = true;
};

const restoreAutoScrollDelta = () => {
    if (!keyboardFixState) return;

    const current = getScrollTop();
    const delta = keyboardFixState.captured
        ? keyboardFixState.autoScrollDelta
        : (current - keyboardFixState.startScrollTop);

    if (!Number.isFinite(delta) || Math.abs(delta) < AUTO_SCROLL_MIN_DELTA_PX) {
        keyboardFixState = null;
        return;
    }

    markIgnoreNextScrollIfPossible();
    const target = current - delta;
    scrollToTop(clamp(target, 0, Number.POSITIVE_INFINITY), 'auto');
    keyboardFixState = null;
};

const onKeyboardVisibilityChanged = (nextVisible) => {
    if (!keyboardVisible && nextVisible) {
        // Keyboard just appeared.
        if (keyboardFixState && messageInput && document.activeElement === messageInput) {
            keyboardFixState.keyboardSeen = true;
            if (captureTimer) clearTimeout(captureTimer);
            captureTimer = setTimeout(() => {
                captureTimer = null;
                captureAutoScrollDelta();
            }, AUTO_SCROLL_CAPTURE_DELAY_MS);
        }
    }

    if (keyboardVisible && !nextVisible) {
        // Keyboard just disappeared.
        if (keyboardFixState?.restorePending) {
            if (restoreTimer) clearTimeout(restoreTimer);
            restoreTimer = setTimeout(() => {
                restoreTimer = null;
                restoreAutoScrollDelta();
            }, AUTO_SCROLL_RESTORE_DELAY_MS);
        }
    }

    keyboardVisible = nextVisible;
};

let rafId = 0;
const scheduleUpdate = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
        rafId = 0;
        const nextVisible = setViewportVars();
        onKeyboardVisibilityChanged(nextVisible);
    });
};

// 初始设置
scheduleUpdate();

window.addEventListener('resize', scheduleUpdate, { passive: true });
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', scheduleUpdate, { passive: true });
    window.visualViewport.addEventListener('scroll', scheduleUpdate, { passive: true });
}

document.addEventListener('DOMContentLoaded', () => {
    messageInput = document.getElementById('message-input');
    if (!messageInput) return;

    messageInput.addEventListener('focus', () => {
        clearTimers();
        keyboardFixState = {
            startScrollTop: getScrollTop(),
            autoScrollDelta: 0,
            captured: false,
            restorePending: false,
            keyboardSeen: false
        };

        // Give Safari a moment to apply its automatic scroll-to-focus adjustment (if any).
        // If we can't detect keyboard transitions, we still capture a best-effort delta later.
        fallbackRestoreTimer = setTimeout(() => {
            fallbackRestoreTimer = null;
            captureAutoScrollDelta();
        }, AUTO_SCROLL_CAPTURE_DELAY_MS + 120);

        scheduleUpdate();
    });

    messageInput.addEventListener('blur', () => {
        if (!keyboardFixState) return;
        keyboardFixState.restorePending = true;

        clearTimeout(fallbackRestoreTimer);
        fallbackRestoreTimer = setTimeout(() => {
            fallbackRestoreTimer = null;
            // Fallback for browsers that don't emit reliable keyboard visibility changes.
            if (!keyboardVisible) restoreAutoScrollDelta();
        }, AUTO_SCROLL_RESTORE_DELAY_MS + 260);

        scheduleUpdate();
    });
});
