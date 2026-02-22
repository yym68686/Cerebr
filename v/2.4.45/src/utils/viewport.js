// 记录“键盘未弹出时”的布局视口高度，用于没有 VisualViewport 的环境。
let baselineLayoutViewportHeight = window.innerHeight;

// 上一次计算的键盘高度（用于同步阅读进度跟随键盘动画）
let lastKeyboardHeight = 0;

const KEYBOARD_THRESHOLD_PX = 50;

const getLayoutViewportHeight = () => {
    return window.innerHeight || document.documentElement?.clientHeight || 0;
};

const computeKeyboardHeight = () => {
    const layoutHeight = getLayoutViewportHeight();

    let keyboardHeightFromVisualViewport = 0;
    const vv = window.visualViewport;
    if (vv) {
        const visualBottom = vv.height + vv.offsetTop;
        const raw = layoutHeight - visualBottom;
        if (raw > KEYBOARD_THRESHOLD_PX) {
            keyboardHeightFromVisualViewport = raw;
        }
    }

    let keyboardHeightFromInnerHeight = 0;
    const rawInner = baselineLayoutViewportHeight - layoutHeight;
    if (rawInner > KEYBOARD_THRESHOLD_PX) {
        keyboardHeightFromInnerHeight = rawInner;
    }

    const keyboardHeight = Math.round(Math.max(0, keyboardHeightFromVisualViewport, keyboardHeightFromInnerHeight));
    return { layoutHeight, keyboardHeight };
};

const syncChatScrollForKeyboardDelta = (deltaPx) => {
    if (!deltaPx) return;
    const chatContainer = document.getElementById('chat-container');
    if (!chatContainer) return;

    const nextScrollTop = Math.max(0, chatContainer.scrollTop + deltaPx);
    chatContainer.__cerebrIgnoreNextScroll = true;
    chatContainer.scrollTop = nextScrollTop;
};

const applyViewportState = () => {
    const { layoutHeight, keyboardHeight } = computeKeyboardHeight();

    // 兼容旧 CSS：虽然目前未使用，但保留 --vh 变量以避免未来回归时踩坑。
    const vh = layoutHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);

    document.documentElement.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
    const isKeyboardVisible = keyboardHeight > 0;
    document.body.classList.toggle('keyboard-visible', isKeyboardVisible);

    // 键盘动画时让阅读进度始终跟随（无条件跟随：键盘出现/消失都同步滚动量）
    const deltaKeyboardHeight = keyboardHeight - lastKeyboardHeight;
    lastKeyboardHeight = keyboardHeight;
    syncChatScrollForKeyboardDelta(deltaKeyboardHeight);

    if (!isKeyboardVisible) {
        baselineLayoutViewportHeight = layoutHeight;
    }
};

let rafId = 0;
const scheduleViewportUpdate = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
        rafId = 0;
        applyViewportState();
    });
};

// 初始设置
scheduleViewportUpdate();

// 监听布局视口变化（桌面/安卓等）
window.addEventListener('resize', scheduleViewportUpdate, { passive: true });

// iOS Safari：键盘弹出主要影响 visualViewport。
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', scheduleViewportUpdate);
    window.visualViewport.addEventListener('scroll', scheduleViewportUpdate);
}

// 监听输入框焦点事件：给一点延迟，等待输入法完全展开/收起。
document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('message-input');
    if (!input) return;

    input.addEventListener('focus', () => {
        setTimeout(scheduleViewportUpdate, 300);
    });

    input.addEventListener('blur', () => {
        setTimeout(scheduleViewportUpdate, 120);
    });
});
