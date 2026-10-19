import { callAPI } from './api-client.js';
import { buildMessageContent } from '../input/native-editor.js';
import { quotedText } from '../input/draft-quotes.js';
import { showToast } from '../../utils/ui.js';
import { t } from '../../utils/i18n.js';
import { createChatError, isAbortError, normalizeChatError } from './chat-errors.js';

function cloneMessage(message) {
    if (!message || typeof message !== 'object') return message;
    const content = Array.isArray(message.content)
        ? message.content.map((item) => ({ ...item }))
        : message.content;

    return {
        ...message,
        content,
    };
}

function cloneMessages(messages) {
    return Array.isArray(messages) ? messages.map(cloneMessage).filter(Boolean) : [];
}

function normalizeRetryLimit(value, fallback = 20) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? Math.max(1, Math.floor(numeric)) : fallback;
}

const ABORTED = Symbol('cerebr.prelude.aborted');

// 「首 token 之前」的中止闩。callAPI 之后有 AbortController 能直接 abort fetch，但在那之前
// run() 还要 await 取网页上下文、跑 beforeSend 插件。扩展里取正文要跨标签页发消息，而
// chrome.tabs.sendMessage 这一跳没有超时，个别页面（大 PDF、抓不到字幕的视频页）可以挂很久。
// 没有这个闩的话，点「停止更新」只是置一个 pendingAbort 标记，要等这段 await 自己结束才被
// 读到，界面就一直停在「正在思考 N 秒」上，看起来像按钮没反应。
function createPreludeLatch() {
    let release = () => {};
    const aborted = new Promise((resolve) => {
        release = () => resolve(ABORTED);
    });
    return { aborted, release };
}

function normalizeWaterfallPayload(payload, fallbackPayload) {
    if (!payload || typeof payload !== 'object') {
        return fallbackPayload;
    }

    return {
        ...fallbackPayload,
        ...payload,
        draft:
            payload.draft && typeof payload.draft === 'object'
                ? {
                      ...fallbackPayload.draft,
                      ...payload.draft,
                  }
                : fallbackPayload.draft,
    };
}

function resolveUserMessage(payload, fallbackPayload) {
    if (payload?.userMessage && typeof payload.userMessage === 'object') {
        return cloneMessage(payload.userMessage);
    }

    if (payload?.draft && typeof payload.draft === 'object') {
        return {
            role: 'user',
            content: buildMessageContent(payload.draft.message || '', payload.draft.imageTags || []),
        };
    }

    return cloneMessage(fallbackPayload.userMessage || null);
}

export function createChatPipeline({
    chatManager,
    editor,
    getSelectedApiConfig,
    getWebpageInfo,
    getUserLanguage,
    pluginRuntime,
    onPhase = () => {},
    onSubmitted = () => {},
    onSettled = () => {},
}) {
    const abortControllerRef = { current: null, pendingAbort: false };
    let currentController = null;
    let running = null;
    let releasePrelude = null;
    let persistenceWarningShown = false;
    const persistChat = () => {
        const report = (error) => {
            console.error('[Cerebr] Failed to persist chat after reply settled', error);
            if (!persistenceWarningShown) {
                persistenceWarningShown = true;
                showToast(t('error_chat_persistence'), { type: 'error', durationMs: 6000 });
            }
        };
        try {
            // Start the flush before awaiting the idle-scheduled save. Persistence
            // must not keep `running` alive after the model request has settled.
            const saved = chatManager.saveChats({ touchCurrentChat: false });
            const flushed = chatManager.flushNow();
            void Promise.all([saved, flushed])
                .then(() => {
                    persistenceWarningShown = false;
                })
                .catch(report);
        } catch (error) {
            report(error);
        }
    };
    const abortActiveReply = () => {
        // schedule() 里 running 和 run() 的 onPhase('thinking') 在同一段同步代码里完成，run() 的
        // finally 又先回到 idle 再清 running；所以界面上能点到「停止更新」时 running 一定有值。
        if (!running) return Promise.resolve();
        abortControllerRef.pendingAbort = true;
        currentController?.abort();
        releasePrelude?.();
        return running;
    };
    const createOnMessageUpdate = (context) => async (chatId, message) => {
        onPhase('replying', chatId);
        // 不再 cloneMessage：api-client 的 dispatchUpdate 每次已经传进来一个新副本
        // （`{ ...currentMessage }`），插件拿到的就是只属于这一帧的对象。流式期间这个回调每
        // 100ms 触发一次，长回复下白拷一份整条消息不便宜。
        void pluginRuntime?.handleStreamChunk?.(
            { chatId, message, mode: context.mode, attempt: context.attempt },
            context
        );
    };
    const removeLastAssistantMessage = async (chatId) => {
        const chat = chatManager.chats.get(chatId);
        if (chat?.messages.at(-1)?.role === 'assistant') {
            chat.messages.pop();
            chatManager.markChatDirty(chatId);
            persistChat();
        }
    };
    const runResponseErrorHooks = async (error, requestContext) => {
        if (!pluginRuntime?.handleResponseError) {
            return {
                shouldRetry: false,
            };
        }

        const result = await pluginRuntime.handleResponseError(error, requestContext);
        const retryLimit = normalizeRetryLimit(result?.retry?.maxAttempts, requestContext.maxAttempts);

        return {
            shouldRetry: !!result?.retry,
            retry: result?.retry || null,
            maxAttempts: retryLimit,
            cancel: !!result?.cancel,
        };
    };

    const executeRequestAttempts = async ({
        mode,
        chatId,
        apiConfig,
        messages,
        userLanguage,
        webpageInfo,
        promptBaseContext,
        maxAttempts = 20,
    }) => {
        let attempt = 0;
        let effectiveMaxAttempts = normalizeRetryLimit(maxAttempts, 20);

        while (attempt < effectiveMaxAttempts) {
            attempt += 1;

            const requestContext = {
                mode,
                chatId,
                attempt,
                maxAttempts: effectiveMaxAttempts,
                apiConfig,
                messages: cloneMessages(messages),
                userLanguage,
                webpageInfo,
                ...promptBaseContext,
            };

            const pluginPromptResult = pluginRuntime?.buildPromptFragments
                ? await pluginRuntime.buildPromptFragments(requestContext)
                : { fragments: [] };

            const apiParams = {
                messages,
                apiConfig,
                userLanguage,
                webpageInfo,
                promptFragments: pluginPromptResult?.fragments || [],
            };

            const requestLifecycle = {
                beforeRequest: pluginRuntime?.transformRequest
                    ? async (requestDescriptor) =>
                          pluginRuntime.transformRequest(requestDescriptor, {
                              ...requestContext,
                              apiParams,
                          })
                    : null,
                onResponse: pluginRuntime?.handleResponse
                    ? async (responseDescriptor) =>
                          pluginRuntime.handleResponse(responseDescriptor, {
                              ...requestContext,
                              apiParams,
                          })
                    : null,
                onStreamMessage: null,
                onRequestError: pluginRuntime?.handleRequestError
                    ? async (requestError, requestDescriptor) =>
                          pluginRuntime.handleRequestError(requestError, requestDescriptor, {
                              ...requestContext,
                              apiParams,
                          })
                    : null,
            };

            const { processStream, controller } = await callAPI(
                apiParams,
                chatManager,
                chatId,
                createOnMessageUpdate(requestContext),
                {
                    detectMisfiledThinkSilently: true,
                    lifecycle: requestLifecycle,
                }
            );
            currentController = controller;
            abortControllerRef.current = controller;

            if (abortControllerRef.pendingAbort) {
                abortControllerRef.pendingAbort = false;
                try {
                    controller.abort();
                } finally {
                    abortControllerRef.current = null;
                    currentController = null;
                }
                return;
            }

            try {
                const result = await processStream();
                if (!result) {
                    return result;
                }

                const resolvedContent = String(result.content || '').trim();
                const resolvedReasoning = String(result.reasoning_content || '').trim();

                if (!resolvedContent && resolvedReasoning) {
                    const error = createChatError(
                        'CEREBR_REASONING_ONLY_RESPONSE',
                        'The response only contained reasoning content',
                        {
                            result,
                            attempt,
                        }
                    );
                    const resolution = await runResponseErrorHooks(error, {
                        ...requestContext,
                        apiParams,
                    });

                    if (resolution.shouldRetry && attempt < resolution.maxAttempts) {
                        effectiveMaxAttempts = resolution.maxAttempts;
                        await removeLastAssistantMessage(chatId);
                        continue;
                    }

                    throw error;
                }

                if (!resolvedContent && !resolvedReasoning) {
                    showToast(t('toast_empty_response'), { type: 'info', durationMs: 2200 });
                    return result;
                }

                await pluginRuntime?.handleAfterResponse?.(result, {
                    ...requestContext,
                    apiParams,
                });
                return result;
            } catch (error) {
                const normalizedError = normalizeChatError(error, 'CHAT_REQUEST_FAILED');
                if (isAbortError(normalizedError)) {
                    throw normalizedError;
                }

                const resolution = await runResponseErrorHooks(normalizedError, {
                    ...requestContext,
                    apiParams,
                });
                if (resolution.cancel) {
                    return;
                }
                if (resolution.shouldRetry && attempt < resolution.maxAttempts) {
                    effectiveMaxAttempts = resolution.maxAttempts;
                    await removeLastAssistantMessage(chatId);
                    continue;
                }

                throw normalizedError;
            }
        }
    };

    async function run(mode, messageIndex, directDraft) {
        const chat = chatManager.getCurrentChat();
        if (!chat) return false;
        const draft = directDraft || editor.getDraftSnapshot();
        if (mode === 'send' && draft.empty) return false;
        const config = getSelectedApiConfig();
        if (!config?.baseUrl || !config?.apiKey || !config?.modelName) {
            showToast(t('error_send_failed', ['Please configure the API URL and model.']), { type: 'error' });
            return false;
        }
        abortControllerRef.pendingAbort = false;
        const prelude = createPreludeLatch();
        releasePrelude = prelude.release;
        // 用 race 把「等这一步做完」变成「等这一步做完，或者用户点了停止」。abort 后原来的
        // await 仍在后台跑到底（没法真正取消跨标签页取正文），但不再挡着界面复位。
        const raceAbort = async (promise) => Promise.race([promise, prelude.aborted]);
        onPhase('thinking', chat.id);
        try {
            let messages = cloneMessages(chat.messages);
            if (mode === 'regenerate') {
                let index = Number(messageIndex);
                if (!Number.isInteger(index) || index < 0 || index >= messages.length) return false;
                if (messages[index].seedLocaleBound) return false;
                if (messages[index].role === 'assistant') index -= 1;
                if (messages[index]?.role !== 'user') return false;
                messages = messages.slice(0, index + 1);
            }
            const webpageInfo = await raceAbort(Promise.resolve(getWebpageInfo()));
            if (webpageInfo === ABORTED) return false;
            const initial = {
                mode,
                draft: mode === 'send' ? { message: draft.text, imageTags: draft.imageTags } : null,
                userMessage:
                    mode === 'send'
                        ? {
                              role: 'user',
                              content: buildMessageContent(
                                  quotedText(draft.text, draft.quotes),
                                  draft.imageTags
                              ),
                              ...(draft.quotes?.length
                                  ? { selectionQuotes: [...draft.quotes], selectionQuestion: draft.text }
                                  : {}),
                          }
                        : null,
                messages,
                apiConfig: config,
                userLanguage: getUserLanguage(),
                webpageInfo,
            };
            const before = (await raceAbort(
                Promise.resolve(
                    pluginRuntime?.runBeforeSend?.(initial, {
                        mode,
                        chatId: chat.id,
                        trigger: mode === 'send' ? 'draft.submit' : 'message.regenerate',
                    })
                )
            )) || { payload: initial };
            if (before === ABORTED) return false;
            if (
                before.cancel ||
                abortControllerRef.pendingAbort ||
                chatManager.getCurrentChat()?.id !== chat.id
            )
                return false;
            const payload = normalizeWaterfallPayload(before.payload, initial);
            if (mode === 'send') {
                const userMessage = resolveUserMessage(payload, initial);
                if (!chat.messages.length) chat.title = draft.text || t('label_image');
                await chatManager.addMessageToCurrentChat(userMessage);
                if (!directDraft) {
                    editor.clear();
                    editor.focus();
                }
                await onSubmitted(chat.id, { preserveDraft: !!directDraft });
                payload.messages = [...payload.messages, userMessage];
            } else {
                chat.messages = messages;
                chatManager.markChatDirty(chat.id);
                persistChat();
            }
            await executeRequestAttempts({
                mode,
                chatId: chat.id,
                apiConfig: payload.apiConfig,
                messages: payload.messages,
                userLanguage: payload.userLanguage,
                webpageInfo: payload.webpageInfo,
                promptBaseContext: { trigger: mode === 'send' ? 'draft.submit' : 'message.regenerate' },
            });
            return true;
        } catch (error) {
            if (!isAbortError(error)) {
                console.error('[Cerebr] Request failed', error);
                showToast(
                    t(mode === 'send' ? 'error_send_failed' : 'error_regenerate_failed', [error.message]),
                    { type: 'error', durationMs: 3500 }
                );
            }
            return false;
        } finally {
            currentController = null;
            abortControllerRef.current = null;
            if (releasePrelude === prelude.release) releasePrelude = null;
            for (const message of chat.messages) message.updating = false;
            // Restore both the visible phase and the request lock independently
            // of storage. Send/new-chat/switch-chat all wait for this run.
            onPhase('idle', null);
            chatManager.markChatDirty(chat.id);
            persistChat();
            onSettled(chat.id);
        }
    }
    async function schedule(mode, index, directDraft) {
        while (running) {
            abortActiveReply();
            await running;
        }
        const promise = run(mode, index, directDraft);
        running = promise;
        try {
            return await promise;
        } finally {
            if (running === promise) running = null;
        }
    }
    return {
        abortControllerRef,
        abortActiveReply,
        sendMessage: () => schedule('send'),
        sendSelection: (text, question) =>
            schedule('send', undefined, {
                text: String(question || '').trim(),
                quotes: [String(text || '').trim()],
                imageTags: [],
                empty: !String(text || '').trim() || !String(question || '').trim(),
            }),
        regenerateMessage: (target) =>
            schedule(
                'regenerate',
                typeof target === 'number' ? target : Number(target?.dataset?.messageIndex)
            ),
        getCurrentChat: () => chatManager.getCurrentChat() || null,
        getMessages: () => cloneMessages(chatManager.getCurrentChat()?.messages || []),
        showToast,
    };
}
