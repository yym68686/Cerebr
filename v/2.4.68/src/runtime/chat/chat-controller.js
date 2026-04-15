import { callAPI } from './api-client.js';
import { appendMessage } from '../../render/message/message-renderer.js';
import { getFormattedMessageContent, buildMessageContent, clearMessageInput } from '../../components/message-input.js';
import { ensureChatElementVisible } from '../../utils/scroll.js';
import { showToast } from '../../utils/ui.js';
import { t } from '../../utils/i18n.js';
import { getInstalledPromptFragments } from '../../plugin/market/plugin-market-service.js';

export function createChatController({
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

    const callAPIWithRetry = async (apiParams, chatId, onMessageUpdate, maxRetries = 20) => {
        let attempt = 0;
        let misfiledThinkSilentlyRetries = 0;
        const maxMisfiledThinkSilentlyRetries = maxRetries;

        while (attempt <= maxRetries) {
            const { processStream, controller } = await callAPI(apiParams, chatManager, chatId, onMessageUpdate, {
                detectMisfiledThinkSilently: misfiledThinkSilentlyRetries < maxMisfiledThinkSilentlyRetries,
                misfiledThinkSilentlyPrefixes: ['think', 'silently', '思考', 'thought']
            });
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

            let result;
            try {
                result = await processStream();
            } catch (error) {
                if (
                    error?.code === 'CEREBR_MISFILED_THINK_SILENTLY' &&
                    misfiledThinkSilentlyRetries < maxMisfiledThinkSilentlyRetries &&
                    attempt < maxRetries
                ) {
                    console.warn(`检测到 Gemini 将思维链错误写入 content，正在自动重试... (尝试次数 ${attempt + 1})`);
                    misfiledThinkSilentlyRetries++;
                    attempt++;

                    const currentChat = chatManager.getCurrentChat?.();
                    const lastMessage = currentChat?.messages?.[currentChat.messages.length - 1];
                    if (lastMessage?.role === 'assistant') {
                        await chatManager.popMessage();
                    }
                    continue;
                }
                throw error;
            }

            if (!result) return result;

            const resolvedContent = String(result.content || '').trim();
            const resolvedReasoning = String(result.reasoning_content || '').trim();

            if (!resolvedContent && resolvedReasoning && attempt < maxRetries) {
                console.log(`API响应可能被截断，正在重试... (尝试次数 ${attempt + 1})`);
                attempt++;
                const currentChat = chatManager.getCurrentChat?.();
                const lastMessage = currentChat?.messages?.[currentChat.messages.length - 1];
                if (lastMessage?.role === 'assistant') {
                    await chatManager.popMessage();
                }
                continue;
            }

            if (!resolvedContent && !resolvedReasoning) {
                showToast(t('toast_empty_response'), { type: 'info', durationMs: 2200 });
                return result;
            }

            return result;
        }
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

    const createOnMessageUpdate = () => {
        let didStartReplying = false;
        return async (updatedChatId, message) => {
            if (!didStartReplying) {
                didStartReplying = true;
                setReplyingPlaceholder();
            }
            return chatContainerManager.syncMessage(updatedChatId, message);
        };
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

            const apiParams = {
                messages: currentChat.messages,
                apiConfig: getSelectedApiConfig(),
                userLanguage: getUserLanguage(),
                webpageInfo: await getWebpageInfo(),
                promptFragments: await getInstalledPromptFragments(),
            };

            createReplyPlaceholder(stickToBottomOnStart);

            await callAPIWithRetry(apiParams, currentChat.id, createOnMessageUpdate());
            await flushSessionState();
        } catch (error) {
            if (error.name === 'AbortError') {
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
            const stickToBottomOnSend = shouldStickToBottom(chatContainer);
            const content = buildMessageContent(message, imageTags);
            const userMessage = {
                role: 'user',
                content
            };

            appendMessage({
                text: userMessage,
                sender: 'user',
                chatContainer,
            });

            clearMessageInput(messageInput, uiConfig);
            messageInput.focus();
            setThinkingPlaceholder();

            const currentChat = chatManager.getCurrentChat();
            if (currentChat?.id) {
                await storageAdapter.remove(getDraftKeyForChatId(currentChat.id));
            }

            const messages = currentChat ? [...currentChat.messages] : [];
            messages.push(userMessage);
            await chatManager.addMessageToCurrentChat(userMessage);
            await chatManager.flushNow().catch(() => {});

            const apiParams = {
                messages,
                apiConfig: getSelectedApiConfig(),
                userLanguage: getUserLanguage(),
                webpageInfo: await getWebpageInfo(),
                promptFragments: await getInstalledPromptFragments(),
            };

            createReplyPlaceholder(stickToBottomOnSend);

            await callAPIWithRetry(apiParams, currentChat.id, createOnMessageUpdate());
            await flushSessionState();
        } catch (error) {
            if (error.name === 'AbortError') {
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
    };
}
