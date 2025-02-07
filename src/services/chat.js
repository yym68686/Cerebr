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
 * @returns {Promise<{processStream: (onUpdate: (text: string) => void) => Promise<string>, controller: AbortController}>}
 */
export async function callAPI({
    messages,
    apiConfig,
    userLanguage,
    webpageInfo = null,
}) {
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
    const processedMessages = [...messages];
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
    let aiResponse = '';
    let updateLock = Promise.resolve(); // 添加更新锁
    let updateFailed = false; // 添加更新失败标记

    const processStream = async (onUpdate) => {
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
                            // 使用更新锁确保顺序执行
                            updateLock = updateLock.then(async () => {
                                const success = await onUpdate(aiResponse);
                                if (!success && !updateFailed) {
                                    updateFailed = true;
                                    // 如果更新失败，需要重新创建一个AI消息
                                    await onUpdate(aiResponse, true);
                                }
                            });
                        }
                    } catch (e) {
                        console.error('解析响应出错:', e);
                    }
                }
            }
        }
        // 等待所有更新完成
        await updateLock;
        return aiResponse;
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