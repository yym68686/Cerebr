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