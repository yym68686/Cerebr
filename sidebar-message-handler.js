// 监听来自content script的消息
window.addEventListener('message', (event) => {
    // 处理 URL 变化消息
    if (event.data && event.data.type === 'URL_CHANGED') {
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

// 添加全局变量
let clearChat;

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

// 添加快捷键处理函数
async function handleShortcut(event) {
    const lastLetter = await checkCustomShortcut();
    const clearLastLetter = await checkClearChatShortcut();

    // 检查是否是清空聊天记录的快捷键
    if ((event.ctrlKey && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent)) &&
        event.key.toLowerCase() === clearLastLetter) {
        event.preventDefault();
        if (clearChat) {
            clearChat.click();
            // 聚焦输入框并将光标移到末尾
            const input = document.querySelector('#message-input');
            if (input) {
                input.focus();
                // 移动光标到末尾
                const range = document.createRange();
                range.selectNodeContents(input);
                range.collapse(false);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
            }
        }
        return;
    }

    // 检查是否是切换侧边栏的快捷键
    if ((event.ctrlKey && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent)) &&
        event.key.toLowerCase() === lastLetter) {
        event.preventDefault();
        window.parent.postMessage({ type: 'TOGGLE_SIDEBAR' }, '*');
        return;
    }
}

// 等待 DOM 加载完成
document.addEventListener('DOMContentLoaded', () => {
    const input = document.querySelector('#message-input');
    const chatContainer = document.querySelector('#chat-container');
    // 初始化全局变量
    clearChat = document.querySelector('#clear-chat');

    // 为整个文档添加快捷键监听
    document.addEventListener('keydown', handleShortcut);

    // 监听输入框的键盘事件
    input.addEventListener('keydown', async (event) => {
        // 先处理快捷键
        await handleShortcut(event);

        // 处理输入框特定的键盘事件
        // 当按下向上键且输入框为空时
        if (event.key === 'ArrowUp' && event.target.value.trim() === '') {
            event.preventDefault(); // 阻止默认行为

            // 如果有历史记录
            if (userQuestions.length > 0) {
                // 如果是第一次按向上键从最后一个问题开始
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