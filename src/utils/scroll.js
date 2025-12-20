function getInputOverlapPx(chatContainer) {
    const inputContainer = document.getElementById('input-container');
    if (!inputContainer) return 0;

    const containerRect = chatContainer.getBoundingClientRect();
    const inputRect = inputContainer.getBoundingClientRect();
    return Math.max(0, containerRect.bottom - inputRect.top);
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
        const bottomOffsetPx = getInputOverlapPx(chatContainer);

        const visibleTop = containerRect.top + marginPx;
        const visibleBottom = containerRect.bottom - bottomOffsetPx - marginPx;

        if (elementRect.bottom > visibleBottom + 1) {
            const delta = elementRect.bottom - visibleBottom;
            chatContainer.scrollTo({
                top: chatContainer.scrollTop + delta,
                behavior
            });
            return;
        }

        if (elementRect.top < visibleTop - 1) {
            const delta = visibleTop - elementRect.top;
            chatContainer.scrollTo({
                top: chatContainer.scrollTop - delta,
                behavior
            });
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
