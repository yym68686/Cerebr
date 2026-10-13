/**
 * API配置接口
 * @typedef {Object} APIConfig
 * @property {string} baseUrl - API的基础URL
 * @property {string} apiKey - API密钥
 * @property {string} [modelName] - 模型名称，默认为 "gpt-4o"
 * @property {{systemPrompt?: string, reasoningEffort?: string}} [advancedSettings] - 高级设置
 */

import { normalizeChatCompletionsUrl } from '../../utils/api-url.js';
import { t } from '../../utils/i18n.js';
import { normalizeMessageForChatCompletions } from '../../utils/message-content.js';
import { modelSupportsReasoningEffort, normalizeReasoningEffort } from '../../utils/reasoning-effort.js';
import { sortPromptFragments } from '../../plugin/core/prompt-fragment-utils.js';
import { createChatError } from './chat-errors.js';
import { expandMessagesForApi } from '../../mcp/mcp-messages.js';
import { readServerSentEvents } from '../../mcp/mcp-client.js';
import { isResponsesUrl, toResponsesBody, adaptResponsesResponse } from './responses-adapter.js';
import { applyAssistantMessageSettings } from './assistant-settings.js';

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
 * @property {Array<{pluginId: string, placement: string, content: string}>} [promptFragments] - 插件注入的提示片段
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
    promptFragments = [],
    tools = null,
    toolChoice = null,
    sendToolImages = true,
}, chatManager, chatId, onMessageUpdate, options = {}) {
    const baseUrl = normalizeChatCompletionsUrl(apiConfig?.baseUrl);
    if (!baseUrl || !apiConfig?.apiKey) {
        throw new Error(t('error_api_config_incomplete'));
    }

    // 构建系统消息
    let systemPrompt = apiConfig.advancedSettings?.systemPrompt || '';
    systemPrompt = systemPrompt.replace(/\{\{userLanguage\}\}/gm, userLanguage);

    const prependPromptFragments = [];
    const appendPromptFragments = [];

    sortPromptFragments(Array.isArray(promptFragments) ? promptFragments : []).forEach((fragment) => {
        const content = String(fragment?.content || '').trim();
        if (!content) return;

        if (fragment?.placement === 'system.prepend') {
            prependPromptFragments.push(content);
            return;
        }

        appendPromptFragments.push(content);
    });

    if (prependPromptFragments.length > 0) {
        systemPrompt = `${prependPromptFragments.join('\n\n')}${systemPrompt ? '\n\n' : ''}${systemPrompt}`;
    }
    if (appendPromptFragments.length > 0) {
        systemPrompt = `${systemPrompt}${systemPrompt ? '\n\n' : ''}${appendPromptFragments.join('\n\n')}`;
    }

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
    // 删除消息列表中的reasoning_content字段；带 MCP 工具调用的助手消息展开为 tool_calls / tool 消息
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const configuredMessages = applyAssistantMessageSettings(messages, apiConfig.advancedSettings);
    const allowedToolNames = new Set((tools || []).map(tool => tool.function?.name).filter(Boolean));
    const processedMessages = expandMessagesForApi(configuredMessages, { withTools: hasTools, sendToolImages, allowedToolNames })
        .map((msg) => {
            if (msg?.role === 'tool') {
                return { role: 'tool', tool_call_id: msg.tool_call_id, content: String(msg.content ?? '') };
            }
            if (msg?.role === 'assistant' && Array.isArray(msg.tool_calls)) {
                const assistantTurn = { role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls };
                if (msg.reasoning_details) assistantTurn.reasoning_details = msg.reasoning_details;
                if (msg.reasoning_items) assistantTurn.reasoning_items = msg.reasoning_items;
                return assistantTurn;
            }
            return normalizeMessageForChatCompletions({
                role: msg?.role,
                content: msg?.content
            });
        })
        .filter((msg) => msg?.role && typeof msg?.content !== 'undefined');

    if (systemMessage.content.trim() && (processedMessages.length === 0 || processedMessages[0].role !== "system")) {
        processedMessages.unshift(systemMessage);
    }

    // 注意：为了支持“首 token 前”也能立即停止更新，我们需要尽早把 controller 暴露出去。
    // 因此 fetch 的执行被延后到 processStream 内部。
    const controller = new AbortController();
    const signal = controller.signal;

    const modelName = apiConfig.modelName || 'gpt-4o';
    let requestBody = {
        model: modelName,
        messages: processedMessages,
        stream: true,
    };
    const reasoningEffort = normalizeReasoningEffort(apiConfig.advancedSettings?.reasoningEffort);
    if (modelSupportsReasoningEffort(modelName) && reasoningEffort !== 'off') {
        requestBody.reasoning = {
            effort: reasoningEffort,
            summary: 'auto',
        };
    }
    if (hasTools) {
        requestBody.tools = tools;
        if (toolChoice) {
            requestBody.tool_choice = toolChoice;
        }
    }
    for (const [setting, field] of [['temperature', 'temperature'], ['topP', 'top_p'], ['maxTokens', 'max_tokens']]) {
        const value = apiConfig.advancedSettings?.[setting];
        if (typeof value === 'number' && Number.isFinite(value)) requestBody[field] = value;
    }

    let requestInit = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiConfig.apiKey}`
        },
        signal
    };

    const lifecycle = options?.lifecycle && typeof options.lifecycle === 'object'
        ? options.lifecycle
        : null;

    const processStream = async () => {
        let reader;
        let resolvedUrl = baseUrl;
        try {
            if (typeof lifecycle?.beforeRequest === 'function') {
                const nextDescriptor = await lifecycle.beforeRequest({
                    url: resolvedUrl,
                    requestBody: {
                        ...requestBody,
                        messages: Array.isArray(requestBody.messages) ? [...requestBody.messages] : [],
                    },
                    requestInit: {
                        ...requestInit,
                        headers: {
                            ...(requestInit.headers || {}),
                        },
                    },
                });

                if (nextDescriptor && typeof nextDescriptor === 'object') {
                    if (typeof nextDescriptor.url === 'string' && nextDescriptor.url.trim()) {
                        resolvedUrl = nextDescriptor.url;
                    }
                    if (nextDescriptor.requestBody && typeof nextDescriptor.requestBody === 'object') {
                        requestBody = nextDescriptor.requestBody;
                    }
                    if (nextDescriptor.requestInit && typeof nextDescriptor.requestInit === 'object') {
                        requestInit = {
                            ...requestInit,
                            ...nextDescriptor.requestInit,
                            headers: {
                                ...(requestInit.headers || {}),
                                ...(nextDescriptor.requestInit.headers || {}),
                            },
                        };
                    }
                }
            }

            requestInit = {
                ...requestInit,
                body: JSON.stringify(isResponsesUrl(resolvedUrl) ? toResponsesBody(requestBody) : requestBody),
                signal,
            };

            const response = await fetch(resolvedUrl, requestInit);

            if (typeof lifecycle?.onResponse === 'function') {
                await lifecycle.onResponse({
                    response,
                    url: resolvedUrl,
                    requestBody,
                    requestInit,
                });
            }

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                throw createChatError(
                    'HTTP_ERROR',
                    errorText || response.statusText || `HTTP ${response.status}`,
                    {
                        status: response.status,
                        statusText: response.statusText,
                        url: resolvedUrl,
                    }
                );
            }

            // 处理流式响应
            const streamResponse = isResponsesUrl(resolvedUrl) ? adaptResponsesResponse(response) : response;
            if (!streamResponse.body?.getReader) {
                throw createChatError(
                    'RESPONSE_UNREADABLE',
                    t('error_response_unreadable'),
                    {
                        url: resolvedUrl,
                    }
                );
            }

            const baseMessage = options?.baseMessage && typeof options.baseMessage === 'object'
                ? options.baseMessage
                : null;
            let currentMessage = {
                content: baseMessage?.content || '',
                reasoning_content: baseMessage?.reasoning_content || ''
            };
            if (Array.isArray(baseMessage?.toolCalls)) {
                currentMessage.toolCalls = baseMessage.toolCalls;
            }
            const toolCallSlots = [];
            const reasoningDetails = [];
            const reasoningItems = [];
            let finishReason = null;
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
                    chatManager.updateLastMessage(chatId, messageCopy, { throttleMs: 750 });
                    onMessageUpdate(chatId, messageCopy);
                    lastUpdateTime = Date.now();
                    didDispatchAnyUpdate = true;
                }
                if (updateTimeout) {
                    clearTimeout(updateTimeout);
                    updateTimeout = null;
                }
            };

            for await (const event of readServerSentEvents(streamResponse)) {
                const data = event.data;
                if (!data || data === '[DONE]') continue;

                        try {
                            const parsedChunk = JSON.parse(data);
                            if (parsedChunk?.error) {
                                throw createChatError('API_STREAM_ERROR', parsedChunk.error.message || '模型返回流式错误', { url: resolvedUrl });
                            }
                            const choice = Array.isArray(parsedChunk?.choices) ? parsedChunk.choices[0] : null;
                            const delta = choice?.delta;
                            let hasUpdate = false;

                            if (choice?.finish_reason) {
                                finishReason = choice.finish_reason;
                            }
                            if (Array.isArray(delta?.tool_calls)) {
                                delta.tool_calls.forEach((toolCallDelta, position) => {
                                    const slotIndex = Number.isInteger(toolCallDelta?.index)
                                        ? toolCallDelta.index
                                        : (toolCallDelta?.id
                                            ? toolCallSlots.length
                                            : Math.max(0, toolCallSlots.length - 1 + position));
                                    if (!toolCallSlots[slotIndex]) {
                                        toolCallSlots[slotIndex] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                                    }
                                    const slot = toolCallSlots[slotIndex];
                                    if (toolCallDelta?.id) slot.id = toolCallDelta.id;
                                    if (toolCallDelta?.function?.name) slot.function.name += toolCallDelta.function.name;
                                    if (typeof toolCallDelta?.function?.arguments === 'string') {
                                        slot.function.arguments += toolCallDelta.function.arguments;
                                    } else if (toolCallDelta?.function?.arguments && typeof toolCallDelta.function.arguments === 'object') {
                                        slot.function.arguments += JSON.stringify(toolCallDelta.function.arguments);
                                    }
                                });
                            }
                            if (Array.isArray(delta?.reasoning_details)) {
                                reasoningDetails.push(...delta.reasoning_details);
                            }
                            if (Array.isArray(delta?.reasoning_items)) reasoningItems.push(...delta.reasoning_items);

                            if (delta?.content) {
                                currentMessage.content += delta.content;
                                hasUpdate = true;
                            }
                            if (delta?.reasoning_content) {
                                currentMessage.reasoning_content += delta.reasoning_content;
                                hasUpdate = true;
                            }

                            if (hasUpdate) {
                                if (typeof lifecycle?.onStreamMessage === 'function') {
                                    void Promise.resolve(lifecycle.onStreamMessage({
                                        delta,
                                        currentMessage: { ...currentMessage },
                                        chatId,
                                        url: resolvedUrl,
                                    })).catch((error) => {
                                        console.error('[Cerebr] Stream lifecycle handler failed:', error);
                                    });
                                }

                                if (detectMisfiledThinkSilently && !didDispatchAnyUpdate && !currentMessage.reasoning_content) {
                                    const contentStart = String(currentMessage.content || '').trimStart().toLowerCase();
                                    if (misfiledThinkSilentlyPrefixes.some((p) => contentStart.startsWith(p))) {
                                        const error = createChatError(
                                            'CEREBR_MISFILED_THINK_SILENTLY',
                                            'Detected misfiled reasoning content in content field',
                                            {
                                                contentPreview: currentMessage.content,
                                            }
                                        );
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
                            if (e?.code === 'CEREBR_MISFILED_THINK_SILENTLY' || e?.code === 'API_STREAM_ERROR') {
                                throw e;
                            }
                            console.error('解析数据时出错:', e);
                        }
            }
            dispatchUpdate();

            const toolCalls = toolCallSlots.filter((slot) => slot && slot.function.name);
            return {
                ...currentMessage,
                tool_calls: toolCalls,
                reasoning_details: reasoningDetails.length ? reasoningDetails : null,
                reasoning_items: reasoningItems.length ? reasoningItems : null,
                finish_reason: finishReason,
            };
        } catch (error) {
            if (typeof lifecycle?.onRequestError === 'function' && error?.name !== 'AbortError') {
                try {
                    await lifecycle.onRequestError(error, {
                        url: resolvedUrl,
                        requestBody,
                        requestInit,
                    });
                } catch (lifecycleError) {
                    console.error('[Cerebr] Request lifecycle error handler failed:', lifecycleError);
                }
            }
            if (error.name === 'AbortError') {
                return;
            }
            if (error?.code) {
                throw error;
            }
            throw createChatError(
                'NETWORK_ERROR',
                error?.message || t('error_send_failed', ['Network error']),
                {
                    cause: error,
                    url: resolvedUrl,
                }
            );
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
