import { chatManager } from '../utils/chat-manager.js';
import { showImagePreview, createImageTag } from '../utils/ui.js';
import { processMathAndMarkdown, renderMathInElement } from '../../htmd/latex.js';

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
 * @param {boolean} [params.skipHistory=false] - 是否跳过历史记录，skipHistory 的实际作用是：作为一个标志，告诉 appendMessage 函数，当前这条消息只是一个临时的、用于界面展示的通知，而不应该被当作正式的对话内容来处理。
 * @param {DocumentFragment} [params.fragment=null] - 文档片段（用于批量加载）
 * @returns {HTMLElement} 创建的消息元素
 */
export async function appendMessage({
    text,
    sender,
    chatContainer,
    skipHistory = false,
    fragment = null
}) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${sender}-message`;

    // 如果是批量加载，添加特殊类名
    if (fragment) {
        messageDiv.classList.add('batch-load');
    }

    // 处理文本内容
    let textContent = typeof text === 'string' ? text : text.content;

    const previewModal = document.querySelector('.image-preview-modal');
    const previewImage = previewModal.querySelector('img');
    const messageInput = document.getElementById('message-input');

    let messageHtml = '';
    if (Array.isArray(textContent)) {
        textContent.forEach(item => {
            if (item.type === "text") {
                messageHtml += item.text;
                textContent = item.text;
            } else if (item.type === "image_url") {
                const imageTag = createImageTag({
                    base64Data: item.image_url.url,
                    config: {
                        onImageClick: (base64Data) => {
                            showImagePreview({
                                base64Data,
                                config: {
                                    previewModal,
                                    previewImage
                                }
                            });
                        },
                        onDeleteClick: (container) => {
                            container.remove();
                            messageInput.dispatchEvent(new Event('input'));
                        }
                    }
                });
                messageHtml += imageTag.outerHTML;
            }
        });
    } else {
        messageHtml = textContent;
    }

    // 如果是用户消息，且当前对话只有这一条消息，则更新对话标题
    if (sender === 'user' && !skipHistory) {
        const currentChat = chatManager.getCurrentChat();
        if (currentChat && currentChat.messages.length === 0) {
            currentChat.title = textContent;
            chatManager.saveChats();
        }
    }

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
        if (textContent) {
            reasoningDiv.classList.add('collapsed');
        }
        reasoningDiv.onclick = function() {
            this.classList.toggle('collapsed');
        };

        reasoningWrapper.appendChild(reasoningDiv);
        messageDiv.appendChild(reasoningWrapper);
    }

    // 添加主要内容
    const mainContent = document.createElement('div');
    mainContent.className = 'main-content';
    mainContent.innerHTML = processMathAndMarkdown(messageHtml);
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
                showImagePreview({
                    base64Data,
                    config: {
                        previewModal,
                        previewImage
                    }
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
        if (sender === 'ai') {
            messageDiv.classList.add('updating');
        }
    }

    return messageDiv;
}

/**
 * 更新AI消息内容
 * @param {Object} params - 参数对象
 * @param {Object} params.text - 新的消息文本对象，包含content和reasoningContent
 * @param {string} params.text.content - 主要消息内容
 * @param {string|null} params.text.reasoning_content - 深度思考内容
 * @param {HTMLElement} params.chatContainer - 聊天容器元素
 * @returns {Promise<boolean>} 返回是否成功更新了消息
 */
export async function updateAIMessage({
    text,
    chatContainer
}) {
    let lastMessage = chatContainer.querySelector('.message:last-child');
    const currentText = lastMessage.getAttribute('data-original-text') || '';


    // 处理文本内容
    const textContent = typeof text === 'string' ? text : text.content;
    const reasoningContent = typeof text === 'string' ? null : text.reasoning_content;

    // 如果新文本的开头与当前文本不一致，则认为消息不连续，置空lastMessage
    if (!textContent.startsWith(currentText) && currentText !== '') {
        lastMessage = null;
    }

    if (lastMessage && lastMessage.classList.contains('ai-message')) {
        // 获取当前显示的文本
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

            if (textContent && reasoningDiv && !reasoningDiv.classList.contains('collapsed')) {
                reasoningDiv.classList.add('collapsed');
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
            chatContainer
        });
        return true;
    }
}