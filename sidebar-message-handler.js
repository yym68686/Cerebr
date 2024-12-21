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
    // 处理 URL 变化消息
    else if (event.data && event.data.type === 'URL_CHANGED') {
        console.log('[收到URL变化]', event.data.url);
        // 检查网页问答开关是否打开
        const webpageSwitch = document.querySelector('#webpage-switch');
        if (webpageSwitch && webpageSwitch.checked) {
            console.log('[网页问答] 重新获取页面内容');
            // 模拟手动关闭再打开网页问答
            console.log('[网页问答] 模拟关闭网页问答');
            webpageSwitch.checked = false;
            // 触发 change 事件
            webpageSwitch.dispatchEvent(new Event('change'));

            // 延迟一秒后重新打开
            setTimeout(() => {
                console.log('[网页问答] 模拟打开网页问答');
                webpageSwitch.checked = true;
                // 触发 change 事件
                webpageSwitch.dispatchEvent(new Event('change'));
            }, 1000);
        }
    }
});

// 存储用户的问题历史
let userQuestions = [];
let currentIndex = -1;

function checkCustomShortcut() {
    return new Promise((resolve) => {
        chrome.commands.getAll((commands) => {
            const toggleCommand = commands.find(command => command.name === 'toggle_sidebar');
            if (toggleCommand && toggleCommand.shortcut) {
                const lastLetter = toggleCommand.shortcut.charAt(toggleCommand.shortcut.length - 1).toLowerCase();
                console.log('当前设置的快捷键:', toggleCommand.shortcut, '最后一个字符:', lastLetter);
                resolve(lastLetter);
            } else {
                resolve(null);
            }
        });
    });
}

// 检查清空聊天记录快捷键
function checkClearChatShortcut() {
    return new Promise((resolve) => {
        chrome.commands.getAll((commands) => {
            const clearCommand = commands.find(command => command.name === 'clear_chat');
            if (clearCommand && clearCommand.shortcut) {
                const lastLetter = clearCommand.shortcut.charAt(clearCommand.shortcut.length - 1).toLowerCase();
                console.log('当前设置的清空聊天记录快捷键:', clearCommand.shortcut, '最后一个字符:', lastLetter);
                resolve(lastLetter);
            } else {
                resolve(null);
            }
        });
    });
}

// 等待 DOM 加载完成
document.addEventListener('DOMContentLoaded', () => {

    const input = document.querySelector('#message-input');
    const chatContainer = document.querySelector('#chat-container');
    const clearChat = document.querySelector('#clear-chat');

    // 监听输入框的键盘事件
    input.addEventListener('keydown', async (event) => {
        // 检查是否是快捷键组合（Alt+A 或 MacCtrl+A）
        const lastLetter = await checkCustomShortcut();
        const clearLastLetter = await checkClearChatShortcut();

        // 检查是否是清空聊天记录的快捷键
        if ((event.altKey || (event.ctrlKey && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent))) &&
            event.key.toLowerCase() === clearLastLetter) {
            event.preventDefault();
            clearChat.click();
            return;
        }

        // 检查是否是切换侧边栏的快捷键
        if ((event.altKey || (event.ctrlKey && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent))) &&
            event.key.toLowerCase() === lastLetter) {
            event.preventDefault();
            window.parent.postMessage({ type: 'TOGGLE_SIDEBAR' }, '*');
            return;
        }

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
                // 触发输入事件以调整高度
                event.target.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
        // 当按下向下键时
        else if (event.key === 'ArrowDown' && currentIndex !== -1) {
            event.preventDefault();
            if (currentIndex < userQuestions.length - 1) {
                currentIndex++;
                event.target.value = userQuestions[currentIndex];
                // 触发输入事件以调整高度
                event.target.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                currentIndex = -1;
                event.target.value = '';
                // 触发输入事件以调整高度
                event.target.dispatchEvent(new Event('input', { bubbles: true }));
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