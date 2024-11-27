document.addEventListener('DOMContentLoaded', function() {
    const chatContainer = document.getElementById('chat-container');
    const messageInput = document.getElementById('message-input');

    async function sendMessage() {
        const message = messageInput.value.trim();
        if (!message) return;

        // 显示用户消息
        appendMessage(message, 'user');
        messageInput.value = '';
        adjustTextareaHeight(messageInput);

        try {
            // 构建消息数组
            const messages = [];

            // 如果开启了网页问答，添加网页内容到上下文
            if (webpageSwitch.checked && pageContent) {
                messages.push({
                    role: "system",
                    content: `以下是当前网页的内容，请基于这些内容回答用户问题：\n标题：${pageContent.title}\nURL：${pageContent.url}\n内容：${pageContent.content}`
                });
            }

            // 添加用户问题
            messages.push({
                role: "user",
                content: message
            });

            const response = await fetch('http://127.0.0.1:8000/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ***REMOVED***123'
                },
                body: JSON.stringify({
                    "model": "gpt-4o",
                    "messages": messages,
                    "stream": true
                })
            });

            const reader = response.body.getReader();
            let aiResponse = '';

            while (true) {
                const {done, value} = await reader.read();
                if (done) break;

                const chunk = new TextDecoder().decode(value);
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.choices && data.choices[0].delta.content) {
                                aiResponse += data.choices[0].delta.content;
                                updateAIMessage(aiResponse);
                            }
                        } catch (e) {
                            console.error('解析响应出错:', e);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('发送消息失败:', error);
            appendMessage('抱歉，发送消息失败', 'ai');
        }
    }

    function appendMessage(text, sender) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}-message`;
        messageDiv.textContent = text;
        chatContainer.appendChild(messageDiv);
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function updateAIMessage(text) {
        const lastMessage = chatContainer.querySelector('.ai-message:last-child');
        if (lastMessage) {
            lastMessage.textContent = text;
        } else {
            appendMessage(text, 'ai');
        }
    }

    // 自动调整文本框高度
    function adjustTextareaHeight(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }

    // 设置按钮和菜单功能
    const settingsButton = document.getElementById('settings-button');
    const settingsMenu = document.getElementById('settings-menu');
    const toggleTheme = document.getElementById('toggle-theme');

    // 监听输入框变化
    messageInput.addEventListener('input', function() {
        adjustTextareaHeight(this);
    });

    // 处理换行
    messageInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // 设置按钮点击事件
    settingsButton.addEventListener('click', (e) => {
        e.stopPropagation();
        settingsMenu.classList.toggle('visible');
    });

    // 点击其他地方关闭菜单
    document.addEventListener('click', () => {
        settingsMenu.classList.remove('visible');
    });

    // 主题切换
    const themeSwitch = document.getElementById('theme-switch');
    const themeToggle = document.getElementById('theme-toggle');

    // 检查系统主题
    function checkSystemTheme() {
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    // 定义主题颜色
    const themes = {
        light: {
            '--cerebr-bg-color': '#ffffff',
            '--cerebr-text-color': '#000000',
            '--cerebr-message-user-bg': '#e3f2fd',
            '--cerebr-message-ai-bg': '#f5f5f5',
            '--cerebr-input-bg': '#f8f8f8',
            '--cerebr-icon-color': '#666666'
        },
        dark: {
            '--cerebr-bg-color': '#282c34',
            '--cerebr-text-color': '#abb2bf',
            '--cerebr-message-user-bg': '#3E4451',
            '--cerebr-message-ai-bg': '#2c313c',
            '--cerebr-input-bg': '#21252b',
            '--cerebr-icon-color': '#abb2bf'
        }
    };

    // 设置主题
    function setTheme(isDark) {
        const theme = isDark ? themes.dark : themes.light;
        for (const [property, value] of Object.entries(theme)) {
            document.documentElement.style.setProperty(property, value);
        }
        themeSwitch.checked = isDark;
        themeToggle.querySelector('span').textContent = isDark ? '深色模式' : '浅色模式';

        // 保存主题设置
        chrome.storage.sync.set({ theme: isDark ? 'dark' : 'light' });
    }

    // 初始化主题
    let currentTheme = checkSystemTheme();

    // 加载保存的主题设置
    chrome.storage.sync.get('theme', (data) => {
        if (data.theme) {
            currentTheme = data.theme === 'dark';
        }
        setTheme(currentTheme);
    });

    // 监听 Switch 切换
    themeSwitch.addEventListener('change', () => {
        currentTheme = themeSwitch.checked;
        setTheme(currentTheme);
    });

    // 监听系统主题变化
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        chrome.storage.sync.get('theme', (data) => {
            if (!data.theme) {  // 只有在用户没有手动设置主题时才跟随系统
                currentTheme = e.matches;
                setTheme(currentTheme);
            }
        });
    });

    // 网页问答功能
    const webpageSwitch = document.getElementById('webpage-switch');
    let pageContent = null;

    // 获取网页内容
    async function getPageContent() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) return null;

            const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_CONTENT' });
            return response;
        } catch (error) {
            console.error('获取网页内容失败:', error);
            return null;
        }
    }

    // 监听网页问答开关
    webpageSwitch.addEventListener('change', async () => {
        if (webpageSwitch.checked) {
            pageContent = await getPageContent();
            if (!pageContent) {
                webpageSwitch.checked = false;
                appendMessage('无法获取网页内容', 'ai');
            }
        } else {
            pageContent = null;
        }
    });
});