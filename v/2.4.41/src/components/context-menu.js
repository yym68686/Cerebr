// 显示上下文菜单
export function showContextMenu({
    event,                    // 事件对象
    messageElement,           // 消息元素
    contextMenu,             // 右键菜单元素
    stopUpdateButton,        // 停止更新按钮元素
    onMessageElementSelect,  // 消息元素选择回调
    windowDimensions = {     // 窗口尺寸（可选）
        width: window.innerWidth,
        height: window.innerHeight
    }
}) {
    event.preventDefault();

    // 记录打开菜单前的焦点，便于关闭时恢复
    try {
        contextMenu.__cerebrReturnFocusEl = document.activeElement;
    } catch {
        // ignore
    }

    // 调用消息元素选择回调
    if (onMessageElementSelect) {
        onMessageElementSelect(messageElement);
    }

    // 清理旧的内联 display（兼容旧版本）
    contextMenu.style.display = '';
    // 设置菜单可见
    contextMenu.classList.add('visible');

    // 根据消息状态显示或隐藏停止更新按钮
    if (messageElement.classList.contains('updating')) {
        stopUpdateButton.style.display = 'flex';
    } else {
        stopUpdateButton.style.display = 'none';
    }

    const menuWidth = contextMenu.offsetWidth;
    const menuHeight = contextMenu.offsetHeight;

    // 确保菜单不超出视口
    let x = event.clientX;
    let y = event.clientY;

    if (x + menuWidth > windowDimensions.width) {
        x = windowDimensions.width - menuWidth;
    }

    if (y + menuHeight > windowDimensions.height) {
        y = windowDimensions.height - menuHeight;
    }

    contextMenu.style.left = x + 'px';
    contextMenu.style.top = y + 'px';
}

// 隐藏上下文菜单
export function hideContextMenu({ contextMenu, onMessageElementReset, restoreFocus = true }) {
    contextMenu.classList.remove('visible');
    if (onMessageElementReset) {
        onMessageElementReset();
    }

    const returnFocusEl = contextMenu.__cerebrReturnFocusEl;
    contextMenu.__cerebrReturnFocusEl = null;
    if (restoreFocus && returnFocusEl?.isConnected) {
        returnFocusEl.focus?.({ preventScroll: true });
    }
}

// 复制消息内容
export function copyMessageContent({ messageElement, onSuccess, onError }) {
    if (messageElement) {
        // 获取存储的原始文本
        const originalText = messageElement.getAttribute('data-original-text');
        navigator.clipboard.writeText(originalText)
            .then(onSuccess)
            .catch(onError);
    }
}
