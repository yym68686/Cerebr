/**
 * API配置接口
 * @typedef {Object} APIConfig
 * @property {string} baseUrl - API的基础URL
 * @property {string} apiKey - API密钥
 * @property {string} [modelName] - 模型名称，默认为 "gpt-4o"
 */

import { normalizeChatCompletionsUrl } from '../utils/api-url.js';
import { t } from '../utils/i18n.js';
import { normalizeMessageForChatCompletions } from '../utils/message-content.js';

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
 * @param {{detectMisfiledThinkSilently?: boolean, misfiledThinkSilentlyPrefix?: string, misfiledThinkSilentlyPrefixes?: string[]}} [options] - 可选项
 * @returns {Promise<{processStream: () => Promise<{content: string, reasoning_content: string}>, controller: AbortController}>}
 */
export async function callAPI({
    messages,
    apiConfig,
    userLanguage,
    webpageInfo = null,
}, chatManager, chatId, onMessageUpdate, options = {}) {
    const baseUrl = normalizeChatCompletionsUrl(apiConfig?.baseUrl);
    if (!baseUrl || !apiConfig?.apiKey) {
        throw new Error(t('error_api_config_incomplete'));
    }

    // 构建系统消息
    let systemPrompt = apiConfig.advancedSettings?.systemPrompt || '';
    systemPrompt = systemPrompt.replace(/\{\{userLanguage\}\}/gm, userLanguage)

    const systemMessage = {
        role: "system",
        content: `${systemPrompt}${
            (webpageInfo && webpageInfo.pages) ?
            webpageInfo.pages.map(page => {
                const prefix = page.isCurrent ? t('webpage_prefix_current') : t('webpage_prefix_other');
                const titleLabel = t('webpage_title_label');
                const urlLabel = t('webpage_url_label');
                const contentLabel = t('webpage_content_label');
                return `\n${prefix}:\n${titleLabel}: ${page.title}\n${urlLabel}: ${page.url}\n${contentLabel}: ${page.content}`;
            }).join('\n\n---\n') :
            ''
        }`
    };

    // 确保消息数组中有系统消息
    // 删除消息列表中的reasoning_content字段
    const processedMessages = messages.map((msg) => {
        const { reasoning_content, updating, ...rest } = msg;
        return normalizeMessageForChatCompletions(rest);
    });

    if (systemMessage.content.trim() && (processedMessages.length === 0 || processedMessages[0].role !== "system")) {
        processedMessages.unshift(systemMessage);
    }

    // 注意：为了支持“首 token 前”也能立即停止更新，我们需要尽早把 controller 暴露出去。
    // 因此 fetch 的执行被延后到 processStream 内部。
    const controller = new AbortController();
    const signal = controller.signal;

    const requestInit = {
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
    };

    const processStream = async () => {
        let reader;
        try {
            const response = await fetch(baseUrl, requestInit);

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                throw new Error(errorText || response.statusText || `HTTP ${response.status}`);
            }

            // 处理流式响应
            reader = response.body?.getReader?.();
            if (!reader) {
                throw new Error(t('error_response_unreadable'));
            }

            let buffer = '';
            let currentMessage = {
                content: '',
                reasoning_content: ''
            };
            let lastUpdateTime = 0;
            let updateTimeout = null;
            const UPDATE_INTERVAL = 100; // 每100ms更新一次
            const detectMisfiledThinkSilently = !!options?.detectMisfiledThinkSilently;
            const misfiledThinkSilentlyPrefixesRaw = options?.misfiledThinkSilentlyPrefixes;
            const misfiledThinkSilentlyPrefixes = Array.from(new Set(
                (Array.isArray(misfiledThinkSilentlyPrefixesRaw) && misfiledThinkSilentlyPrefixesRaw.length
                    ? misfiledThinkSilentlyPrefixesRaw
                    : [options?.misfiledThinkSilentlyPrefix ?? 'think']
                )
                    .map((p) => String(p ?? '').trim().toLowerCase())
                    .filter(Boolean)
            ));
            let didDispatchAnyUpdate = false;

            const dispatchUpdate = () => {
                if (chatManager && chatId) {
                    // 创建一个副本以避免回调函数意外修改
                    const messageCopy = { ...currentMessage };
                    chatManager.updateLastMessage(chatId, messageCopy);
                    onMessageUpdate(chatId, messageCopy);
                    lastUpdateTime = Date.now();
                    didDispatchAnyUpdate = true;
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
                                if (detectMisfiledThinkSilently && !didDispatchAnyUpdate && !currentMessage.reasoning_content) {
                                    const contentStart = String(currentMessage.content || '').trimStart().toLowerCase();
                                    if (misfiledThinkSilentlyPrefixes.some((p) => contentStart.startsWith(p))) {
                                        const error = new Error('Detected misfiled reasoning content in content field');
                                        error.code = 'CEREBR_MISFILED_THINK_SILENTLY';
                                        throw error;
                                    }

                                    // 首次分发前：若 content 仍可能是前缀的一部分（例如只收到 "t"/"thi"），先不更新 UI/历史
                                    if (misfiledThinkSilentlyPrefixes.some((p) => p.startsWith(contentStart))) {
                                        continue;
                                    }
                                }

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
                            if (e?.code === 'CEREBR_MISFILED_THINK_SILENTLY') {
                                throw e;
                            }
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
        } finally {
            try {
                await reader?.cancel?.();
            } catch {
                // ignore
            }
        }
    };

    return {
        processStream,
        controller
    };
}
