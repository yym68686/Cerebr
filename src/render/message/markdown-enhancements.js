import { t } from '../../utils/i18n.js';
import { showToast } from '../../utils/ui.js';

// 代码块的“hover 显示复制 / 点右上角复制”原先给每个 <pre> 各挂 3 个监听器。流式输出时
// 整条消息的 HTML 每 100ms 被整体替换一次，旧节点连同监听器一起丢弃、新节点重新挂，
// 长回复里几十个代码块就是几百次 addEventListener。
//
// 改成在容器上做一次事件委托：监听器数量与代码块数量无关，且 innerHTML 替换不影响它。
// 每个 <pre> 的瞬时状态（是否 hover、复制提示计时器）改用 WeakMap 存，随节点被回收。
const TAG_HEIGHT = 28;
const TAG_WIDTH = 92;

const preState = new WeakMap();

function stateOf(pre) {
    let state = preState.get(pre);
    if (!state) {
        state = { hovered: false, copiedTimer: null, originalLabel: null, hadLanguageAttr: false };
        preState.set(pre, state);
    }
    return state;
}

// 原始语言标签要在首次接触该 <pre> 时记下来：之后标签会被改成“复制 / 已复制”，
// 晚一步读就读不到真实值了。
function captureOriginalLabel(pre) {
    const state = stateOf(pre);
    if (state.originalLabel === null) {
        state.hadLanguageAttr = pre.hasAttribute('data-language');
        state.originalLabel = pre.getAttribute('data-language') || '';
    }
    return state;
}

function setLabel(pre, label) {
    const state = stateOf(pre);
    if (!label) {
        if (!state.hadLanguageAttr) pre.removeAttribute('data-language');
        else pre.setAttribute('data-language', '');
        return;
    }
    pre.setAttribute('data-language', label);
}

function isInTagArea(pre, event) {
    const rect = pre.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return y >= 0 && y <= TAG_HEIGHT && x >= rect.width - TAG_WIDTH;
}

async function copyFromPre(pre) {
    const code = pre.querySelector('code');
    if (!code) return;
    const state = captureOriginalLabel(pre);
    const codeText = code.textContent ?? '';
    const finish = (labelKey, delay) => {
        setLabel(pre, t(labelKey));
        if (state.copiedTimer) clearTimeout(state.copiedTimer);
        state.copiedTimer = setTimeout(() => {
            state.copiedTimer = null;
            setLabel(pre, state.hovered ? t('label_copy') : state.originalLabel);
        }, delay);
    };
    try {
        await navigator.clipboard.writeText(codeText);
        showToast(t('toast_copied_code'), { type: 'success' });
        finish('label_copied', 800);
    } catch {
        showToast(t('toast_copy_failed'), { type: 'error' });
        finish('label_copy_failed', 900);
    }
}

// 在滚动容器上注册一次；对同一个容器重复调用是幂等的。
export function installCodeBlockDelegation(container) {
    if (!container || container.dataset.cerebrCodeDelegated === '1') return;
    container.dataset.cerebrCodeDelegated = '1';

    // mouseenter/leave 不冒泡，用 mouseover/mouseout 配合 relatedTarget 判断跨界。
    container.addEventListener(
        'mouseover',
        (event) => {
            const pre = event.target.closest?.('pre');
            if (!pre || !container.contains(pre)) return;
            if (pre.contains(event.relatedTarget)) return;
            const state = captureOriginalLabel(pre);
            state.hovered = true;
            if (!state.copiedTimer) setLabel(pre, t('label_copy'));
        },
        { passive: true }
    );

    container.addEventListener(
        'mouseout',
        (event) => {
            const pre = event.target.closest?.('pre');
            if (!pre || !container.contains(pre)) return;
            if (pre.contains(event.relatedTarget)) return;
            const state = stateOf(pre);
            state.hovered = false;
            if (state.copiedTimer) return;
            setLabel(pre, state.originalLabel ?? '');
        },
        { passive: true }
    );

    container.addEventListener('click', (event) => {
        const pre = event.target.closest?.('pre');
        if (!pre || !container.contains(pre)) return;
        if (!isInTagArea(pre, event)) return;
        event.preventDefault();
        event.stopPropagation();
        void copyFromPre(pre);
    });
}

// 只做无法用 CSS/委托覆盖的部分：标记 class，并在标签被改写前记下原始语言。
export function enhanceCodeBlocks(root) {
    if (!root) return;
    root.querySelectorAll('pre').forEach((pre) => {
        captureOriginalLabel(pre);
        pre.classList.add('code-copy-on-label');
    });
}
