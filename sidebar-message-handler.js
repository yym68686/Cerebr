// 监听来自content script的消息
window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'UPDATE_PLACEHOLDER') {
        const input = document.querySelector('#message-input');
        if (input) {
            input.placeholder = event.data.placeholder;
            if (event.data.timeout) {
                setTimeout(() => {
                    input.placeholder = '输入消息...';
                }, event.data.timeout);
            }
        }
    }
});

// 存储用户的问题历史
let userQuestions = [];
let currentIndex = -1;

// 等待 DOM 加载完成
document.addEventListener('DOMContentLoaded', () => {

    const input = document.querySelector('#message-input');
    const chatContainer = document.querySelector('#chat-container');

    // 监听输入框的键盘事件
    input.addEventListener('keydown', (event) => {
        // 检查是否是快捷键组合（Alt+A 或 MacCtrl+A）
        console.log('检查快捷键组合', event.key.toLowerCase());

        // 当按下向上键且输入框为空时
        if (event.key === 'ArrowUp' && event.target.value.trim() === '') {
            event.preventDefault(); // 阻止默认行为

            // 如果有历史记录
            if (userQuestions.length > 0) {
                // 如果是第一次按向上键，从最后一个问题开始
                if (currentIndex === -1) {
                    currentIndex = userQuestions.length - 1;
                } else {
                    // 否则向前移动一个问题
                    currentIndex = Math.max(0, currentIndex - 1);
                }
                event.target.value = userQuestions[currentIndex];
            }
        }
        // 当按下向下键时
        else if (event.key === 'ArrowDown' && currentIndex !== -1) {
            event.preventDefault();
            if (currentIndex < userQuestions.length - 1) {
                currentIndex++;
                event.target.value = userQuestions[currentIndex];
            } else {
                currentIndex = -1;
                event.target.value = '';
            }
        }
    });

    // 监听聊天容器的变化，检测新的用户消息
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.classList && node.classList.contains('user-message')) {
                    const question = node.textContent.trim();
                    if (question && userQuestions[userQuestions.length - 1] !== question) {
                        userQuestions.push(question);
                        console.log('保存问题:', question);
                        console.log('当前问题历史:', userQuestions);
                    }
                }
            });
        });
    });

    // 开始观察聊天容器的变化
    observer.observe(chatContainer, { childList: true });

    // 当输入框失去焦点时重置历史索引
    input.addEventListener('blur', () => {
        currentIndex = -1;
    });

    // 当输入其他内容时重置历史索引
    input.addEventListener('input', () => {
        currentIndex = -1;
    });
});