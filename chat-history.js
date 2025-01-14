// 纯函数版本的 loadChatHistory
export async function loadChatHistory({
    chatContainer,
    processMessageContent,
    processImageTags,
    createImageTag,
    appendMessage,
    messageHandlerConfig,
    uiConfig,
    getChatHistory,
}) {
    try {
        const rawHistory = await getChatHistory();
        const chatHistory = rawHistory.map(msg => processMessageContent(msg, processImageTags));

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
                        const imageTag = createImageTag({
                            base64Data: item.image_url.url,
                            config: uiConfig.imageTag
                        });
                        messageHtml += imageTag.outerHTML;
                    }
                });
                appendMessage({
                    text: messageHtml,
                    sender: msg.role === 'user' ? 'user' : 'ai',
                    chatContainer,
                    skipHistory: true,
                    fragment,
                    config: messageHandlerConfig
                });
            } else {
                appendMessage({
                    text: msg.content,
                    sender: msg.role === 'user' ? 'user' : 'ai',
                    chatContainer,
                    skipHistory: true,
                    fragment,
                    config: messageHandlerConfig
                });
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

        return chatHistory;
    } catch (error) {
        console.error('加载聊天历史记录失败:', error);
        return [];
    }
}