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
 * @param {Object|string} params.text - 消息文本内容，可以是字符串或包含content和reasoning_content的对象
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

    // 处理文本内容
    const textContent = typeof text === 'string' ? text : text.content;
    const reasoningContent = typeof text === 'string' ? null : text.reasoning_content;

    // 存储原始文本用于复制
    messageDiv.setAttribute('data-original-text', textContent);

    // 如果有思考内容，添加思考模块
    if (reasoningContent) {
        const reasoningWrapper = document.createElement('div');
        reasoningWrapper.className = 'reasoning-wrapper';

        const reasoningDiv = document.createElement('div');
        reasoningDiv.className = 'reasoning-content';

        // 添加占位文本容器
        const placeholderDiv = document.createElement('div');
        placeholderDiv.className = 'reasoning-placeholder';
        placeholderDiv.textContent = '深度思考';
        reasoningDiv.appendChild(placeholderDiv);

        // 添加文本容器
        const reasoningTextDiv = document.createElement('div');
        reasoningTextDiv.className = 'reasoning-text';
        reasoningTextDiv.innerHTML = processMathAndMarkdown(reasoningContent).trim();
        reasoningDiv.appendChild(reasoningTextDiv);

        // 添加点击事件处理折叠/展开
        reasoningDiv.onclick = function() {
            this.classList.toggle('collapsed');
        };

        reasoningWrapper.appendChild(reasoningDiv);
        messageDiv.appendChild(reasoningWrapper);
    }

    // 添加主要内容
    const mainContent = document.createElement('div');
    mainContent.className = 'main-content';
    mainContent.innerHTML = processMathAndMarkdown(textContent);
    messageDiv.appendChild(mainContent);

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
        const messageContent = processImageTags(textContent);
        const message = {
            role: sender === 'user' ? 'user' : 'assistant',
            content: messageContent,
            ...(reasoningContent && { reasoning_content: reasoningContent })
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
 * @param {Object} params.text - 新的消息文本对象，包含content和reasoningContent
 * @param {string} params.text.content - 主要消息内容
 * @param {string|null} params.text.reasoning_content - 深度思考内容
 * @param {HTMLElement} params.chatContainer - 聊天容器元素
 * @param {UpdateAIMessageConfig} params.config - 消息处理配置
 * @param {MessageHandlerConfig} params.messageHandlerConfig - 消息处理器配置
 * @returns {Promise<boolean>} 返回是否成功更新了消息
 */
export async function updateAIMessage({
    text,
    chatContainer,
    config,
    messageHandlerConfig
}) {
    const lastMessage = chatContainer.querySelector('.ai-message.updating');

    // 处理文本内容
    const textContent = typeof text === 'string' ? text : text.content;
    const reasoningContent = typeof text === 'string' ? null : text.reasoning_content;

    if (lastMessage) {
        // 获取当前显示的文本
        const currentText = lastMessage.getAttribute('data-original-text') || '';
        // 如果新文本比当前文本长，说有新内容需要更新
        if (textContent.length > currentText.length || reasoningContent) {
            // 更新原始文本属性
            lastMessage.setAttribute('data-original-text', textContent);

            // 处理深度思考内容
            let reasoningDiv = lastMessage.querySelector('.reasoning-content');
            if (reasoningContent) {
                if (!reasoningDiv) {
                    const reasoningWrapper = document.createElement('div');
                    reasoningWrapper.className = 'reasoning-wrapper';

                    reasoningDiv = document.createElement('div');
                    reasoningDiv.className = 'reasoning-content';

                    // 添加占位文本容器
                    const placeholderDiv = document.createElement('div');
                    placeholderDiv.className = 'reasoning-placeholder';
                    placeholderDiv.textContent = '深度思考';
                    reasoningDiv.appendChild(placeholderDiv);

                    // 添加文本容器
                    const reasoningTextDiv = document.createElement('div');
                    reasoningTextDiv.className = 'reasoning-text';
                    reasoningDiv.appendChild(reasoningTextDiv);

                    // 添加点击事件处理折叠/展开
                    reasoningDiv.onclick = function() {
                        this.classList.toggle('collapsed');
                    };

                    reasoningWrapper.appendChild(reasoningDiv);

                    // 确保深度思考模块在最上方
                    if (lastMessage.firstChild) {
                        lastMessage.insertBefore(reasoningWrapper, lastMessage.firstChild);
                    } else {
                        lastMessage.appendChild(reasoningWrapper);
                    }
                }

                // 获取或创建文本容器
                let reasoningTextDiv = reasoningDiv.querySelector('.reasoning-text');
                if (!reasoningTextDiv) {
                    reasoningTextDiv = document.createElement('div');
                    reasoningTextDiv.className = 'reasoning-text';
                    reasoningDiv.appendChild(reasoningTextDiv);
                }

                // 获取当前显示的文本
                const currentReasoningText = reasoningTextDiv.getAttribute('data-original-text') || '';

                // 如果新文本比当前文本长，说明有新内容需要更新
                if (reasoningContent.length > currentReasoningText.length) {
                    // 更新原始文本属性
                    reasoningTextDiv.setAttribute('data-original-text', reasoningContent);
                    // 更新显示内容
                    reasoningTextDiv.innerHTML = processMathAndMarkdown(reasoningContent).trim();
                    await renderMathInElement(reasoningTextDiv);
                }
            }

            // 处理主要内容
            const mainContent = document.createElement('div');
            mainContent.className = 'main-content';
            mainContent.innerHTML = processMathAndMarkdown(textContent);

            // 清除原有的主要内容
            Array.from(lastMessage.children).forEach(child => {
                if (!child.classList.contains('reasoning-wrapper')) {
                    child.remove();
                }
            });

            // 将主要内容添加到深度思考模块之后
            const reasoningWrapper = lastMessage.querySelector('.reasoning-wrapper');
            if (reasoningWrapper) {
                lastMessage.insertBefore(mainContent, reasoningWrapper.nextSibling);
            } else {
                lastMessage.appendChild(mainContent);
            }

            // 渲染LaTeX公式
            await renderMathInElement(mainContent);

            // 处理新染的链接
            lastMessage.querySelectorAll('a').forEach(link => {
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            });

            // 更新历史记录（包含主要内容和思考内容）
            const message = {
                role: 'assistant',
                content: textContent,
                ...(reasoningContent && { reasoning_content: reasoningContent })
            };
            config.onSaveHistory(message);
            return true;
        }
        return true; // 如果文本没有变长，也认为是成功的
    } else {
        // 创建新消息时也需要包含思考内容
        await appendMessage({
            text: {
                content: textContent,
                reasoning_content: reasoningContent
            },
            sender: 'ai',
            chatContainer,
            config: messageHandlerConfig
        });
        return true;
    }
}