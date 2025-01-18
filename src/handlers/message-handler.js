import { processMathAndMarkdown, renderMathInElement } from '../utils/latex.js';
import { processImageTags } from '../services/chat.js';

/**
 * 消息处理配置接口
 * @typedef {Object} MessageHandlerConfig
 * @property {function} onSaveHistory - 保存历史记录的回调函数
 * @property {function} onShowImagePreview - 显示图片预览的回调函数，接收 base64Data 和 config 参数
 * @property {function} onUpdateAIMessage - 更新AI消息的回调函数
 * @property {Object} imagePreviewConfig - 图片预览配置对象
 */

/**
 * 消息接口
 * @typedef {Object} Message
 * @property {string} role - 消息角色 ("user" | "assistant")
 * @property {string | Array<{type: string, text?: string, image_url?: {url: string}}>} content - 消息内容
 */

/**
 * 添加消息到聊天界面
 * @param {Object} params - 参数对象
 * @param {string} params.text - 消息文本内容
 * @param {string} params.sender - 发送者类型 ("user" | "assistant")
 * @param {HTMLElement} params.chatContainer - 聊天容器元素
 * @param {boolean} [params.skipHistory=false] - 是否跳过历史记录
 * @param {DocumentFragment} [params.fragment=null] - 文档片段（用于批量加载）
 * @param {MessageHandlerConfig} params.config - 消息处理配置
 * @returns {HTMLElement} 创建的消息元素
 */
export async function appendMessage({
    text,
    sender,
    chatContainer,
    skipHistory = false,
    fragment = null,
    config
}) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${sender}-message`;

    // 如果是批量加载，添加特殊类名
    if (fragment) {
        messageDiv.classList.add('batch-load');
    }

    // 存储原始文本用于复制
    messageDiv.setAttribute('data-original-text', text);

    // 处理数学公式和 Markdown
    messageDiv.innerHTML = processMathAndMarkdown(text);

    // 渲染 LaTeX 公式
    try {
        await renderMathInElement(messageDiv);
    } catch (err) {
        console.error('渲染LaTeX公式失败:', err);
    }

    // 处理消息中的链接
    messageDiv.querySelectorAll('a').forEach(link => {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
    });

    // 处理消息中的图片标签
    messageDiv.querySelectorAll('.image-tag').forEach(tag => {
        const img = tag.querySelector('img');
        const base64Data = tag.getAttribute('data-image');
        if (img && base64Data) {
            img.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                config.onShowImagePreview({
                    base64Data,
                    config: config.imagePreviewConfig
                });
            });
        }
    });

    // 如果提供了文档片段，添加到片段中；否则直接添加到聊天容器
    if (fragment) {
        fragment.appendChild(messageDiv);
    } else {
        chatContainer.appendChild(messageDiv);
        // 只在发送新消息时自动滚动（不是加载历史记录）
        if (sender === 'user' && !skipHistory) {
            requestAnimationFrame(() => {
                chatContainer.scrollTo({
                    top: chatContainer.scrollHeight,
                    behavior: 'smooth'
                });
            });
        }
    }

    // 只有在不跳过历史记录时才添加到历史记录
    if (!skipHistory) {
        const messageContent = processImageTags(text);
        const message = {
            role: sender === 'user' ? 'user' : 'assistant',
            content: messageContent
        };

        config.onSaveHistory(message);

        if (sender === 'ai') {
            messageDiv.classList.add('updating');
        }
    }

    return messageDiv;
}

/**
 * AI消息更新配置接口
 * @typedef {Object} UpdateAIMessageConfig
 * @property {function} onSaveHistory - 保存历史记录的回调函数
 * @property {function} onShowImagePreview - 显示图片预览的回调函数
 */

/**
 * 更新AI消息内容
 * @param {Object} params - 参数对象
 * @param {string} params.text - 新的消息文本
 * @param {HTMLElement} params.chatContainer - 聊天容器元素
 * @param {UpdateAIMessageConfig} params.config - 消息处理配置
 * @param {MessageHandlerConfig} params.messageHandlerConfig - 消息处理器配置
 * @returns {void}
 */
export function updateAIMessage({
    text,
    chatContainer,
    config,
    messageHandlerConfig
}) {
    const lastMessage = chatContainer.querySelector('.ai-message:last-child');
    let rawText = text;

    if (lastMessage) {
        // 获取当前显示的文本
        const currentText = lastMessage.getAttribute('data-original-text') || '';
        // 如果新文本比当前文本长，说有新内容需要更新
        if (text.length > currentText.length) {
            // 更新原始文本属性
            lastMessage.setAttribute('data-original-text', text);

            // 处理数学公式和Markdown
            lastMessage.innerHTML = processMathAndMarkdown(text);

            // 渲染LaTeX公式
            renderMathInElement(lastMessage);

            // 处理新染的链接
            lastMessage.querySelectorAll('a').forEach(link => {
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            });

            // 更新历史记录
            config.onSaveHistory(rawText);
        }
    } else {
        appendMessage({
            text: rawText,
            sender: 'ai',
            chatContainer,
            config: messageHandlerConfig
        });
    }
}