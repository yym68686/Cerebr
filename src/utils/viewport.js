// 用于存储“布局视口”的原始高度（键盘未弹出时）
let originalLayoutViewportHeight = getLayoutViewportHeight();

let rafId = 0;
let burstRafId = 0;
let burstUntilMs = 0;
let keyboardVisibleUntilMs = 0;
let smoothedKeyboardOffsetPx = 0;
let lastLayoutHeightPx = getLayoutViewportHeight();
let lastKeyboardVisible = false;
let keyboardShowStartMs = 0;
let stableKeyboardOverlayPx = 0;
let stableCandidateOverlayPx = 0;
let stableCandidateSinceMs = 0;

const isTextInputLike = (el) => {
    if (!el || el === document.body) return false;
    if (el.isContentEditable) return true;
    const tagName = el.tagName;
    return tagName === 'INPUT' || tagName === 'TEXTAREA';
};

const isProbablyIOS = () => {
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    const vendor = navigator.vendor || '';
    const maxTouchPoints = navigator.maxTouchPoints || 0;

    // iOS / iPadOS:
    // - Normal UA contains iPhone/iPad/iPod.
    // - iPadOS (and sometimes iOS with desktop-site UA) may report `MacIntel`/`Macintosh`.
    // - Apple vendor + touch points is a robust fallback even under "Request Desktop Website".
    const isIOSUA = /iPad|iPhone|iPod/i.test(ua);
    const isAppleTouch = /Apple/i.test(vendor) && maxTouchPoints > 1;
    const isIpadOS = platform === 'MacIntel' && maxTouchPoints > 1;
    const isMacUAWithTouch = /Macintosh/i.test(ua) && maxTouchPoints > 1;
    return isIOSUA || isIpadOS || isMacUAWithTouch || isAppleTouch;
};

// iOS Safari has a long-standing quirk where `:hover` can "stick" after a tap and
// interact badly with keyboard/viewport animations. For the web build on iOS we
// disable message hover-lift entirely to keep input/keyboard behavior stable.
const disableMessageHoverOnIOS = () => {
    try {
        if (!isProbablyIOS()) return;
        const apply = () => document.body?.classList?.add('cerebr-disable-message-hover');
        if (document.body) {
            apply();
            return;
        }
        document.addEventListener('DOMContentLoaded', apply, { once: true });
    } catch {
        // ignore
    }
};

disableMessageHoverOnIOS();

const shouldSuppressMessageHover = () => {
    if (!isProbablyIOS()) return false;
    const active = document.activeElement;
    return !!(active && active instanceof Element && active.id === 'message-input');
};

const setMessageHoverSuppressed = (enabled) => {
    try {
        if (!isProbablyIOS()) return;
        document.body?.classList?.toggle('cerebr-suppress-message-hover', !!enabled);
    } catch {
        // ignore
    }
};

const syncMessageHoverSuppression = () => {
    try {
        document.body?.classList?.toggle('cerebr-suppress-message-hover', shouldSuppressMessageHover());
    } catch {
        // ignore
    }
};

function getLayoutViewportHeight() {
    // Use the layout viewport height as the baseline. On iOS Safari the keyboard typically
    // does NOT change `window.innerHeight`, so we use it as the stable "layout" height
    // and compute the keyboard overlay via VisualViewport.
    return Math.max(window.innerHeight || 0, document.documentElement?.clientHeight || 0);
}

function getKeyboardOverlayPx(layoutHeight) {
    const visual = window.visualViewport;
    if (!visual) return 0;
    const visualBottom = (visual.height || 0) + (visual.offsetTop || 0);
    return Math.max(0, layoutHeight - visualBottom);
}

function smoothKeyboardOffset(nextPx, baselinePx) {
    const clampedNext = Math.max(0, Math.min(Math.round(nextPx || 0), Math.round(baselinePx || 0)));
    const prev = smoothedKeyboardOffsetPx;

    // iOS Safari quirk: visualViewport.height can briefly report an overly small value
    // on subsequent focus cycles, causing the input bar to jump too high then fall back.
    // Apply a conservative per-frame clamp to filter out these spikes.
    const MAX_UP_FAST_PX = 160;
    const MAX_UP_SLOW_PX = 48;
    const maxUpPx = prev < 80 ? MAX_UP_FAST_PX : MAX_UP_SLOW_PX;

    let next = clampedNext;
    if (clampedNext > prev) {
        next = Math.min(clampedNext, prev + maxUpPx);
    } else {
        // Always allow the offset to decrease immediately to avoid getting "stuck high"
        // on the next focus cycle.
        next = clampedNext;
    }

    smoothedKeyboardOffsetPx = next;
    return next;
}

function scheduleViewportUpdate() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
        rafId = 0;
        setViewportVars();
    });
}

function scheduleBurstFrames(durationMs = 1800) {
    const now = performance.now();
    burstUntilMs = Math.max(burstUntilMs, now + durationMs);
    if (burstRafId) return;

    const tick = () => {
        burstRafId = 0;
        scheduleViewportUpdate();
        if (performance.now() < burstUntilMs) {
            burstRafId = requestAnimationFrame(tick);
        }
    };

    burstRafId = requestAnimationFrame(tick);
}

function setViewportVars() {
    const layoutHeight = getLayoutViewportHeight();
    // Ensure `--app-height` stays in sync with the layout viewport height.
    try {
        if (layoutHeight) {
            document.documentElement.style.setProperty('--app-height', `${Math.round(layoutHeight)}px`);
        }
    } catch {
        // ignore
    }

    // 获取实际视口高度（用于一些 100vh 的兼容场景；目前项目内不强依赖）
    const vh = layoutHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);

    const keyboardOverlayPx = getKeyboardOverlayPx(layoutHeight);
    const layoutKeyboardPx = Math.max(0, originalLayoutViewportHeight - layoutHeight);
    const effectiveKeyboardPx = Math.max(layoutKeyboardPx, keyboardOverlayPx);

    const KEYBOARD_VISIBLE_MIN_PX = 80;
    const now = performance.now();
    const activeIsTextInput = isTextInputLike(document.activeElement);

    if (activeIsTextInput && effectiveKeyboardPx > KEYBOARD_VISIBLE_MIN_PX) {
        keyboardVisibleUntilMs = Math.max(keyboardVisibleUntilMs, now + 4000);
    } else if (!activeIsTextInput && now >= keyboardVisibleUntilMs) {
        keyboardVisibleUntilMs = 0;
    }

    const isKeyboardVisible =
        effectiveKeyboardPx > KEYBOARD_VISIBLE_MIN_PX &&
        (activeIsTextInput || now < keyboardVisibleUntilMs);
    // 输入框聚焦时同步抑制消息的“粘住 hover”上浮（iOS Safari）
    syncMessageHoverSuppression();

    // Track keyboard show/hide cycles and keep a "stable" overlay height to filter iOS spikes.
    if (isKeyboardVisible && !lastKeyboardVisible) {
        keyboardShowStartMs = now;
        stableCandidateOverlayPx = Math.round(keyboardOverlayPx);
        stableCandidateSinceMs = now;
    }

    if (!isKeyboardVisible) {
        // When keyboard is hidden and layout viewport height changes (orientation/resize),
        // reset the cached stable overlay height to avoid using stale baselines.
        if (Math.abs(layoutHeight - lastLayoutHeightPx) > 120) {
            stableKeyboardOverlayPx = 0;
        }
        lastLayoutHeightPx = layoutHeight;
        stableCandidateSinceMs = 0;
    }

    lastKeyboardVisible = isKeyboardVisible;

    if (isKeyboardVisible) {
        const rawOverlayPx = Math.round(keyboardOverlayPx);

        // iOS Safari can briefly report an overly small VisualViewport.height on subsequent
        // focus cycles, making the overlay look much larger than the real keyboard.
        // Clamp early-cycle spikes to the last stable value to avoid "jump up then fall".
        let overlayForOffsetPx = rawOverlayPx;
        const SPIKE_WINDOW_MS = 900;
        const EARLY_MAX_EXTRA_PX = 24;
        if (stableKeyboardOverlayPx > 0 && now - keyboardShowStartMs < SPIKE_WINDOW_MS) {
            overlayForOffsetPx = Math.min(rawOverlayPx, stableKeyboardOverlayPx + EARLY_MAX_EXTRA_PX);
        }

        // Update stable overlay height once the keyboard animation settles.
        // Use the spike-filtered value to avoid poisoning the baseline on iOS.
        const STABLE_EPS_PX = 2;
        const STABLE_MIN_MS = 140;
        if (Math.abs(overlayForOffsetPx - stableCandidateOverlayPx) <= STABLE_EPS_PX) {
            if (!stableCandidateSinceMs) stableCandidateSinceMs = now;
            if (now - stableCandidateSinceMs >= STABLE_MIN_MS) {
                stableKeyboardOverlayPx = overlayForOffsetPx;
            }
        } else {
            stableCandidateOverlayPx = overlayForOffsetPx;
            stableCandidateSinceMs = now;
        }

        const keyboardOffsetPx = smoothKeyboardOffset(overlayForOffsetPx, layoutHeight);
        // iOS Safari: 用户反馈在某些状态下 custom property 已更新，但 body 的 padding-bottom 仍然保持 0，
        // 导致输入栏留在 layout viewport 底部被键盘遮挡。这里用内联样式强制兜底。
        try {
            if (keyboardOffsetPx > 0) {
                document.body.style.setProperty('padding-bottom', `${keyboardOffsetPx}px`, 'important');
            } else {
                document.body.style.removeProperty('padding-bottom');
            }
            document.body.style.setProperty('box-sizing', 'border-box', 'important');
        } catch {
            // ignore
        }
        // --keyboard-height 用于聊天列表的底部 padding，保证内容不会被键盘遮挡
        document.documentElement.style.setProperty('--keyboard-height', `${Math.round(effectiveKeyboardPx)}px`);
        // --keyboard-offset：当布局没有随键盘缩高时，用于把整体内容“扣掉”键盘覆盖的底部区域（CSS 通过 body padding-bottom 实现）
        document.documentElement.style.setProperty('--keyboard-offset', `${keyboardOffsetPx}px`);
        // 保持原有语义：只有在 layout viewport 真的变小时才补偿 top margin
        document.documentElement.style.setProperty('--chat-top-margin', `${Math.round(layoutKeyboardPx)}px`);
        document.body.classList.add('keyboard-visible');
        return;
    }

    smoothedKeyboardOffsetPx = 0;
    try {
        document.body.style.removeProperty('padding-bottom');
        document.body.style.removeProperty('box-sizing');
    } catch {
        // ignore
    }

    document.documentElement.style.setProperty('--keyboard-height', '0px');
    document.documentElement.style.setProperty('--keyboard-offset', '0px');
    document.documentElement.style.setProperty('--chat-top-margin', '0px');
    document.body.classList.remove('keyboard-visible');
    // 键盘收起时也同步清理一次（避免 focus 状态异常导致 class 残留）
    syncMessageHoverSuppression();

    // 更新原始布局视口高度（键盘收起/未弹出时才更新）
    originalLayoutViewportHeight = layoutHeight;
}

// 初始设置
setViewportVars();

// 监听视口变化（包括输入法弹出/收起）
window.addEventListener('resize', () => {
    scheduleViewportUpdate();
    if (isProbablyIOS()) scheduleBurstFrames(800);
});

if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
        scheduleViewportUpdate();
        if (isProbablyIOS()) scheduleBurstFrames(800);
    });
    window.visualViewport.addEventListener('scroll', () => {
        scheduleViewportUpdate();
        if (isProbablyIOS()) scheduleBurstFrames(800);
    });
}

// iOS Safari: 尽量在 focus 之前就先抑制“粘住 hover”，避免 hover/transforms 影响键盘动画期间的布局更新
const preFocusSuppression = (event) => {
    if (!isProbablyIOS()) return;
    const target = event?.target;
    if (!(target instanceof Element)) return;
    if (target.id !== 'message-input') return;
    setMessageHoverSuppressed(true);
    scheduleBurstFrames();
};

document.addEventListener('touchstart', preFocusSuppression, { capture: true, passive: true });
document.addEventListener(
    'pointerdown',
    (event) => {
        // pointer events 在 iOS Safari 可能同时触发；仅处理非鼠标输入以避免桌面端干扰
        if (event?.pointerType === 'mouse') return;
        preFocusSuppression(event);
    },
    { capture: true, passive: true }
);

// 监听输入框焦点事件（main.js 可能在 DOMContentLoaded 之后动态 import）
document.addEventListener(
    'focusin',
    (event) => {
        if (!isTextInputLike(event?.target)) return;
        // 立即抑制消息 hover，上浮状态不应干扰键盘弹起期间的布局/合成。
        if (event?.target instanceof Element && event.target.id === 'message-input') {
            setMessageHoverSuppressed(true);
        }
        scheduleBurstFrames();
    },
    true
);

document.addEventListener(
    'focusout',
    (event) => {
        if (!isTextInputLike(event?.target)) return;
        if (event?.target instanceof Element && event.target.id === 'message-input') {
            setMessageHoverSuppressed(false);
        }
        scheduleBurstFrames();
    },
    true
);
