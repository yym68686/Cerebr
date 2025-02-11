/**
 * API配置接口
 * @typedef {Object} APIConfig
 * @property {string} baseUrl - API的基础URL
 * @property {string} apiKey - API密钥
 * @property {string} [modelName] - 模型名称，默认为 "gpt-4o"
 */

/**
 * 网页信息接口
 * @typedef {Object} WebpageInfo
 * @property {string} title - 网页标题
 * @property {string} url - 网页URL
 * @property {string} content - 网页内容
 */

/**
 * 消息接口
 * @typedef {Object} Message
 * @property {string} role - 消息角色 ("system" | "user" | "assistant")
 * @property {string | Array<{type: string, text?: string, image_url?: {url: string}}>} content - 消息内容
 */

/**
 * API调用参数接口
 * @typedef {Object} APIParams
 * @property {Array<Message>} messages - 消息历史
 * @property {APIConfig} apiConfig - API配置
 * @property {string} userLanguage - 用户语言
 * @property {WebpageInfo} [webpageInfo] - 网页信息（可选）
 */

/**
 * 调用API发送消息并处理响应
 * @param {APIParams} params - API调用参数
 * @param {Object} chatManager - 聊天管理器实例
 * @param {string} chatId - 当前聊天ID
 * @param {Function} onMessageUpdate - 消息更新回调函数
 * @returns {Promise<{processStream: () => Promise<{content: string, reasoning_content: string}>, controller: AbortController}>}
 */
export async function callAPI({
    messages,
    apiConfig,
    userLanguage,
    webpageInfo = null,
}, chatManager, chatId, onMessageUpdate) {
    if (!apiConfig?.baseUrl || !apiConfig?.apiKey) {
        throw new Error('API 配置不完整');
    }

    // 构建系统消息
    let systemPrompt = apiConfig.advancedSettings?.systemPrompt || '';
    systemPrompt = systemPrompt.replace(/\{\{userLanguage\}\}/gm, userLanguage)

    const systemMessage = {
        role: "system",
        content: `${systemPrompt}${
            webpageInfo ?
            `\n当前网页内容：\n标题：${webpageInfo.title}\nURL：${webpageInfo.url}\n内容：${webpageInfo.content}` :
            ''
        }`
    };

    // 确保消息数组中有系统消息
    // 删除消息列表中的reasoning_content字段
    const processedMessages = messages.map(msg => {
        const { reasoning_content, ...rest } = msg;
        return rest;
    });

    if (systemMessage.content.trim() && (processedMessages.length === 0 || processedMessages[0].role !== "system")) {
        processedMessages.unshift(systemMessage);
    }

    const controller = new AbortController();
    const signal = controller.signal;

    const response = await fetch(apiConfig.baseUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiConfig.apiKey}`
        },
        body: JSON.stringify({
            model: apiConfig.modelName || "gpt-4o",
            messages: processedMessages,
            stream: true,
        }),
        signal
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(error);
    }

    // 处理流式响应
    const reader = response.body.getReader();

    const processStream = async () => {
        try {
            let buffer = '';
            let currentMessage = {
                content: '',
                reasoning_content: ''
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = new TextDecoder().decode(value);
                buffer += chunk;

                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, newlineIndex);
                    buffer = buffer.slice(newlineIndex + 1);

                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') {
                            chatManager.reciveMessageFinish(chatId);
                            continue;
                        }

                        try {
                            const delta = JSON.parse(data).choices[0]?.delta;
                            if (delta?.content) {
                                currentMessage.content += delta.content;
                            }
                            if (delta?.reasoning_content) {
                                currentMessage.reasoning_content += delta.reasoning_content;
                            }

                            // 直接更新 chatManager
                            if (chatManager && chatId && (delta?.content || delta?.reasoning_content)) {
                                // console.log('callAPI', chatId);
                                chatManager.updateLastMessage(chatId, currentMessage);
                                // 通知消息更新
                                onMessageUpdate(chatId, currentMessage);
                            }
                        } catch (e) {
                            console.error('解析数据时出错:', e);
                        }
                    }
                }
            }

            return currentMessage;
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error('请求被取消');
            }
            throw error;
        }
    };

    return {
        processStream,
        controller
    };
}

/**
 * 图片标签接口
 * @typedef {Object} ImageTag
 * @property {string} type - 内容类型 ("text" | "image_url")
 * @property {string} [text] - 文本内容
 * @property {Object} [image_url] - 图片URL对象
 * @property {string} image_url.url - 图片的base64数据
 */

/**
 * 处理HTML内容中的图片标签
 * @param {string} content - 包含图片标签的HTML内容
 * @param {Object} options - 配置选项
 * @param {string} options.imageTagClass - 图片标签的CSS类名
 * @param {string} options.imageDataAttribute - 图片数据的属性名
 * @returns {string | Array<ImageTag>} - 如果包含图片标签则返回数组，否则返回原始内容
 */
export function processImageTags(content, { imageTagClass = 'image-tag', imageDataAttribute = 'data-image' } = {}) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = content;
    const imageTags = tempDiv.querySelectorAll(`.${imageTagClass}`);

    if (imageTags.length > 0) {
        const result = [];
        // 添加文本内容
        const textContent = content.replace(new RegExp(`<span class="${imageTagClass}"[^>]*>.*?<\/span>`, 'g'), '').trim();
        if (textContent) {
            result.push({
                type: "text",
                text: textContent
            });
        }
        // 添加图片
        imageTags.forEach(tag => {
            const base64Data = tag.getAttribute(imageDataAttribute);
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