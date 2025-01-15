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

        // 获取当前显示的消息数量
        const currentMessages = chatContainer.querySelectorAll('.message');
        const currentCount = currentMessages.length;

        // 创建文档片段来提高性能
        const fragment = document.createDocumentFragment();

        // 辅助函数：将消息添加到文档片段
        function appendMessageToFragment(msg) {
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
        }

        // 辅助函数：获取消息内容
        function getMessageContent(msg) {
            if (Array.isArray(msg.content)) {
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
                return messageHtml;
            }
            return msg.content;
        }

        if (currentCount === 0) {
            // 如果当前没有消息，则加载所有历史消息
            chatHistory.forEach(msg => appendMessageToFragment(msg));
        } else if (currentCount === chatHistory.length) {
            // 如果消息数量相同，只更新最后一条消息（可能是正在生成的AI消息）
            const lastMsg = chatHistory[chatHistory.length - 1];
            const lastDisplayedMsg = currentMessages[currentCount - 1];

            // 检查是否是正在更新的AI消息
            if (lastDisplayedMsg.classList.contains('updating')) {
                lastDisplayedMsg.remove();
                appendMessageToFragment(lastMsg);
            } else {
                // 如果最后一条消息的内容不同，则更新它
                const displayedContent = lastDisplayedMsg.getAttribute('data-original-text') || '';
                if (getMessageContent(lastMsg) !== displayedContent) {
                    lastDisplayedMsg.remove();
                    appendMessageToFragment(lastMsg);
                }
            }
        } else if (currentCount < chatHistory.length) {
            // 如果有新消息，只添加缺失的消息
            for (let i = currentCount; i < chatHistory.length; i++) {
                appendMessageToFragment(chatHistory[i]);
            }
        }

        // 如果有新内容要添加，则添加到容器中
        if (fragment.children.length > 0) {
            chatContainer.appendChild(fragment);
            // 直接显示所有消息，不使用动画
            const messages = chatContainer.querySelectorAll('.message.batch-load');
            messages.forEach(message => {
                message.classList.add('show');
            });
        }

        return chatHistory;
    } catch (error) {
        console.error('加载聊天历史记录失败:', error);
        return [];
    }
}