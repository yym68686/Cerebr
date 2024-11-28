document.addEventListener('DOMContentLoaded', async () => {
    const chatContainer = document.getElementById('chat-container');
    const messageInput = document.getElementById('message-input');

    async function sendMessage() {
        const message = messageInput.value.trim();
        if (!message) return;

        // 检查是否有选中的配置
        const config = apiConfigs[selectedConfigIndex];
        if (!config) {
            appendMessage('错误：未找到 API 配置，请在设置中配置 API', 'ai');
            return;
        }

        // 检查必要的配置项
        if (!config.baseUrl || !config.apiKey) {
            appendMessage('错误：请在设置中完善 API 配置信息', 'ai');
            return;
        }

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

            try {
                const response = await fetch(`${config.baseUrl}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${config.apiKey}`
                    },
                    body: JSON.stringify({
                        "model": config.modelName || "gpt-3.5-turbo",
                        "messages": messages,
                        "stream": true
                    })
                });

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const reader = response.body.getReader();
                let aiResponse = '';

                while (true) {
                    const {done, value} = await reader.read();
                    if (done) break;

                    const chunk = new TextDecoder().decode(value);
                    const lines = chunk.split('\n');

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const content = line.slice(6);

                            // 检查是否是结束标记
                            if (content.trim() === '[DONE]') {
                                console.log('流式响应结束');
                                continue;
                            }

                            try {
                                const data = JSON.parse(content);
                                // 检查响应结构
                                if (data.choices && data.choices.length > 0) {
                                    const choice = data.choices[0];
                                    if (choice.delta && choice.delta.content) {
                                        // 只有在有实际内容时才更新
                                        aiResponse += choice.delta.content;
                                        updateAIMessage(aiResponse);
                                    } else if (choice.finish_reason) {
                                        // 处理结束原因（如果需要）
                                        console.log('响应结束原因:', choice.finish_reason);
                                    }
                                } else if (data.usage) {
                                    // 处理使用统计信息（如果需要）
                                    console.log('Token 使用统计:', data.usage);
                                }
                            } catch (e) {
                                console.error('解析响应出错:', e);
                                console.log('出错的内容:', content);
                            }
                        }
                    }
                }
            } catch (error) {
                console.error('API 请求失败:', error);
                if (error.message.includes('Failed to fetch')) {
                    appendMessage('错误：无法连接到 API 服务器，请检查网络连接和 Base URL 配置', 'ai');
                } else {
                    appendMessage(`错误：${error.message}`, 'ai');
                }
            }
        } catch (error) {
            console.error('发送消息失败:', error);
            appendMessage('发送消息失败，请检查配置和网络连接', 'ai');
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

    // 处理换行和输入
    let isComposing = false;  // 跟踪输入法状态

    messageInput.addEventListener('compositionstart', () => {
        isComposing = true;
    });

    messageInput.addEventListener('compositionend', () => {
        isComposing = false;
    });

    messageInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            if (isComposing) {
                // 如果正在使用输入法，不发送消息
                return;
            }
            e.preventDefault();
            const text = this.value.trim();
            if (text) {  // 只有在有实际内容时才发送
                sendMessage();
            }
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
        // 更新开关状态和文本
        if (themeSwitch) {
            themeSwitch.checked = isDark;
        }
        const themeLabel = themeToggle?.querySelector('span');
        if (themeLabel) {
            themeLabel.textContent = isDark ? '深色模式' : '浅色模式';
        }

        // 保存主题设置
        chrome.storage.sync.set({ theme: isDark ? 'dark' : 'light' });
    }

    // 初始化主题
    async function initializeTheme() {
        try {
            const result = await chrome.storage.sync.get('theme');
            const systemTheme = checkSystemTheme();

            if (result.theme) {
                // 如果有保存的主题设置，使用保存的设置
                setTheme(result.theme === 'dark');
            } else {
                // 如果是首次使用，跟随系统主题
                setTheme(systemTheme);
            }
        } catch (error) {
            console.error('初始化主题失败:', error);
            // 如果出错，默认跟随系统主题
            setTheme(checkSystemTheme());
        }
    }

    // 监听系统主题变化
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        chrome.storage.sync.get('theme', (data) => {
            if (!data.theme) {  // 只有在用户没有手动设置主题时才跟随系统
                setTheme(e.matches);
            }
        });
    });

    // 监听主题切换开关
    themeSwitch.addEventListener('change', () => {
        setTheme(themeSwitch.checked);
    });

    // 立即初始化主题
    await initializeTheme();

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

    // API 设置功能
    const apiSettings = document.getElementById('api-settings');
    const apiSettingsToggle = document.getElementById('api-settings-toggle');
    const backButton = document.querySelector('.back-button');
    const apiCards = document.querySelector('.api-cards');

    // 加载保存的 API 配置
    let apiConfigs = [];
    let selectedConfigIndex = 0;

    // 从存储加载配置
    async function loadAPIConfigs() {
        try {
            const result = await chrome.storage.local.get('apiConfigs');
            if (result.apiConfigs && result.apiConfigs.length > 0) {
                apiConfigs = result.apiConfigs;
                selectedConfigIndex = result.selectedConfigIndex || 0;
            } else {
                // 创建默认配置
                apiConfigs = [{
                    apiKey: '',
                    baseUrl: 'https://api.openai.com/v1/chat/completions',
                    modelName: 'gpt-3.5-turbo'
                }];
                selectedConfigIndex = 0;
                await saveAPIConfigs();
            }
        } catch (error) {
            console.error('加载 API 配置失败:', error);
            // 如果加载失败，也创建默认配置
            apiConfigs = [{
                apiKey: '',
                baseUrl: 'https://api.openai.com/v1/chat/completions',
                modelName: 'gpt-3.5-turbo'
            }];
            selectedConfigIndex = 0;
        }

        // 确保一定会渲染卡片
        renderAPICards();
    }

    // 保存配置到存储
    async function saveAPIConfigs() {
        try {
            await chrome.storage.local.set({
                apiConfigs,
                selectedConfigIndex
            });
        } catch (error) {
            console.error('保存 API 配置失败:', error);
        }
    }

    // 渲染 API 卡片
    function renderAPICards() {
        // 确保模板元素存在
        const templateCard = document.querySelector('.api-card.template');
        if (!templateCard) {
            console.error('找不到模板卡片元素');
            return;
        }

        // 保存模板的副本
        const templateClone = templateCard.cloneNode(true);

        // 清空现有卡片
        apiCards.innerHTML = '';

        // 先重新添加模板（保持隐藏状态）
        apiCards.appendChild(templateClone);

        // 渲染实际的卡片
        apiConfigs.forEach((config, index) => {
            const card = createAPICard(config, index, templateClone);
            apiCards.appendChild(card);
        });
    }

    // 创建 API 卡片
    function createAPICard(config, index, templateCard) {
        // 克模板
        const template = templateCard.cloneNode(true);
        template.classList.remove('template');
        template.style.display = '';

        if (index === selectedConfigIndex) {
            template.classList.add('selected');
        }

        const apiKeyInput = template.querySelector('.api-key');
        const baseUrlInput = template.querySelector('.base-url');
        const modelNameInput = template.querySelector('.model-name');
        const apiForm = template.querySelector('.api-form');

        apiKeyInput.value = config.apiKey || '';
        baseUrlInput.value = config.baseUrl || 'https://api.openai.com/v1/chat/completions';
        modelNameInput.value = config.modelName || 'gpt-3.5-turbo';

        // 阻止输入框和按钮的点击事件冒泡
        const stopPropagation = (e) => e.stopPropagation();
        apiForm.addEventListener('click', stopPropagation);
        template.querySelector('.card-actions').addEventListener('click', stopPropagation);

        // 输入变化时保存
        [apiKeyInput, baseUrlInput, modelNameInput].forEach(input => {
            input.addEventListener('change', () => {
                apiConfigs[index] = {
                    apiKey: apiKeyInput.value,
                    baseUrl: baseUrlInput.value,
                    modelName: modelNameInput.value
                };
                saveAPIConfigs();
            });
        });

        // 复制配置
        template.querySelector('.duplicate-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            apiConfigs.push({...config});
            saveAPIConfigs();
            renderAPICards();
        });

        // 删除配置
        template.querySelector('.delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            if (apiConfigs.length > 1) {
                apiConfigs.splice(index, 1);
                if (selectedConfigIndex >= apiConfigs.length) {
                    selectedConfigIndex = apiConfigs.length - 1;
                }
                saveAPIConfigs();
                renderAPICards();
            }
        });

        // 选择配置
        template.addEventListener('click', () => {
            selectedConfigIndex = index;
            saveAPIConfigs();
            document.querySelectorAll('.api-card').forEach(card => {
                card.classList.remove('selected');
            });
            template.classList.add('selected');
            // 关闭设置页面
            apiSettings.classList.remove('visible');
        });

        return template;
    }

    // 等待 DOM 加载完成后再初始化
    await loadAPIConfigs();

    // 显示/隐藏 API 设置
    apiSettingsToggle.addEventListener('click', () => {
        apiSettings.classList.add('visible');
        settingsMenu.classList.remove('visible');
        // 确保每次打开设置时都重新渲染卡片
        renderAPICards();
    });

    // 返回聊天界面
    backButton.addEventListener('click', () => {
        apiSettings.classList.remove('visible');
    });

    // 清空聊天记录功能
    const clearChat = document.getElementById('clear-chat');
    clearChat.addEventListener('click', () => {
        // 清空聊天容器
        chatContainer.innerHTML = '';
        // 关闭设置菜单
        settingsMenu.classList.remove('visible');
    });
});