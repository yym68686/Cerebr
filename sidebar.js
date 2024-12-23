document.addEventListener('DOMContentLoaded', async () => {
    const chatContainer = document.getElementById('chat-container');
    const messageInput = document.getElementById('message-input');
    const contextMenu = document.getElementById('context-menu');
    const copyMessageButton = document.getElementById('copy-message');
    let currentMessageElement = null;

    // 聊天历史记录变量
    let chatHistory = [];

    // 保存聊天历史记录的函数
    async function saveChatHistory() {
        try {
            await chrome.storage.local.set({ chatHistory });
        } catch (error) {
            console.error('保存聊天历史记录失败:', error);
        }
    }

    // 提取公共配置
    const MATH_DELIMITERS = {
        regex: /(\\\\\([^]+?\\\\\))|(\\\([^]+?\\\))|(\\\[[\s\S]+?\\\])/g,
        // regex: /(\$\$[\s\S]+?\$\$)|(\$[^\s$][^$]*?\$)|(\\\\\([^]+?\\\\\))|(\\\([^]+?\\\))|(\\\[[\s\S]+?\\\])/g,
        renderConfig: {
            delimiters: [
                {left: '\\(', right: '\\)', display: false},  // 行内公式
                {left: '\\\\(', right: '\\\\)', display: false},  // 行内公式
                {left: '\\[', right: '\\]', display: true},   // 行间公式
                // {left: '$$', right: '$$', display: true},     // 行间公式（备用）
                // {left: '$', right: '$', display: false}       // 行内公式（备用）
            ],
            throwOnError: false
        }
    };

    // 加载历史记录的函数
    async function loadChatHistory() {
        try {
            const result = await chrome.storage.local.get('chatHistory');
            if (result.chatHistory) {
                chatHistory = result.chatHistory;
                // 清空当前显示的消息
                chatContainer.innerHTML = '';
                // 重新显示历史消息，但不要重复添加到历史记录中
                chatHistory.forEach(msg => {
                    appendMessage(msg.content, msg.role === 'user' ? 'user' : 'ai', true);
                });
            }
        } catch (error) {
            console.error('加载聊天历史记录失败:', error);
        }
    }

    // 监听标签页切换事件
    chrome.tabs.onActivated.addListener(async (activeInfo) => {
        console.log('标签页切换:', activeInfo);
        await loadChatHistory();
        await loadWebpageSwitch('标签页切换');
    });

    // 初始加载历史记录
    await loadChatHistory();


    // 网页问答功能
    const webpageSwitch = document.getElementById('webpage-switch');
    let pageContent = null;

    // 获取网页内容
    async function getPageContent() {
        try {
            console.log('getPageContent 发送获取网页内容请求');
            const response = await chrome.runtime.sendMessage({
                type: 'GET_PAGE_CONTENT_FROM_SIDEBAR'
            });
            return response;
        } catch (error) {
            console.error('获取网页内容失败:', error);
            return null;
        }
    }

    // 修改 loadWebpageSwitch 函数，添加延迟加载
    async function loadWebpageSwitch(call_name = 'loadWebpageSwitch') {
        console.log(`loadWebpageSwitch 从 ${call_name} 调用`);

        const domain = await getCurrentDomain();
        console.log('刷新后 网页问答 获取当前域名:', domain);
        if (!domain) return;

        const result = await chrome.storage.local.get('webpageSwitchDomains');
        const domains = result.webpageSwitchDomains || {};
        console.log('刷新后 网页问答存储中获取域名:', domains);

        if (domains[domain]) {
            webpageSwitch.checked = true;
            console.log('loadWebpageSwitch 刷新后 网页问答 获取网页内容');
            pageContent = await getPageContent();
            // 如果成功获取到内容，确保域名存在于存储中
            if (pageContent) {
                await saveWebpageSwitch(domain, true);
            }
        } else {
            webpageSwitch.checked = false;
            pageContent = null;
        }
    }

    // 修改网页问答开关监听器
    webpageSwitch.addEventListener('change', async () => {
        const domain = await getCurrentDomain();
        console.log('网页问答开关状态改变后，获取当前域名:', domain);
        if (!domain) {
            webpageSwitch.checked = false;
            return;
        }
        console.log('网页问答开关状态改变后，获取网页问答开关状态:', webpageSwitch.checked);

        // 添加延迟确保存储操作完成
        await new Promise(resolve => setTimeout(resolve, 100));

        if (webpageSwitch.checked) {
            console.log('网页问答开关状态改变后，获取网页内容');
            pageContent = await getPageContent();
            if (!pageContent) {
                webpageSwitch.checked = false;
                await saveWebpageSwitch(domain, false);
                appendMessage('无法获取网页内容', 'ai');
            } else {
                await saveWebpageSwitch(domain, true);
                console.log('修改网页问答为已开启');
            }
        } else {
            pageContent = null;
            await saveWebpageSwitch(domain, false);
            console.log('修改网页问答为已关闭');
        }
    });
    // 在 DOMContentLoaded 事件处理程序中添加加载网页问答状态
    await loadWebpageSwitch();

    // 在文件开头添加函数用于获取当前域名
    async function getCurrentDomain() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.url) return null;

            // 处理本地文件
            if (tab.url.startsWith('file://')) {
                return 'local_pdf';
            }

            const hostname = new URL(tab.url).hostname;

            // 规范化域名
            const normalizedDomain = hostname
                .replace(/^www\./, '')  // 移除www前缀
                .toLowerCase();         // 转换为小写

            console.log('规范化域名:', hostname, '->', normalizedDomain);
            return normalizedDomain;
        } catch (error) {
            console.error('获取当前域名失败:', error);
            return null;
        }
    }

    async function sendMessage() {
        const message = messageInput.value.trim();
        if (!message) return;

        // 检查是否有选中的配置
        const config = apiConfigs[selectedConfigIndex];
        if (!config) {
            appendMessage('错误：未找到 API 配置，请在设置中配置 API', 'ai', true);
            return;
        }

        // 检查必要的配置项
        if (!config.baseUrl || !config.apiKey) {
            appendMessage('错误：请在设置中完善 API 配置信息', 'ai', true);
            return;
        }

        try {
            // 构建消息数组
            const messages = [...chatHistory]; // 复制所有历史消息

            // 默认的系统消息
            const defaultSystemMessage = {
                role: "system",
                content: `数学公式请使用LaTeX表示，行间公式请使用\\[...\\]表示，行内公式请使用\\(...\\)表示，禁止使用$...$表示行内公式。用户语言是 ${navigator.language}，请优先使用该语言回复。`
            };

            // 如果是第一条消息或第一条不是系统消息，添加默认系统消息
            if (messages.length === 0 || messages[0].role !== "system") {
                messages.unshift(defaultSystemMessage);
            }

            // 如果开启了网页问答，修改系统消息添加网页内容
            if (webpageSwitch.checked && pageContent) {
                messages[0] = {
                    role: "system",
                    content: `${defaultSystemMessage.content}\n以下是当前网页的内容，请基于这些内容回答用户问题：\n标题：${pageContent.title}\nURL：${pageContent.url}\n内容：${pageContent.content}`
                };
            }

            // 添加用户问题
            const userMessage = {
                role: "user",
                content: message
            };
            messages.push(userMessage);

            // 显示用户消息并清空输入框
            appendMessage(message, 'user');
            messageInput.value = '';
            adjustTextareaHeight(messageInput);

            let hasError = false; // 添加错误标记
            try {
                const response = await fetch(`${config.baseUrl}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${config.apiKey}`
                    },
                    body: JSON.stringify({
                        "model": config.modelName || "gpt-4o",
                        "messages": messages,
                        "stream": true
                    })
                });
                console.log('消息数组状态:', messages);

                if (!response.ok) {
                    hasError = true; // 设置错误标记
                    const errorText = await response.text();
                    console.log('服务器返回的错误响应:', {
                        status: response.status,
                        statusText: response.statusText,
                        errorText: errorText,
                        headers: Object.fromEntries(response.headers.entries())
                    });

                    let errorMessage = `HTTP 错误! 状态码: ${response.status}`;
                    try {
                        // 尝试解析JSON
                        console.log('尝试解析错误响应为JSON:', errorText);
                        const errorJson = JSON.parse(errorText);
                        console.log('解析后的JSON:', errorJson);

                        if (errorJson.error) {
                            console.log('错误对象类型:', typeof errorJson.error);
                            console.log('错误对象内容:', errorJson.error);

                            if (typeof errorJson.error === 'string') {
                                errorMessage += `\n错误信息: ${errorJson.error}`;
                            } else if (errorJson.error.message) {
                                errorMessage += `\n错误信息: ${errorJson.error.message}`;
                            } else {
                                // 如果error对象存在但没有预期的格式，则输出整个error对象
                                errorMessage += `\n错误信息: ${JSON.stringify(errorJson.error)}`;
                            }
                        } else {
                            // 如果没有error字段，则尝试使用整个响应对象
                            errorMessage += `\n错误信息: ${JSON.stringify(errorJson)}`;
                        }
                    } catch (e) {
                        console.log('JSON解析失败:', e);
                        // 如果不是JSON格式，直接使用错误文本
                        if (errorText && errorText.trim()) {
                            errorMessage += `\n错误信息: ${errorText.trim()}`;
                        } else {
                            // 如果没有错误文本，则根据状态码提供通用错误信息
                            switch (response.status) {
                                case 503:
                                    errorMessage += '\n错误信息: 服务暂时不可用，请稍后重试';
                                    break;
                                case 500:
                                    errorMessage += '\n错误信息: 服务器内部错误';
                                    break;
                                case 429:
                                    errorMessage += '\n错误信息: 请求过于频繁，请稍后重试';
                                    break;
                                case 401:
                                    errorMessage += '\n错误信息: 认证失败，请检查API密钥';
                                    break;
                                case 403:
                                    errorMessage += '\n错误信息: 无权访问，请检查API密钥权限';
                                    break;
                                default:
                                    errorMessage += '\n错误信息: 服务器响应异常';
                            }
                        }
                    }
                    console.log('最终错误信息:', errorMessage);
                    appendMessage(errorMessage, 'ai', true);
                    return;
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
                hasError = true; // 设置错误标记
                console.error('API 请求失败:', error);
                if (error.message.includes('Failed to fetch')) {
                    appendMessage('错误：无法连接到 API 服务器，请检查网络连接和 Base URL 配置', 'ai', true);
                } else if (error.message.includes('HTTP 错误!')) {
                    appendMessage(error.message, 'ai', true);
                } else {
                    appendMessage(`错误：${error.message}`, 'ai', true);
                }
            } finally {
                // 在finally块中处理错误情况下的历史记录
                if (hasError) {
                    chatHistory.pop(); // 如果发生错误，移除最后一条用户消息
                }
            }
        } catch (error) {
            console.error('发送消息失败:', error);
            appendMessage('发送消息失败，请检查配置和网络连接', 'ai', true);
            chatHistory.pop(); // 确保在最外层的错误处理中也移除用户消息
        }
    }

    // 提取公共的数学公式处理函数
    function processMathAndMarkdown(text) {
        const mathExpressions = [];
        let mathIndex = 0;

        // 临时替换数学公式
        text = text.replace(MATH_DELIMITERS.regex, (match) => {
            // 替换 abla_ 为 \nabla_
            match = match.replace(/abla_/g, '\\nabla_');

            // 如果是普通括号形式的公式，转换为 \(...\) 形式
            if (match.startsWith('(') && match.endsWith(')') && !match.startsWith('\\(')) {
                console.log('警告：请使用 \\(...\\) 来表示行内公式');
            }
            const placeholder = `%%MATH_EXPRESSION_${mathIndex}%%`;
            mathExpressions.push(match);
            mathIndex++;
            return placeholder;
        });

        // 配置 marked
        marked.setOptions({
            breaks: true,
            gfm: true,
            sanitize: false,
            highlight: function(code, lang) {
                if (lang && hljs.getLanguage(lang)) {
                    try {
                        return hljs.highlight(code, { language: lang }).value;
                    } catch (err) {}
                }
                return hljs.highlightAuto(code).value;
            }
        });

        // 渲染 Markdown
        let html = marked.parse(text);

        // 恢复数学公式
        html = html.replace(/%%MATH_EXPRESSION_(\d+)%%/g, (_, index) => mathExpressions[index]);

        return html;
    }

    // 添加侧边栏可见性状态变量
    let isSidebarVisible = true; // 默认为可见状态

    // 监听来自 content script 的消息
    window.addEventListener('message', (event) => {
        if (event.data.type === 'FOCUS_INPUT') {
            messageInput.focus();
            // 确保光标移动到末尾
            requestAnimationFrame(() => {
                const length = messageInput.value.length;
                messageInput.setSelectionRange(length, length);
            });
        } else if (event.data.type === 'SIDEBAR_VISIBILITY_CHANGED') {
            // 更新侧边栏可见性状态
            isSidebarVisible = event.data.isVisible;
            if (!event.data.isVisible) {
                console.log('侧边栏已隐藏，继续保持消息更新');
                // 移除自动滚动
            } else {
                console.log('侧边栏已显示');
            }
        }
    });

    function updateAIMessage(text) {
        const lastMessage = chatContainer.querySelector('.ai-message:last-child');
        let rawText = text;

        if (lastMessage) {
            // 获取当前显示的文本
            const currentText = lastMessage.getAttribute('data-original-text') || '';
            // 如果新文本比当前文本长，说明有新内容需要更新
            if (text.length > currentText.length) {
                // 更新原始文本属性
                lastMessage.setAttribute('data-original-text', text);

                // 处理数学公式和Markdown
                lastMessage.innerHTML = processMathAndMarkdown(text);

                // 处理新渲染的链接
                lastMessage.querySelectorAll('a').forEach(link => {
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                });

                // 渲染LaTeX公式
                renderMathInElement(lastMessage, MATH_DELIMITERS.renderConfig);

                // 更新历史记录
                if (chatHistory.length > 0) {
                    chatHistory[chatHistory.length - 1].content = rawText;
                    saveChatHistory();
                }
            }
        } else {
            appendMessage(rawText, 'ai');
        }
    }

    // 修改appendMessage函数，只在发送新消息时滚动
    function appendMessage(text, sender, skipHistory = false) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}-message`;
        // 存储原始文本用于复制
        messageDiv.setAttribute('data-original-text', text);

        // 处理数学公式和 Markdown
        messageDiv.innerHTML = processMathAndMarkdown(text);

        // 处理消息中的链接
        messageDiv.querySelectorAll('a').forEach(link => {
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
        });

        // 渲染 LaTeX 公式
        renderMathInElement(messageDiv, MATH_DELIMITERS.renderConfig);

        chatContainer.appendChild(messageDiv);

        // 只在发送新消息时自动滚动（不是加载历史记录）
        if (sender === 'user' && !skipHistory) {
            requestAnimationFrame(() => {
                chatContainer.scrollTo({
                    top: chatContainer.scrollHeight,
                    behavior: 'smooth'
                });
            });
        }

        // 只有在不跳过历史记录时才添加到历史记录
        if (!skipHistory) {
            chatHistory.push({
                role: sender === 'user' ? 'user' : 'assistant',
                content: text
            });
            saveChatHistory();
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
        } else if (e.key === 'Escape') {
            // 按 ESC 键时让输入框失去焦点
            messageInput.blur();
        }
    });

    // 修改点击事件监听器
    document.addEventListener('click', (e) => {
        // 如果点击的不是设置按钮本身和设置菜单，就关闭菜单
        if (!settingsButton.contains(e.target) && !settingsMenu.contains(e.target)) {
            settingsMenu.classList.remove('visible');
        }
    });

    // 确保设置按钮的点击事件在文档点击事件之前处理
    settingsButton.addEventListener('click', (e) => {
        e.stopPropagation();
        settingsMenu.classList.toggle('visible');
    });

    // 添加输入框的事件监听器
    messageInput.addEventListener('focus', () => {
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

    // 修改 saveWebpageSwitch 函数，改进存储机制和错误处理
    async function saveWebpageSwitch(domain, enabled) {
        console.log('开始保存网页问答开关状态:', domain, enabled);

        // 获取当前存储的所有域名状态
        const result = await chrome.storage.local.get('webpageSwitchDomains');
        let domains = result.webpageSwitchDomains || {};
        console.log('获取到当前存储的域名状态:', domains);

        // 更新状态
        if (enabled) {
            domains[domain] = true;
        } else {
            domains[domain] = false;
        }

        console.log('准备保存的域名状态:', domains);

        // 保存并立即验证
        await chrome.storage.local.set({ webpageSwitchDomains: domains });
    }

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
            const result = await chrome.storage.sync.get(['apiConfigs', 'selectedConfigIndex']);
            if (result.apiConfigs && result.apiConfigs.length > 0) {
                apiConfigs = result.apiConfigs;
                selectedConfigIndex = result.selectedConfigIndex || 0;
            } else {
                // 创建默认配置
                apiConfigs = [{
                    apiKey: '',
                    baseUrl: 'https://api.openai.com/v1/chat/completions',
                    modelName: 'gpt-4o'
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
                modelName: 'gpt-4o'
            }];
            selectedConfigIndex = 0;
        }

        // 确保一定会渲染卡片
        renderAPICards();
    }

    // 保存配置到存储
    async function saveAPIConfigs() {
        try {
            await chrome.storage.sync.set({
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

        // 渲染实际的卡
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
        modelNameInput.value = config.modelName || 'gpt-4o';

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
        // 清空聊天历史记录
        chatHistory = [];
        saveChatHistory();
        // 关闭设置菜单
        settingsMenu.classList.remove('visible');
    });

    // 添加点击事件监听
    chatContainer.addEventListener('click', () => {
        // 点击聊天区域时让输入框失去焦点
        messageInput.blur();
    });

    // 监听输入框的焦点状态
    messageInput.addEventListener('focus', () => {
        // 输入框获得焦点时，阻止事件冒泡
        messageInput.addEventListener('click', (e) => e.stopPropagation());
    });

    messageInput.addEventListener('blur', () => {
        // 输入框失去焦点时，移除点击事件监听
        messageInput.removeEventListener('click', (e) => e.stopPropagation());
    });

    // 右键菜单功能
    function showContextMenu(e, messageElement) {
        e.preventDefault();
        currentMessageElement = messageElement;

        // 设置菜单位置
        contextMenu.style.display = 'block';
        const menuWidth = contextMenu.offsetWidth;
        const menuHeight = contextMenu.offsetHeight;

        // 确保菜单不会超出视口
        let x = e.clientX;
        let y = e.clientY;

        if (x + menuWidth > window.innerWidth) {
            x = window.innerWidth - menuWidth;
        }

        if (y + menuHeight > window.innerHeight) {
            y = window.innerHeight - menuHeight;
        }

        contextMenu.style.left = x + 'px';
        contextMenu.style.top = y + 'px';
    }

    // 隐藏右键菜单
    function hideContextMenu() {
        contextMenu.style.display = 'none';
        currentMessageElement = null;
    }

    // 复制消息内容
    function copyMessageContent() {
        if (currentMessageElement) {
            // 获取存储的原始文本
            const originalText = currentMessageElement.getAttribute('data-original-text');
            navigator.clipboard.writeText(originalText).then(() => {
                hideContextMenu();
            }).catch(err => {
                console.error('复制失败:', err);
            });
        }
    }

    // 监听 AI 消息的右键点击
    chatContainer.addEventListener('contextmenu', (e) => {
        const messageElement = e.target.closest('.ai-message');
        if (messageElement) {
            showContextMenu(e, messageElement);
        }
    });

    // 点击复制按钮
    copyMessageButton.addEventListener('click', copyMessageContent);

    // 点击其他地方隐藏菜单
    document.addEventListener('click', (e) => {
        if (!contextMenu.contains(e.target)) {
            hideContextMenu();
        }
    });

    // 滚动时隐藏菜单
    chatContainer.addEventListener('scroll', hideContextMenu);

    // 按下 Esc 键隐藏菜单
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hideContextMenu();
        }
    });
});