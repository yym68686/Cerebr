import { callAPI } from './api-client.js';
import { appendMessage } from '../../render/message/message-renderer.js';
import {
    buildMessageContent,
    clearMessageInput,
    getFormattedMessageContent,
} from '../../components/message-input.js';
import { ensureChatElementVisible } from '../../utils/scroll.js';
import { showToast } from '../../utils/ui.js';
import { t } from '../../utils/i18n.js';
import { getInstalledPromptFragments } from '../../plugin/market/plugin-market-service.js';
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
    return Array.isArray(messages)
        ? messages.map(cloneMessage).filter(Boolean)
        : [];
}

function normalizeRetryLimit(value, fallback = 20) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0
        ? Math.max(1, Math.floor(numeric))
        : fallback;
}

function normalizeWaterfallPayload(payload, fallbackPayload) {
    if (!payload || typeof payload !== 'object') {
        return fallbackPayload;
    }

    return {
        ...fallbackPayload,
        ...payload,
        draft: payload.draft && typeof payload.draft === 'object'
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
            content: buildMessageContent(
                payload.draft.message || '',
                payload.draft.imageTags || []
            ),
        };
    }

    return cloneMessage(fallbackPayload.userMessage || null);
}

export function createChatPipeline({
    chatContainer,
    messageInput,
    uiConfig,
    chatContainerManager,
    chatManager,
    getReadingProgressManager,
    getSelectedApiConfig,
    getWebpageInfo,
    getUserLanguage,
    getDraftKeyForChatId,
    storageAdapter,
    shouldStickToBottom,
    setThinkingPlaceholder,
    setReplyingPlaceholder,
    restoreDefaultPlaceholder,
    pluginRuntime = null,
}) {
    const abortControllerRef = { current: null, pendingAbort: false };
    let currentController = null;

    const abortActiveReply = () => {
        const updatingMessage = chatContainer.querySelector('.ai-message.updating');
        if (updatingMessage && currentController) {
            currentController.abort();
            currentController = null;
            abortControllerRef.current = null;
            updatingMessage.classList.remove('updating');
        }
    };

    const flushSessionState = async () => {
        await chatManager.flushNow().catch(() => {});
        await getReadingProgressManager()?.saveNow().catch(() => {});
    };

    const cleanupLastAssistantPlaceholder = () => {
        const lastMessage = chatContainer.querySelector('.ai-message:last-child');
        if (!lastMessage) return;
        lastMessage.classList.remove('updating');
        const original = lastMessage.getAttribute('data-original-text') || '';
        if (!original.trim()) {
            lastMessage.remove();
        }
    };

    const createReplyPlaceholder = (stickToBottom) => {
        void appendMessage({
            text: '',
            sender: 'ai',
            chatContainer,
        }).then((element) => {
            if (!stickToBottom) return;
            ensureChatElementVisible({ chatContainer, element, behavior: 'smooth' });
        });
    };

    const createOnMessageUpdate = (requestContext) => {
        let didStartReplying = false;

        return async (updatedChatId, message) => {
            if (!didStartReplying) {
                didStartReplying = true;
                setReplyingPlaceholder();
            }

            if (pluginRuntime?.handleStreamChunk) {
                void pluginRuntime.handleStreamChunk({
                    chatId: updatedChatId,
                    message: cloneMessage(message),
                    mode: requestContext.mode,
                    attempt: requestContext.attempt,
                }, requestContext);
            }

            return chatContainerManager.syncMessage(updatedChatId, message);
        };
    };

    const removeLastAssistantMessage = async () => {
        const currentChat = chatManager.getCurrentChat?.();
        const lastMessage = currentChat?.messages?.[currentChat.messages.length - 1];
        if (lastMessage?.role === 'assistant') {
            await chatManager.popMessage();
        }
    };

    const runResponseErrorHooks = async (error, requestContext) => {
        if (!pluginRuntime?.handleResponseError) {
            return {
                shouldRetry: false,
            };
        }

        const result = await pluginRuntime.handleResponseError(error, requestContext);
        const retryLimit = normalizeRetryLimit(
            result?.retry?.maxAttempts,
            requestContext.maxAttempts
        );

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

            const [installedPromptFragments, pluginPromptResult] = await Promise.all([
                getInstalledPromptFragments(),
                pluginRuntime?.buildPromptFragments
                    ? pluginRuntime.buildPromptFragments(requestContext)
                    : Promise.resolve({ fragments: [] }),
            ]);

            const apiParams = {
                messages,
                apiConfig,
                userLanguage,
                webpageInfo,
                promptFragments: [
                    ...(installedPromptFragments || []),
                    ...((pluginPromptResult?.fragments || [])),
                ],
            };

            const requestLifecycle = {
                beforeRequest: pluginRuntime?.transformRequest
                    ? async (requestDescriptor) => pluginRuntime.transformRequest(requestDescriptor, {
                        ...requestContext,
                        apiParams,
                    })
                    : null,
                onResponse: pluginRuntime?.handleResponse
                    ? async (responseDescriptor) => pluginRuntime.handleResponse(responseDescriptor, {
                        ...requestContext,
                        apiParams,
                    })
                    : null,
                onStreamMessage: null,
                onRequestError: pluginRuntime?.handleRequestError
                    ? async (requestError, requestDescriptor) => pluginRuntime.handleRequestError(requestError, requestDescriptor, {
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
                        await removeLastAssistantMessage();
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
                    await removeLastAssistantMessage();
                    continue;
                }

                throw normalizedError;
            }
        }
    };

    async function regenerateMessage(messageElement) {
        if (!messageElement) return;
        abortActiveReply();

        let userMessageElement = null;
        let aiMessageElement = null;
        if (messageElement.classList.contains('user-message')) {
            userMessageElement = messageElement;
            aiMessageElement = messageElement.nextElementSibling;
        } else {
            userMessageElement = messageElement.previousElementSibling;
            aiMessageElement = messageElement;
        }

        if (!userMessageElement || !userMessageElement.classList.contains('user-message')) {
            console.error('无法找到对应的用户消息');
            return;
        }

        try {
            const currentChat = chatManager.getCurrentChat();
            if (!currentChat) return;

            const stickToBottomOnStart = shouldStickToBottom(chatContainer);
            setThinkingPlaceholder();

            chatContainer.querySelectorAll('.ai-message').forEach((element) => {
                const original = element.getAttribute('data-original-text') || '';
                if (!original.trim() && element.querySelector('.typing-indicator')) {
                    element.remove();
                }
            });

            const domMessages = Array.from(chatContainer.querySelectorAll('.user-message, .ai-message'));
            const userMessageDomIndex = domMessages.indexOf(userMessageElement);
            const aiMessageDomIndex = aiMessageElement ? domMessages.indexOf(aiMessageElement) : -1;

            const truncateFromIndex = aiMessageDomIndex !== -1
                ? aiMessageDomIndex
                : (userMessageDomIndex !== -1 ? userMessageDomIndex + 1 : currentChat.messages.length);

            if (currentChat.messages.length < truncateFromIndex) {
                for (let index = currentChat.messages.length; index < truncateFromIndex && index < domMessages.length; index++) {
                    const element = domMessages[index];
                    const original = element.getAttribute('data-original-text');
                    const content = (original && original.trim()) ? original : (element.textContent || '');
                    const role = element.classList.contains('user-message') ? 'user' : 'assistant';
                    currentChat.messages.push({ role, content });
                }
            }

            currentChat.messages.splice(truncateFromIndex);
            chatManager.saveChats();
            await chatManager.flushNow().catch(() => {});
            domMessages.slice(truncateFromIndex).forEach((element) => element.remove());

            const initialPayload = {
                mode: 'regenerate',
                draft: null,
                userMessage: null,
                messages: cloneMessages(currentChat.messages),
                apiConfig: getSelectedApiConfig(),
                userLanguage: getUserLanguage(),
                webpageInfo: await getWebpageInfo(),
            };

            const beforeSendResult = pluginRuntime?.runBeforeSend
                ? await pluginRuntime.runBeforeSend(initialPayload, {
                    mode: 'regenerate',
                    chatId: currentChat.id,
                    trigger: 'message.regenerate',
                })
                : { payload: initialPayload, cancel: false };
            if (beforeSendResult?.cancel) {
                return;
            }

            const effectivePayload = normalizeWaterfallPayload(
                beforeSendResult?.payload,
                initialPayload
            );

            createReplyPlaceholder(stickToBottomOnStart);

            await executeRequestAttempts({
                mode: 'regenerate',
                chatId: currentChat.id,
                apiConfig: effectivePayload.apiConfig,
                messages: effectivePayload.messages,
                userLanguage: effectivePayload.userLanguage,
                webpageInfo: effectivePayload.webpageInfo,
                promptBaseContext: {
                    trigger: 'message.regenerate',
                },
            });
            await flushSessionState();
        } catch (error) {
            if (isAbortError(error)) {
                console.log('用户手动停止更新');
                return;
            }
            console.error('重新生成消息失败:', error);
            showToast(t('error_regenerate_failed', [error.message]), { type: 'error', durationMs: 2200 });
        } finally {
            await flushSessionState();
            restoreDefaultPlaceholder();
            cleanupLastAssistantPlaceholder();
        }
    }

    async function sendMessage() {
        abortActiveReply();

        const { message, imageTags } = getFormattedMessageContent(messageInput);
        if (!message.trim() && imageTags.length === 0) return;

        try {
            const currentChat = chatManager.getCurrentChat();
            if (!currentChat?.id) {
                throw createChatError('CHAT_NOT_READY', 'Current chat is not ready');
            }

            const stickToBottomOnSend = shouldStickToBottom(chatContainer);
            const initialPayload = {
                mode: 'send',
                draft: {
                    message,
                    imageTags,
                },
                userMessage: {
                    role: 'user',
                    content: buildMessageContent(message, imageTags),
                },
                messages: cloneMessages(currentChat.messages),
                apiConfig: getSelectedApiConfig(),
                userLanguage: getUserLanguage(),
                webpageInfo: await getWebpageInfo(),
            };

            const beforeSendResult = pluginRuntime?.runBeforeSend
                ? await pluginRuntime.runBeforeSend(initialPayload, {
                    mode: 'send',
                    chatId: currentChat.id,
                    trigger: 'draft.submit',
                })
                : { payload: initialPayload, cancel: false };
            if (beforeSendResult?.cancel) {
                return;
            }

            const effectivePayload = normalizeWaterfallPayload(
                beforeSendResult?.payload,
                initialPayload
            );
            const userMessage = resolveUserMessage(effectivePayload, initialPayload);

            appendMessage({
                text: userMessage,
                sender: 'user',
                chatContainer,
            });

            clearMessageInput(messageInput, uiConfig);
            messageInput.focus();
            setThinkingPlaceholder();

            if (currentChat.id) {
                await storageAdapter.remove(getDraftKeyForChatId(currentChat.id));
            }

            await chatManager.addMessageToCurrentChat(userMessage);
            await chatManager.flushNow().catch(() => {});

            createReplyPlaceholder(stickToBottomOnSend);

            await executeRequestAttempts({
                mode: 'send',
                chatId: currentChat.id,
                apiConfig: effectivePayload.apiConfig,
                messages: [...effectivePayload.messages, userMessage],
                userLanguage: effectivePayload.userLanguage,
                webpageInfo: effectivePayload.webpageInfo,
                promptBaseContext: {
                    trigger: 'draft.submit',
                    userMessage: cloneMessage(userMessage),
                },
            });
            await flushSessionState();
        } catch (error) {
            if (isAbortError(error)) {
                console.log('用户手动停止更新');
                return;
            }
            console.error('发送消息失败:', error);
            showToast(t('error_send_failed', [error.message]), { type: 'error', durationMs: 2200 });
        } finally {
            await flushSessionState();
            restoreDefaultPlaceholder();
            cleanupLastAssistantPlaceholder();
        }
    }

    return {
        abortControllerRef,
        sendMessage,
        regenerateMessage,
        abortActiveReply,
        getCurrentChat() {
            return chatManager.getCurrentChat?.() || null;
        },
        getMessages() {
            return cloneMessages(chatManager.getCurrentChat?.()?.messages || []);
        },
        showToast,
    };
}
