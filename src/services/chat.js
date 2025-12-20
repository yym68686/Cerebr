/**
 * API配置接口
 * @typedef {Object} APIConfig
 * @property {string} baseUrl - API的基础URL
 * @property {string} apiKey - API密钥
 * @property {string} [modelName] - 模型名称，默认为 "gpt-4o"
 */

import { normalizeChatCompletionsUrl } from '../utils/api-url.js';

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
    const baseUrl = normalizeChatCompletionsUrl(apiConfig?.baseUrl);
    if (!baseUrl || !apiConfig?.apiKey) {
        throw new Error('API 配置不完整');
    }

    // 构建系统消息
    let systemPrompt = apiConfig.advancedSettings?.systemPrompt || '';
    systemPrompt = systemPrompt.replace(/\{\{userLanguage\}\}/gm, userLanguage)

    const systemMessage = {
        role: "system",
        content: `${systemPrompt}${
            (webpageInfo && webpageInfo.pages) ?
            webpageInfo.pages.map(page => {
                const prefix = page.isCurrent ? '当前网页内容' : '其他打开的网页';
                return `\n${prefix}：\n标题：${page.title}\nURL：${page.url}\n内容：${page.content}`;
            }).join('\n\n---\n') :
            ''
        }`
    };

    // 确保消息数组中有系统消息
    // 删除消息列表中的reasoning_content字段
    const processedMessages = messages.map(msg => {
        const { reasoning_content, updating, ...rest } = msg;
        return rest;
    });

    if (systemMessage.content.trim() && (processedMessages.length === 0 || processedMessages[0].role !== "system")) {
        processedMessages.unshift(systemMessage);
    }

    const controller = new AbortController();
    const signal = controller.signal;

    const response = await fetch(baseUrl, {
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
            let lastUpdateTime = 0;
            let updateTimeout = null;
            const UPDATE_INTERVAL = 100; // 每100ms更新一次

            const dispatchUpdate = () => {
                if (chatManager && chatId) {
                    // 创建一个副本以避免回调函数意外修改
                    const messageCopy = { ...currentMessage };
                    chatManager.updateLastMessage(chatId, messageCopy);
                    onMessageUpdate(chatId, messageCopy);
                    lastUpdateTime = Date.now();
                }
                if (updateTimeout) {
                    clearTimeout(updateTimeout);
                    updateTimeout = null;
                }
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                     // 确保最后的数据被发送
                    if (Date.now() - lastUpdateTime > 0) {
                        dispatchUpdate();
                    }
                    // console.log('[chat.js] processStream: 响应流结束');
                    break;
                }

                const chunk = new TextDecoder().decode(value);
                buffer += chunk;

                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, newlineIndex);
                    buffer = buffer.slice(newlineIndex + 1);

                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') {
                            continue;
                        }

                        try {
                            const delta = JSON.parse(data).choices[0]?.delta;
                            let hasUpdate = false;
                            if (delta?.content) {
                                currentMessage.content += delta.content;
                                hasUpdate = true;
                            }
                            if (delta?.reasoning_content) {
                                currentMessage.reasoning_content += delta.reasoning_content;
                                hasUpdate = true;
                            }

                            if (hasUpdate) {
                                if (!updateTimeout) {
                                     // 如果距离上次更新超过了间隔，则立即更新
                                    if (Date.now() - lastUpdateTime > UPDATE_INTERVAL) {
                                        dispatchUpdate();
                                    } else {
                                         // 否则，设置一个定时器，在间隔的剩余时间后更新
                                        updateTimeout = setTimeout(dispatchUpdate, UPDATE_INTERVAL - (Date.now() - lastUpdateTime));
                                    }
                                }
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
                return;
            }
            throw error;
        }
    };

    return {
        processStream,
        controller
    };
}
