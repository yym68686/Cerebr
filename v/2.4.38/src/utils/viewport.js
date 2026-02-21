// 用于存储原始视口高度
let originalViewportHeight = window.innerHeight;

// 设置视口高度变量
function setViewportHeight() {
    // 获取实际视口高度
    const vh = window.innerHeight * 0.01;
    // 设置CSS变量
    document.documentElement.style.setProperty('--vh', `${vh}px`);

    // 计算输入法是否弹出
    const isKeyboardVisible = window.innerHeight < originalViewportHeight * 0.8;

    if (isKeyboardVisible) {
        // 输入法弹出时，调整聊天容器的高度和上边距
        const keyboardHeight = originalViewportHeight - window.innerHeight;
        document.documentElement.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
        document.documentElement.style.setProperty('--chat-top-margin', `${keyboardHeight}px`);
        document.body.classList.add('keyboard-visible');
    } else {
        document.documentElement.style.setProperty('--keyboard-height', '0px');
        document.documentElement.style.setProperty('--chat-top-margin', '0px');
        document.body.classList.remove('keyboard-visible');
        // 更新原始视口高度
        originalViewportHeight = window.innerHeight;
    }
}

// 初始设置
setViewportHeight();

// 监听视口大小变化（包括输入法弹出）
let resizeTimeout;
window.addEventListener('resize', () => {
    // 使用防抖来优化性能
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        setViewportHeight();

        // // 获取聊天容器
        // const chatContainer = document.getElementById('chat-container');
        // if (chatContainer) {
        //     // 重新计算滚动位置
        //     const scrollPosition = chatContainer.scrollTop;
        //     const scrollHeight = chatContainer.scrollHeight;
        //     const clientHeight = chatContainer.clientHeight;

        //     // 如果之前滚动到底部，保持在底部
        //     if (scrollHeight - scrollPosition <= clientHeight + 50) {
        //         chatContainer.scrollTop = chatContainer.scrollHeight;
        //     }
        // }
    }, 100);
});

// 监听输入框焦点事件
document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('message-input');
    if (input) {
        input.addEventListener('focus', () => {
            // 给一点延迟，等待输入法完全展开
            setTimeout(() => {
                setViewportHeight();
                // 滚动到底部
                // const chatContainer = document.getElementById('chat-container');
                // if (chatContainer) {
                //     chatContainer.scrollTop = chatContainer.scrollHeight;
                // }
            }, 300);
        });

        input.addEventListener('blur', () => {
            // 输入框失去焦点时，重置视口高度
            setTimeout(() => {
                setViewportHeight();
            }, 100);
        });
    }
});