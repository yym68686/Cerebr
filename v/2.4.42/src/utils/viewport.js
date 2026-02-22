const KEYBOARD_VISIBLE_THRESHOLD_PX = 120;
const KEYBOARD_MODE_EXIT_DELAY_MS = 120;
const ANCHOR_SAMPLE_TOP_PX = 96;

const isIOS = () => {
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    const ua = navigator.userAgent || '';
    const isAppleMobile = /iphone|ipad|ipod/i.test(platform) || /iphone|ipad|ipod/i.test(ua);
    // iPadOS 13+ reports as MacIntel but has touch points.
    const isIpadOS = platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
    return isAppleMobile || isIpadOS;
};

const getLayoutViewportHeight = () => (window.innerHeight || document.documentElement.clientHeight || 0);

const getVisualViewportMetrics = () => {
    const vv = window.visualViewport;
    const layoutHeight = getLayoutViewportHeight();
    if (!vv || !Number.isFinite(vv.height)) {
        return {
            layoutHeight,
            visualHeight: layoutHeight,
            offsetTop: 0,
            keyboardHeight: 0
        };
    }

    const visualHeight = vv.height;
    const offsetTop = Number.isFinite(vv.offsetTop) ? vv.offsetTop : 0;
    const keyboardHeight = Math.max(0, layoutHeight - visualHeight - offsetTop);
    return {
        layoutHeight,
        visualHeight,
        offsetTop,
        keyboardHeight
    };
};

const setViewportCssVars = () => {
    const { visualHeight, offsetTop, keyboardHeight } = getVisualViewportMetrics();
    // `--vh`: 1% of visual viewport height (works better than 1vh on iOS keyboard)
    document.documentElement.style.setProperty('--vh', `${visualHeight * 0.01}px`);
    document.documentElement.style.setProperty('--app-height', `${Math.round(visualHeight)}px`);
    document.documentElement.style.setProperty('--viewport-offset-top', `${Math.round(offsetTop)}px`);

    const isKeyboardVisible = keyboardHeight > KEYBOARD_VISIBLE_THRESHOLD_PX;
    document.documentElement.style.setProperty('--keyboard-height', `${isKeyboardVisible ? Math.round(keyboardHeight) : 0}px`);
    document.body.classList.toggle('keyboard-visible', isKeyboardVisible);

    return isKeyboardVisible;
};

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

const getViewportSize = () => {
    const vv = window.visualViewport;
    if (vv && Number.isFinite(vv.width) && Number.isFinite(vv.height)) {
        return { width: vv.width, height: vv.height };
    }
    return {
        width: window.innerWidth || document.documentElement.clientWidth || 0,
        height: getLayoutViewportHeight()
    };
};

const captureViewportAnchor = (chatContainer) => {
    if (!chatContainer) return null;

    const { width, height } = getViewportSize();
    if (!width || !height) return null;

    const x = Math.round(width / 2);
    const y = clamp(Math.round(ANCHOR_SAMPLE_TOP_PX), 24, Math.max(24, height - 24));

    let node = null;
    try {
        node = document.elementFromPoint?.(x, y) || null;
    } catch {
        node = null;
    }

    let messageEl = node?.closest?.('.message') || null;
    if (messageEl && !chatContainer.contains(messageEl)) {
        messageEl = null;
    }

    if (!messageEl) {
        const messages = chatContainer.querySelectorAll?.('.message') || [];
        for (const msg of messages) {
            const rect = msg.getBoundingClientRect?.();
            if (rect && rect.bottom > y + 1) {
                messageEl = msg;
                break;
            }
        }
    }

    if (!messageEl) return null;
    return {
        element: messageEl,
        top: messageEl.getBoundingClientRect().top
    };
};

const getPageScrollTop = () => {
    const root = document.scrollingElement || document.documentElement;
    return root?.scrollTop || 0;
};

const setPageScrollTop = (top) => {
    const root = document.scrollingElement || document.documentElement;
    const next = Number.isFinite(top) ? top : 0;
    try {
        window.scrollTo(0, next);
        return;
    } catch {
        // ignore
    }
    if (root) root.scrollTop = next;
};

const BODY_LOCK_STYLE_KEYS = [
    'position',
    'top',
    'left',
    'right',
    'width',
    'overflow',
    'overscrollBehavior',
    'touchAction'
];

let messageInput = null;
let chatContainer = null;
let lastKeyboardVisible = false;

let keyboardModeActive = false;
let keyboardModeTransitioning = false;
let pendingExitTimer = null;
let savedBodyInlineStyles = null;

const saveBodyInlineStyles = () => {
    const { style } = document.body;
    const saved = {};
    BODY_LOCK_STYLE_KEYS.forEach((key) => {
        saved[key] = style[key];
    });
    return saved;
};

const restoreBodyInlineStyles = (saved) => {
    const { style } = document.body;
    BODY_LOCK_STYLE_KEYS.forEach((key) => {
        style[key] = saved?.[key] ?? '';
    });
};

const lockBodyForKeyboardMode = () => {
    if (!savedBodyInlineStyles) {
        savedBodyInlineStyles = saveBodyInlineStyles();
    }
    const { style } = document.body;
    style.position = 'fixed';
    style.top = '0px';
    style.left = '0';
    style.right = '0';
    style.width = '100%';
    style.overflow = 'hidden';
    style.overscrollBehavior = 'none';
    style.touchAction = 'none';
};

const unlockBodyFromKeyboardMode = () => {
    restoreBodyInlineStyles(savedBodyInlineStyles);
    savedBodyInlineStyles = null;
};

const enterKeyboardMode = () => {
    if (!isIOS()) return;
    if (!chatContainer || !messageInput) return;
    if (keyboardModeActive || keyboardModeTransitioning) return;

    keyboardModeTransitioning = true;
    clearTimeout(pendingExitTimer);
    pendingExitTimer = null;

    const anchor = captureViewportAnchor(chatContainer);
    const containerRectTopBefore = chatContainer.getBoundingClientRect().top;
    const pageScrollTop = getPageScrollTop();

    // Turn current "page scroll" into "chat-container scroll":
    // The amount of chat content that has moved past the viewport top is `-containerRectTop`.
    const desiredChatScrollTop = Math.max(0, Math.round(-containerRectTopBefore));

    lockBodyForKeyboardMode();
    document.body.classList.add('cerebr-keyboard-mode');

    chatContainer.scrollTop = desiredChatScrollTop;
    setPageScrollTop(0);

    requestAnimationFrame(() => {
        if (anchor?.element?.isConnected) {
            const nowTop = anchor.element.getBoundingClientRect().top;
            const delta = nowTop - anchor.top;
            if (Math.abs(delta) >= 1) {
                chatContainer.scrollTop += delta;
            }
        }

        keyboardModeActive = true;
        keyboardModeTransitioning = false;
    });
};

const exitKeyboardMode = () => {
    if (!chatContainer) return;
    if (!keyboardModeActive || keyboardModeTransitioning) return;

    keyboardModeTransitioning = true;
    clearTimeout(pendingExitTimer);
    pendingExitTimer = null;

    const anchor = captureViewportAnchor(chatContainer);
    const chatScrollTop = chatContainer.scrollTop || 0;

    document.body.classList.remove('cerebr-keyboard-mode');
    unlockBodyFromKeyboardMode();

    // Map current chat scroll back to page scroll.
    setPageScrollTop(0);
    const containerDocTop = chatContainer.getBoundingClientRect().top + getPageScrollTop();
    setPageScrollTop(containerDocTop + chatScrollTop);

    requestAnimationFrame(() => {
        if (anchor?.element?.isConnected) {
            const nowTop = anchor.element.getBoundingClientRect().top;
            const delta = nowTop - anchor.top;
            if (Math.abs(delta) >= 1) {
                setPageScrollTop(getPageScrollTop() + delta);
            }
        }
        keyboardModeActive = false;
        keyboardModeTransitioning = false;
    });
};

let rafId = 0;
const scheduleUpdate = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
        rafId = 0;
        const keyboardVisible = setViewportCssVars();
        lastKeyboardVisible = keyboardVisible;

        if (!isIOS()) return;
        if (!messageInput || !chatContainer) return;

        const isInputFocused = document.activeElement === messageInput;
        const shouldBeInKeyboardMode = isInputFocused || keyboardVisible;

        if (shouldBeInKeyboardMode && !keyboardModeActive) {
            enterKeyboardMode();
            return;
        }

        if (!shouldBeInKeyboardMode && keyboardModeActive) {
            clearTimeout(pendingExitTimer);
            pendingExitTimer = setTimeout(() => {
                pendingExitTimer = null;
                // Double-check because focus/viewport may bounce.
                const stillFocused = document.activeElement === messageInput;
                if (stillFocused || lastKeyboardVisible) return;
                exitKeyboardMode();
            }, KEYBOARD_MODE_EXIT_DELAY_MS);
        }
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
    chatContainer = document.getElementById('chat-container');
    if (!messageInput || !chatContainer) return;

    messageInput.addEventListener('focus', () => {
        if (!isIOS()) return;
        clearTimeout(pendingExitTimer);
        pendingExitTimer = null;
        enterKeyboardMode();
        scheduleUpdate();
    });

    messageInput.addEventListener('blur', () => {
        if (!isIOS()) return;
        scheduleUpdate();
    });
});

