import { scrollByDelta } from './scroll-root.js';

function getInputOverlapPx() {
    const inputContainer = document.getElementById('input-container');
    if (!inputContainer) return 0;

    const inputRect = inputContainer.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    return Math.max(0, viewportHeight - inputRect.top);
}

/**
 * 确保某个聊天消息在可视区域内（考虑底部固定输入栏遮挡）。
 * @param {Object} params
 * @param {HTMLElement} params.chatContainer
 * @param {HTMLElement} params.element
 * @param {ScrollBehavior} [params.behavior='auto']
 * @param {number} [params.marginPx=12]
 */
export function ensureChatElementVisible({
    chatContainer,
    element,
    behavior = 'auto',
    marginPx = 12
}) {
    if (!chatContainer || !element) return;

    requestAnimationFrame(() => {
        if (!element.isConnected || !chatContainer.isConnected || !chatContainer.contains(element)) return;
        const containerRect = chatContainer.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        const bottomOffsetPx = getInputOverlapPx();

        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const visibleTop = Math.max(0, containerRect.top) + marginPx;
        const visibleBottom = viewportHeight - bottomOffsetPx - marginPx;

        if (elementRect.bottom > visibleBottom + 1) {
            const delta = elementRect.bottom - visibleBottom;
            scrollByDelta(delta, behavior);
            return;
        }

        if (elementRect.top < visibleTop - 1) {
            const delta = visibleTop - elementRect.top;
            scrollByDelta(-delta, behavior);
        }
    });
}

/**
 * 让聊天容器的底部 padding 能随输入栏高度变化而补足，避免消息被遮挡。
 * @param {Object} [params]
 * @param {number} [params.basePaddingPx=60] - 与 `#chat-container` 的默认 padding-bottom 对齐
 */
export function syncChatBottomExtraPadding({ basePaddingPx = 60 } = {}) {
    const inputContainer = document.getElementById('input-container');
    if (!inputContainer) return;

    const inputHeight = inputContainer.getBoundingClientRect().height;
    const extraPadding = Math.max(0, Math.ceil(inputHeight - basePaddingPx));
    document.documentElement.style.setProperty('--chat-bottom-extra-padding', `${extraPadding}px`);
}
