// 用于存储原始视口高度
let originalViewportHeight = window.innerHeight;

let rafId = 0;

function getKeyboardOffsetPx() {
    const layoutHeight = window.innerHeight;
    const visual = window.visualViewport;
    if (!visual) return 0;

    // layout viewport 底部被 visual viewport “遮挡”的高度，通常是键盘高度
    const visualBottom = (visual.height || 0) + (visual.offsetTop || 0);
    return Math.max(0, layoutHeight - visualBottom);
}

function scheduleViewportUpdate() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
        rafId = 0;
        setViewportHeight();
    });
}

// 设置视口高度变量
function setViewportHeight() {
    // 获取实际视口高度
    const vh = window.innerHeight * 0.01;
    // 设置CSS变量
    document.documentElement.style.setProperty('--vh', `${vh}px`);

    const layoutHeight = window.innerHeight;
    const keyboardOffsetPx = getKeyboardOffsetPx();
    document.documentElement.style.setProperty('--keyboard-offset', `${Math.round(keyboardOffsetPx)}px`);

    const layoutKeyboardPx = Math.max(0, originalViewportHeight - layoutHeight);
    const effectiveKeyboardPx = Math.max(layoutKeyboardPx, keyboardOffsetPx);

    // 计算输入法是否弹出（兼容 iOS Safari 可能不触发布局视口 resize 的情况）
    const KEYBOARD_VISIBLE_MIN_PX = 80;
    const isKeyboardVisible =
        keyboardOffsetPx > KEYBOARD_VISIBLE_MIN_PX ||
        (layoutHeight < originalViewportHeight * 0.8 && layoutKeyboardPx > KEYBOARD_VISIBLE_MIN_PX);

    if (isKeyboardVisible) {
        document.documentElement.style.setProperty('--keyboard-height', `${Math.round(effectiveKeyboardPx)}px`);
        // 仅在布局视口真的变小时才需要补偿 top margin
        document.documentElement.style.setProperty('--chat-top-margin', `${Math.round(layoutKeyboardPx)}px`);
        document.body.classList.add('keyboard-visible');
        return;
    }

    document.documentElement.style.setProperty('--keyboard-height', '0px');
    document.documentElement.style.setProperty('--keyboard-offset', '0px');
    document.documentElement.style.setProperty('--chat-top-margin', '0px');
    document.body.classList.remove('keyboard-visible');
    // 更新原始视口高度
    originalViewportHeight = layoutHeight;
}

// 初始设置
setViewportHeight();

// 监听视口大小变化（包括输入法弹出）
window.addEventListener('resize', () => {
    scheduleViewportUpdate();
});

if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', scheduleViewportUpdate);
    window.visualViewport.addEventListener('scroll', scheduleViewportUpdate);
}

const isTextInputLike = (el) => {
    if (!el || el === document.body) return false;
    if (el.isContentEditable) return true;
    const tagName = el.tagName;
    return tagName === 'INPUT' || tagName === 'TEXTAREA';
};

// 监听输入框焦点事件（iOS Safari 有时不会可靠触发布局视口 resize）
document.addEventListener(
    'focusin',
    (event) => {
        const target = event?.target;
        if (!isTextInputLike(target)) return;

        // 给一点延迟，等待输入法完全展开
        setTimeout(() => scheduleViewportUpdate(), 50);
        setTimeout(() => scheduleViewportUpdate(), 300);
    },
    true
);

document.addEventListener(
    'focusout',
    (event) => {
        const target = event?.target;
        if (!isTextInputLike(target)) return;

        // 输入框失去焦点时，重置视口高度
        setTimeout(() => scheduleViewportUpdate(), 100);
    },
    true
);
