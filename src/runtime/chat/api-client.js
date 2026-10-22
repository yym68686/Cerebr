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
    // 删除消息列表中的reasoning_content字段
    const processedMessages = messages
        .map((msg) => normalizeMessageForChatCompletions({
            role: msg?.role,
            content: msg?.content
        }))
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
        let updateTimeout = null;
        let flushPendingUpdate = () => {};
        // finally 里要能取消挂着的 rAF，但 cancelFrame 定义在 try 内部（依赖流式循环的局部
        // 状态），所以在这里留一个可被覆盖的句柄。
        let cancelPendingFrame = () => {};
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
                body: JSON.stringify(requestBody),
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
            reader = response.body?.getReader?.();
            if (!reader) {
                throw createChatError(
                    'RESPONSE_UNREADABLE',
                    t('error_response_unreadable'),
                    {
                        url: resolvedUrl,
                    }
                );
            }

            let buffer = '';
            let currentMessage = {
                content: '',
                reasoning_content: ''
            };
            let lastUpdateTime = 0;
            const decoder = new TextDecoder();
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

            // 100ms 的节流点和浏览器的帧边界没有对齐，所以一次分发触发的 React 渲染 + 排版
             // 经常落在一帧的中间，下一帧开始前没做完就变成掉帧。这里把真正的写入挪到 rAF 里，
            // 让「解析 SSE」和「渲染」各自待在自己的帧内。
            //
            // rAF 只做对齐，不做保证：后台标签页里 rAF 会被压到几乎不触发，而流式还在继续，
            // 所以原来的 setTimeout 节流保持原样作为兜底 —— 谁先到就谁分发，另一边看到
            // 已经没有待处理内容就自己退出。
            let rafId = 0;
            const cancelFrame = () => {
                if (!rafId) return;
                cancelAnimationFrame(rafId);
                rafId = 0;
            };

            const commitUpdate = () => {
                if (!currentMessage.content && !currentMessage.reasoning_content) return;
                if (chatManager && chatId) {
                    // 创建一个副本以避免回调函数意外修改
                    const messageCopy = { ...currentMessage };
                    chatManager.updateLastMessage(chatId, messageCopy, { throttleMs: 750 });
                    onMessageUpdate(chatId, messageCopy);
                    lastUpdateTime = Date.now();
                    didDispatchAnyUpdate = true;
                }
            };

            const dispatchUpdate = () => {
                if (updateTimeout) {
                    clearTimeout(updateTimeout);
                    updateTimeout = null;
                }
                cancelFrame();
                commitUpdate();
            };

            // 帧对齐的分发：rAF 不可用（比如 Node 里跑测试）时退化成立即分发。
            const scheduleFrameUpdate = () => {
                if (rafId) return;
                if (typeof requestAnimationFrame !== 'function') {
                    dispatchUpdate();
                    return;
                }
                rafId = requestAnimationFrame(() => {
                    rafId = 0;
                    dispatchUpdate();
                });
            };

            flushPendingUpdate = () => { if (updateTimeout || rafId) dispatchUpdate(); };
            cancelPendingFrame = cancelFrame;
            while (true) {
                const { done, value } = await reader.read();
                buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
                if (done && buffer.trim()) buffer += '\n';

                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
                    buffer = buffer.slice(newlineIndex + 1);

                    if (line.startsWith('data:')) {
                        const data = line.slice(5).trimStart();
                        if (data.trim() === '[DONE]') {
                            dispatchUpdate();
                            return currentMessage;
                        }

                        try {
                            const choice = JSON.parse(data).choices?.[0];
                            const delta = choice?.delta;
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

                                if (!updateTimeout && !rafId) {
                                     // 如果距离上次更新超过了间隔，就等下一帧开头写入，而不是
                                     // 在解析循环中间同步渲染。
                                    if (Date.now() - lastUpdateTime > UPDATE_INTERVAL) {
                                        scheduleFrameUpdate();
                                    } else {
                                         // 否则，设置一个定时器，在间隔的剩余时间后更新
                                        updateTimeout = setTimeout(dispatchUpdate, UPDATE_INTERVAL - (Date.now() - lastUpdateTime));
                                    }
                                }
                            }
                            if (choice?.finish_reason) {
                                dispatchUpdate();
                                return currentMessage;
                            }
                        } catch (e) {
                            if (e?.code === 'CEREBR_MISFILED_THINK_SILENTLY') {
                                throw e;
                            }
                            console.error('解析数据时出错:', e);
                        }
                    }
                }
                if (done) { dispatchUpdate(); break; }
            }

            return currentMessage;
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
            // flushPendingUpdate 内部会同时清掉 timer 和 rAF；这里的 clearTimeout 只是
            // 没有待分发内容时的兜底（那种情况下 flush 不做事）。
            flushPendingUpdate();
            clearTimeout(updateTimeout);
            cancelPendingFrame();
            try {
                // Releasing a completed response must not wait for a stalled transport.
                void reader?.cancel?.().catch(() => {});
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
