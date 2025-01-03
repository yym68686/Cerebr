document.addEventListener('DOMContentLoaded', async () => {
    const chatContainer = document.getElementById('chat-container');
    const messageInput = document.getElementById('message-input');
    const contextMenu = document.getElementById('context-menu');
    const copyMessageButton = document.getElementById('copy-message');
    const settingsButton = document.getElementById('settings-button');
    const settingsMenu = document.getElementById('settings-menu');
    const toggleTheme = document.getElementById('toggle-theme');
    let currentMessageElement = null;

    // 聊天历史记录变量
    let chatHistory = [];

    // 添加公共的图片处理函数
    function processImageTags(content) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = content;
        const imageTags = tempDiv.querySelectorAll('.image-tag');

        if (imageTags.length > 0) {
            const result = [];
            // 添加文本内容
            const textContent = content.replace(/<span class="image-tag"[^>]*>.*?<\/span>/g, '').trim();
            if (textContent) {
                result.push({
                    type: "text",
                    text: textContent
                });
            }
            // 添加图片
            imageTags.forEach(tag => {
                const base64Data = tag.getAttribute('data-image');
                if (base64Data) {
                    result.push({
                        type: "image_url",
                        image_url: {
                            url: base64Data
                        }
                    });
                }
            });
            return result;
        }
        return content;
    }

    // 修改 processMessageContent 函数
    function processMessageContent(msg) {
        if (typeof msg.content === 'string' && msg.content.includes('image-tag')) {
            return {
                ...msg,
                content: processImageTags(msg.content)
            };
        }
        return msg;
    }

    // 修改保存聊天历史记录的函数
    async function saveChatHistory() {
        try {
            // 在保存之前处理消息格式
            const processedHistory = chatHistory.map(processMessageContent);
            await chrome.storage.local.set({ chatHistory: processedHistory });
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

    // 修改加载历史记录的函数
    async function loadChatHistory() {
        try {
            const result = await chrome.storage.local.get('chatHistory');
            if (result.chatHistory) {
                // 处理历史记录中的消息格式
                chatHistory = result.chatHistory.map(processMessageContent);

                // 清空当前显示的消息
                chatContainer.innerHTML = '';

                // 创建文档片段来提高性能
                const fragment = document.createDocumentFragment();

                // 重新显示历史消息
                chatHistory.forEach(msg => {
                    if (Array.isArray(msg.content)) {
                        // 处理包含图片的消息
                        let messageHtml = '';
                        msg.content.forEach(item => {
                            if (item.type === "text") {
                                messageHtml += item.text;
                            } else if (item.type === "image_url") {
                                const imageTag = createImageTag(item.image_url.url);
                                messageHtml += imageTag.outerHTML;
                            }
                        });
                        appendMessage(messageHtml, msg.role === 'user' ? 'user' : 'ai', true, fragment);
                    } else {
                        appendMessage(msg.content, msg.role === 'user' ? 'user' : 'ai', true, fragment);
                    }
                });

                // 一次性添加所有消息
                chatContainer.appendChild(fragment);

                // 使用 requestAnimationFrame 来延迟显示动画
                requestAnimationFrame(() => {
                    // 获取所有新添加的消息元素
                    const messages = chatContainer.querySelectorAll('.message.batch-load');

                    // 使用 requestAnimationFrame 来确保在下一帧开始时添加 show 类
                    requestAnimationFrame(() => {
                        messages.forEach((message, index) => {
                            // 使用 setTimeout 来创建级联动画效果
                            setTimeout(() => {
                                message.classList.add('show');
                            }, index * 30); // 每个消息间隔 30ms
                        });
                    });
                });
            }
        } catch (error) {
            console.error('加载聊天历史记录失败:', error);
        }
    }

    // 监听标签页切换
    chrome.tabs.onActivated.addListener(async (activeInfo) => {
        console.log('标签页切换:', activeInfo);
        await loadChatHistory();
        await loadWebpageSwitch('标签页切');
    });

    // 初始加载历史记录
    await loadChatHistory();


    // 网答功能
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

    // 修改 loadWebpageSwitch 函数
    async function loadWebpageSwitch(call_name = 'loadWebpageSwitch') {
        console.log(`loadWebpageSwitch 从 ${call_name} 调用`);

        try {
            const domain = await getCurrentDomain();
            console.log('刷新后 网页问答 获取当前域名:', domain);
            if (!domain) return;

            const result = await chrome.storage.local.get('webpageSwitchDomains');
            const domains = result.webpageSwitchDomains || {};
            console.log('刷新后 网页问答存储中获取域名:', domains);

            // 只在开关状态不一致时才更新
            if (domains[domain] !== webpageSwitch.checked) {
                webpageSwitch.checked = !!domains[domain];

                if (webpageSwitch.checked) {
                    document.body.classList.add('loading-content');

                    try {
                        const content = await getPageContent();
                        if (content) {
                            pageContent = content;
                        } else {
                            // 不再自动关闭开关，只显示提示消息
                            // appendMessage('无法获取网页内容', 'ai', true);
                            console.error('获取网页内容失败。');
                        }
                    } catch (error) {
                        console.error('获取网页内容失败:', error);
                        // 不再自动关闭开关，只显示提示消息
                        // appendMessage('获取网页内容失败', 'ai', true);
                    } finally {
                        document.body.classList.remove('loading-content');
                    }
                } else {
                    pageContent = null;
                }
            }
        } catch (error) {
            console.error('加载网页问答状态失败:', error);
        }
    }

    // 修改网页问答开关监听器
    webpageSwitch.addEventListener('change', async () => {
        try {
            const domain = await getCurrentDomain();
            console.log('网页问答开关状态改变后，获取当前域名:', domain);

            if (!domain) {
                console.log('无法获取域名，保持开关状态不变');
                webpageSwitch.checked = !webpageSwitch.checked; // 恢复开关状态
                return;
            }

            console.log('网页问答开关状态改变后，获取网页问答开关状态:', webpageSwitch.checked);

            if (webpageSwitch.checked) {
                document.body.classList.add('loading-content');

                try {
                    const content = await getPageContent();
                    if (content) {
                        pageContent = content;
                        await saveWebpageSwitch(domain, true);
                        console.log('修改网页问答为已开启');
                    } else {
                        // 不再自动关闭开关，只显示提示消息
                        // appendMessage('无法获取网页内容', 'ai', true);
                        console.error('获取网页内容失败。');
                    }
                } catch (error) {
                    console.error('获取网页内容失败:', error);
                    // 不再自动关闭开关，只显示提示消息
                    // appendMessage('获取网页内容失败', 'ai', true);
                } finally {
                    document.body.classList.remove('loading-content');
                }
            } else {
                pageContent = null;
                await saveWebpageSwitch(domain, false);
                console.log('修改网页问答为已关闭');
            }
        } catch (error) {
            console.error('处理网页问答开关变化失败:', error);
            webpageSwitch.checked = !webpageSwitch.checked; // 恢复开关状态
        }
    });
    // 在 DOMContentLoaded 事件处理程序中添加加载网页问答状态
    await loadWebpageSwitch();

    // 在文件开头添加函数用于获取当前域名
    async function getCurrentDomain(retryCount = 0) {
        const maxRetries = 3;
        const retryDelay = 500;

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.url) {
                console.log('未找到活动标签页');
                return null;
            }

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
            console.error(`获取当前域名失败 (尝试 ${retryCount + 1}/${maxRetries}):`, error);

            if (retryCount < maxRetries) {
                console.log(`等待 ${retryDelay}ms 后重试...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                return getCurrentDomain(retryCount + 1);
            }

            return null;
        }
    }

    async function sendMessage() {
        const message = messageInput.textContent.trim();
        const imageTags = messageInput.querySelectorAll('.image-tag');

        if (!message && imageTags.length === 0) return;

        const config = apiConfigs[selectedConfigIndex];
        if (!config?.baseUrl || !config?.apiKey) {
            appendMessage('请在设置中完善 API 配置', 'ai', true);
            return;
        }

        try {
            // 构建消息内容
            let content;
            const images = [];

            // 如果有图片，构建包含文本和图片的数组格式
            if (imageTags.length > 0) {
                content = [];
                // 添加文本内容（如果有）
                if (message) {
                    content.push({
                        type: "text",
                        text: message
                    });
                }
                // 添加图片
                imageTags.forEach(tag => {
                    const base64Data = tag.getAttribute('data-image');
                    if (base64Data) {
                        content.push({
                            type: "image_url",
                            image_url: {
                                url: base64Data
                            }
                        });
                    }
                });
            } else {
                // 如果没有文本，直接使用文本内容
                content = message;
            }

            // 构建用户消息
            const userMessage = {
                role: "user",
                content: content
            };

            // 先添加用户消息到界面和历史记录
            appendMessage(messageInput.innerHTML, 'user');
            messageInput.innerHTML = '';
            adjustTextareaHeight(messageInput);

            // 构建消息数组（不包括当前用户消息）
            const messages = [...chatHistory.slice(0, -1)];  // 排除刚刚添加的用户消息
            const systemMessage = {
                role: "system",
                content: `数学公式请使用LaTeX表示，行间公式请使用\\[...\\]表示，行内公式请使用\\(...\\)表示，禁止使用$美元符号包裹数学公式。用户语言是 ${navigator.language}。请优先使用 ${navigator.language} 语言回答用户问题。${
                    webpageSwitch.checked && pageContent ?
                    `\n当前网页内容：\n标题：${pageContent.title}\nURL：${pageContent.url}\n内容：${pageContent.content}` :
                    ''
                }`
            };

            // 如果是第一条消息或第一条不是系统消息，添加系统消息
            if (messages.length === 0 || messages[0].role !== "system") {
                messages.unshift(systemMessage);
            }

            // 发送API请求
            const response = await fetch(config.baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.apiKey}`
                },
                body: JSON.stringify({
                    model: config.modelName || "gpt-4o",
                    messages: [...messages, userMessage],
                    stream: true,
                    // max_tokens: 4096
                })
            });

            if (!response.ok) {
                const error = await response.text();
                throw new Error(error);
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
                        if (content.trim() === '[DONE]') continue;

                        try {
                            const data = JSON.parse(content);
                            if (data.choices?.[0]?.delta?.content) {
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
            appendMessage('发送失败: ' + error.message, 'ai', true);
            // 从 chatHistory 中移除最后一条记录（用户的问题）
            chatHistory.pop();
            saveChatHistory();
        }
    }

    // 提取公共的数学公式处理函数
    function processMathAndMarkdown(text) {
        const mathExpressions = [];
        let mathIndex = 0;
        text = text.replace(/\\\[([a-zA-Z\d]+)\]/g, '[$1]');

        // 临时替换数学公式
        text = text.replace(MATH_DELIMITERS.regex, (match) => {
            // 只替换不在 \n 后面的 abla_
            match = match.replace(/(?<!\\n)abla_/g, '\\nabla_');

            // 如果是普通括号形式公式，转换为 \(...\) 形式
            if (match.startsWith('(') && match.endsWith(')') && !match.startsWith('\\(')) {
                console.log('警告：请使用 \\(...\\) 来表示行内公式');
            }
            const placeholder = `%%MATH_EXPRESSION_${mathIndex}%%`;
            mathExpressions.push(match);
            mathIndex++;
            return placeholder;
        });

        // 配 marked
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

        text = text.replace(/:\s\*\*/g, ':**');

        // 渲染 Markdown
        let html = marked.parse(text);

        // 恢复数学公式
        html = html.replace(/%%MATH_EXPRESSION_(\d+)%%/g, (_, index) => mathExpressions[index]);

        return html;
    }

    // 监听来自 content script 的消息
    window.addEventListener('message', (event) => {
        if (event.data.type === 'DROP_IMAGE') {
            console.log('收到拖放图片数据');
            const imageData = event.data.imageData;
            if (imageData && imageData.data) {
                console.log('创建图片标签');
                const imageTag = createImageTag(imageData.data, imageData.name);

                // 确保输入框有焦点
                messageInput.focus();

                // 获取或创建选区
                const selection = window.getSelection();
                let range;

                // 检查是否有现有选区
                if (selection.rangeCount > 0) {
                    range = selection.getRangeAt(0);
                } else {
                    // 创建新的选区
                    range = document.createRange();
                    // 将选区设置到输入框的末尾
                    range.selectNodeContents(messageInput);
                    range.collapse(false);
                    selection.removeAllRanges();
                    selection.addRange(range);
                }

                console.log('插入图片标签到输入框');
                // 插入图片标签
                range.deleteContents();
                range.insertNode(imageTag);

                // 移动光标到图片标签后面
                const newRange = document.createRange();
                newRange.setStartAfter(imageTag);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);

                // 触发输入事件以调整高度
                messageInput.dispatchEvent(new Event('input'));
                console.log('图片插入完成');
            }
        } else if (event.data.type === 'FOCUS_INPUT') {
            messageInput.focus();
            const range = document.createRange();
            range.selectNodeContents(messageInput);
            range.collapse(false);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        } else if (event.data.type === 'URL_CHANGED') {
            console.log('[收到URL变化]', event.data.url);
            if (webpageSwitch.checked) {
                console.log('[网页问答] URL变化，重新获取页面内容');
                document.body.classList.add('loading-content');

                getPageContent()
                    .then(async content => {
                        if (content) {
                            pageContent = content;
                            const domain = await getCurrentDomain();
                            if (domain) {
                                await saveWebpageSwitch(domain, true);
                            }
                        } else {
                            webpageSwitch.checked = false;
                            const domain = await getCurrentDomain();
                            if (domain) {
                                await saveWebpageSwitch(domain, false);
                            }
                            appendMessage('无法获取网页内容', 'ai', true);
                        }
                    })
                    .catch(async error => {
                        console.error('获取网页内容失败:', error);
                        webpageSwitch.checked = false;
                        const domain = await getCurrentDomain();
                        if (domain) {
                            await saveWebpageSwitch(domain, false);
                        }
                        appendMessage('获取网页内容失败', 'ai', true);
                    })
                    .finally(() => {
                        document.body.classList.remove('loading-content');
                    });
            }
        } else if (event.data.type === 'UPDATE_PLACEHOLDER') {
            console.log('收到更新placeholder消息:', event.data);
            if (messageInput) {
                messageInput.setAttribute('placeholder', event.data.placeholder);
                if (event.data.timeout) {
                    setTimeout(() => {
                        messageInput.setAttribute('placeholder', '输入消息...');
                    }, event.data.timeout);
                }
            }
        } else if (event.data.type === 'QUICK_SUMMARY_COMMAND') {
            performQuickSummary();
        }
    });

    function updateAIMessage(text) {
        const lastMessage = chatContainer.querySelector('.ai-message:last-child');
        let rawText = text;

        if (lastMessage) {
            // 获取当前显示的文本
            const currentText = lastMessage.getAttribute('data-original-text') || '';
            // 如果新文本比当前文本长，说有新内容需要更新
            if (text.length > currentText.length) {
                // 更新原始文本属性
                lastMessage.setAttribute('data-original-text', text);

                // 处理数学公式和Markdown
                lastMessage.innerHTML = processMathAndMarkdown(text);

                // 处理新染的链接
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
    function appendMessage(text, sender, skipHistory = false, fragment = null) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}-message`;

        // 如果是批量加载，添加特殊类名
        if (fragment) {
            messageDiv.classList.add('batch-load');
        }

        // 存储原始文本用于复制
        messageDiv.setAttribute('data-original-text', text);

        // 处理数学公式和 Markdown
        messageDiv.innerHTML = processMathAndMarkdown(text);

        // 处理消息中的链接
        messageDiv.querySelectorAll('a').forEach(link => {
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
        });

        // 处理消息中的图片标签
        messageDiv.querySelectorAll('.image-tag').forEach(tag => {
            const img = tag.querySelector('img');
            const base64Data = tag.getAttribute('data-image');
            if (img && base64Data) {
                img.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    showImagePreview(base64Data);
                });
            }
        });

        // 渲染 LaTeX 公式
        renderMathInElement(messageDiv, MATH_DELIMITERS.renderConfig);

        // 如果提供了文档片段，添加到片段中；否则直接添加到聊天容器
        if (fragment) {
            fragment.appendChild(messageDiv);
        } else {
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
        }

        // 只有在不跳过历史记录时才添加到历史记录
        if (!skipHistory) {
            chatHistory.push({
                role: sender === 'user' ? 'user' : 'assistant',
                content: processImageTags(text)
            });
            saveChatHistory();
        }
    }

    // 自动调整文本框高度
    function adjustTextareaHeight(textarea) {
        textarea.style.height = 'auto';
        const maxHeight = 200;
        textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
        if (textarea.scrollHeight > maxHeight) {
            textarea.style.overflowY = 'auto';
        } else {
            textarea.style.overflowY = 'hidden';
        }
    }

    // 监听输入框变化
    messageInput.addEventListener('input', function() {
        adjustTextareaHeight(this);

        // 处理 placeholder 的显示
        if (this.textContent.trim() === '' && !this.querySelector('.image-tag')) {
            // 如果内容空且没有图片标签，清空内容以显示 placeholder
            while (this.firstChild) {
                this.removeChild(this.firstChild);
            }
        }

        // 移除不必要的 br 标签
        const brElements = this.getElementsByTagName('br');
        Array.from(brElements).forEach(br => {
            if (!br.nextSibling || (br.nextSibling.nodeType === Node.TEXT_NODE && br.nextSibling.textContent.trim() === '')) {
                br.remove();
            }
        });
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
            const text = this.textContent.trim();
            if (text || this.querySelector('.image-tag')) {  // 检查是否有文本或图片
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

    // 设置主题
    function setTheme(isDark) {
        // 获取根元素
        const root = document.documentElement;

        // 移除现有的主题类
        root.classList.remove('dark-theme', 'light-theme');

        // 添加新的主题类
        root.classList.add(isDark ? 'dark-theme' : 'light-theme');

        // 更新开关状态
        themeSwitch.checked = isDark;

        // 保存主题设置
        chrome.storage.sync.set({ theme: isDark ? 'dark' : 'light' });
    }

    // 初始化主题
    async function initTheme() {
        try {
            const result = await chrome.storage.sync.get('theme');
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            const isDark = result.theme === 'dark' || (!result.theme && prefersDark);
            setTheme(isDark);
        } catch (error) {
            console.error('初始化主题失败:', error);
            // 如果出错，使用系统主题
            setTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);
        }
    }

    // 监听主题切换
    themeSwitch.addEventListener('change', () => {
        setTheme(themeSwitch.checked);
    });

    // 监听系统主题变化
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        chrome.storage.sync.get('theme', (data) => {
            if (!data.theme) {  // 只有在用户没有手动设置主题时才跟随系统
                setTheme(e.matches);
            }
        });
    });

    // 初始化主题
    await initTheme();

    // 修改 saveWebpageSwitch 函数，改进存储和错误处理
    async function saveWebpageSwitch(domain, enabled) {
        console.log('开始保存网页问答开关状态:', domain, enabled);

        try {
            const result = await chrome.storage.local.get('webpageSwitchDomains');
            let domains = result.webpageSwitchDomains || {};

            // 只在状态发生变化时才更新
            if (domains[domain] !== enabled) {
                domains[domain] = enabled;
                await chrome.storage.local.set({ webpageSwitchDomains: domains });
                console.log('网页问答状态已保存:', domain, enabled);
            }
        } catch (error) {
            console.error('保存网页问答状态失败:', error, domain, enabled);
        }
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
        // 确保模板元素在
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

        // 止入框和按钮点击事件冒泡
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

        // 制配置
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
        // 闭设置菜单
        settingsMenu.classList.remove('visible');
        // 聚焦输入框并将光标移到末尾
        messageInput.focus();
        // 移动光标到末尾
        const range = document.createRange();
        range.selectNodeContents(messageInput);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    });

    // 快速总结的公共函数
    async function performQuickSummary() {
        // 清空聊天记录
        chatContainer.innerHTML = '';
        chatHistory = [];
        saveChatHistory();
        // 关闭设置菜单
        settingsMenu.classList.remove('visible');

        // 显示加载状态
        appendMessage('正在准备页面内容...', 'ai', true);

        // 如果网页问答没有开启，先开启它
        if (!webpageSwitch.checked) {
            webpageSwitch.checked = true;
            const domain = await getCurrentDomain();
            if (domain) {
                await saveWebpageSwitch(domain, true);
            }
        }

        // 获取页面内容
        const content = await getPageContent();
        if (!content) {
            appendMessage('获取页面内容失败', 'ai', true);
            return;
        }

        // 更新 pageContent
        pageContent = content;

        // 移除加载状态消息
        chatContainer.innerHTML = '';
        chatHistory = [];

        // 构建总结请求
        messageInput.textContent = `请总结这个页面的主要内容。`;
        // 直接发送消息
        sendMessage();
    }

    // 快速总结功能
    const quickSummary = document.getElementById('quick-summary');
    quickSummary.addEventListener('click', () => performQuickSummary());

    // 添加点击事件监听
    chatContainer.addEventListener('click', () => {
        // 击聊天区域时让输入框失去焦点
        messageInput.blur();
    });

    // 监听输入框的焦点状态
    messageInput.addEventListener('focus', () => {
        // 输入框获得焦点，阻止事件冒泡
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

        // 确保菜单不超出视口
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

    // 点击制按钮
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

    // 片粘贴功能
    messageInput.addEventListener('paste', async (e) => {
        e.preventDefault(); // 阻止默认粘贴行为

        const items = Array.from(e.clipboardData.items);
        const imageItem = items.find(item => item.type.startsWith('image/'));

        if (imageItem) {
            // 处理图片粘贴
            const file = imageItem.getAsFile();
            const reader = new FileReader();

            reader.onload = async () => {
                const base64Data = reader.result;
                const imageTag = createImageTag(base64Data, file.name);

                // 在光标位置插入图片标签
                const selection = window.getSelection();
                const range = selection.getRangeAt(0);
                range.deleteContents();
                range.insertNode(imageTag);

                // 移动光标到图片标签后面，并确保不会插入额外的换行
                const newRange = document.createRange();
                newRange.setStartAfter(imageTag);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);

                // 移除可能存在的多余行
                const brElements = messageInput.getElementsByTagName('br');
                Array.from(brElements).forEach(br => {
                    if (br.previousSibling && br.previousSibling.classList && br.previousSibling.classList.contains('image-tag')) {
                        br.remove();
                    }
                });

                // 触发输入事件以调整高度
                messageInput.dispatchEvent(new Event('input'));
            };

            reader.readAsDataURL(file);
        } else {
            // 处理文本粘贴
            const text = e.clipboardData.getData('text/plain');
            document.execCommand('insertText', false, text);
        }
    });

    // 处理图片标签的删除
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' || e.key === 'Delete') {
            const selection = window.getSelection();
            const range = selection.getRangeAt(0);
            const startContainer = range.startContainer;

            // 检查是否在图片标签旁边
            if (startContainer.nodeType === Node.TEXT_NODE && startContainer.textContent === '') {
                const previousSibling = startContainer.previousSibling;
                if (previousSibling && previousSibling.classList?.contains('image-tag')) {
                    e.preventDefault();
                    previousSibling.remove();

                    // 移除可能存在的多余换行
                    const brElements = messageInput.getElementsByTagName('br');
                    Array.from(brElements).forEach(br => {
                        if (!br.nextSibling || (br.nextSibling.nodeType === Node.TEXT_NODE && br.nextSibling.textContent.trim() === '')) {
                            br.remove();
                        }
                    });

                    // 触发输入事件以调整高度
                    messageInput.dispatchEvent(new Event('input'));
                }
            }
        }
    });

    // 创建图片标签
    function createImageTag(base64Data, fileName) {
        const container = document.createElement('span');
        container.className = 'image-tag';
        container.contentEditable = false;
        container.setAttribute('data-image', base64Data);
        container.title = fileName || '图片'; // 添加悬停提示

        const thumbnail = document.createElement('img');
        thumbnail.src = base64Data;
        thumbnail.alt = fileName || '图片';

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-btn';
        deleteBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-linecap="round"/></svg>';
        deleteBtn.title = '删除图片';

        // 点击删除按钮时除整个标签
        deleteBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            container.remove();
            // 发输入事件以调整高度
            messageInput.dispatchEvent(new Event('input'));
        });

        container.appendChild(thumbnail);
        container.appendChild(deleteBtn);

        // 点击图片区域预览图片
        thumbnail.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showImagePreview(base64Data);
        });

        return container;
    }

    // 图片预览功能
    const previewModal = document.querySelector('.image-preview-modal');
    const previewImage = previewModal.querySelector('img');
    const closeButton = previewModal.querySelector('.image-preview-close');

    function showImagePreview(base64Data) {
        previewImage.src = base64Data;
        previewModal.classList.add('visible');
    }

    function hideImagePreview() {
        previewModal.classList.remove('visible');
        previewImage.src = '';
    }

    closeButton.addEventListener('click', hideImagePreview);
    previewModal.addEventListener('click', (e) => {
        if (e.target === previewModal) {
            hideImagePreview();
        }
    });

    // 创建公共的图片处理函数
    function handleImageDrop(e, target) {
        e.preventDefault();
        e.stopPropagation();

        try {
            // 处理文件拖放
            if (e.dataTransfer.files.length > 0) {
                const file = e.dataTransfer.files[0];
                if (file.type.startsWith('image/')) {
                    const reader = new FileReader();
                    reader.onload = () => {
                        const base64Data = reader.result;
                        const imageTag = createImageTag(base64Data, file.name);

                        // 确保输入框有焦点
                        messageInput.focus();

                        // 获取或创建选区
                        const selection = window.getSelection();
                        let range;

                        // 检查是否有现有选区
                        if (selection.rangeCount > 0) {
                            range = selection.getRangeAt(0);
                        } else {
                            // 创建新的选区
                            range = document.createRange();
                            // 将选区设置到输入框的末尾
                            range.selectNodeContents(messageInput);
                            range.collapse(false);
                            selection.removeAllRanges();
                            selection.addRange(range);
                        }

                        // 插入图片标签
                        range.deleteContents();
                        range.insertNode(imageTag);

                        // 移动光标到图片标签后面
                        const newRange = document.createRange();
                        newRange.setStartAfter(imageTag);
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);

                        // 触发输入事件以调整高度
                        messageInput.dispatchEvent(new Event('input'));
                    };
                    reader.readAsDataURL(file);
                    return;
                }
            }

            // 处理网页图片拖放
            const data = e.dataTransfer.getData('text/plain');
            if (data) {
                try {
                    const imageData = JSON.parse(data);
                    if (imageData.type === 'image') {
                        const imageTag = createImageTag(imageData.data, imageData.name);

                        // 确保输入框有焦点
                        messageInput.focus();

                        // 获取或创建选区
                        const selection = window.getSelection();
                        let range;

                        // 检查是否有现有选区
                        if (selection.rangeCount > 0) {
                            range = selection.getRangeAt(0);
                        } else {
                            // 创建新的选区
                            range = document.createRange();
                            // 将选区设置到输入框的末尾
                            range.selectNodeContents(messageInput);
                            range.collapse(false);
                            selection.removeAllRanges();
                            selection.addRange(range);
                        }

                        // 插入图片标签
                        range.deleteContents();
                        range.insertNode(imageTag);

                        // 移动光标到图片标签后面
                        const newRange = document.createRange();
                        newRange.setStartAfter(imageTag);
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);

                        // 触发输入事件以调整高度
                        messageInput.dispatchEvent(new Event('input'));
                    }
                } catch (error) {
                    console.error('处理拖放数据失败:', error);
                }
            }
        } catch (error) {
            console.error('处理拖放事件失败:', error);
        }
    }

    // 为输入框添加拖放事件监听器
    messageInput.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    messageInput.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    messageInput.addEventListener('drop', (e) => handleImageDrop(e, messageInput));

    // 为聊天区域添加拖放事件监听器
    chatContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    chatContainer.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    chatContainer.addEventListener('drop', (e) => handleImageDrop(e, chatContainer));

    // 阻止聊天区域的图片默认行为
    chatContainer.addEventListener('click', (e) => {
        if (e.target.tagName === 'IMG') {
            e.preventDefault();
            e.stopPropagation();
        }
    });
});