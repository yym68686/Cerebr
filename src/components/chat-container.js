import { createImageTag, showToast } from '../utils/ui.js';
import { showContextMenu, hideContextMenu, copyMessageContent } from './context-menu.js';
import { handleImageDrop } from '../utils/image.js';
import { updateAIMessage } from '../handlers/message-handler.js';

/**
 * 初始化聊天容器的所有功能
 * @param {Object} params - 初始化参数对象
 * @param {HTMLElement} params.chatContainer - 聊天容器元素
 * @param {HTMLElement} params.messageInput - 消息输入框元素
 * @param {HTMLElement} params.contextMenu - 上下文菜单元素
 * @param {Function} params.sendMessage - 发送消息的函数
 * @param {AbortController} params.currentController - 当前控制器引用
 * @param {Object} params.uiConfig - UI配置对象
 * @param {Array} params.userQuestions - 用户问题历史数组
 * @param {Object} params.chatManager - 聊天管理器实例
 * @returns {Object} 包含更新处理程序的对象
 */
export function initChatContainer({
    chatContainer,
    messageInput,
    contextMenu,
    userQuestions,
    chatManager
}) {
    // 定义本地变量
    let currentMessageElement = null;
    let currentCodeElement = null;

    // 初始化 MutationObserver 来监视添加到聊天容器的新用户消息
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.classList && node.classList.contains('user-message')) {
                    const question = node.textContent.trim();
                    // 只有当问题不在历史记录中时才添加
                    if (question && !userQuestions.includes(question)) {
                        userQuestions.push(question);
                    }
                }
            });
        });
    });

    // 开始观察聊天容器的变化
    observer.observe(chatContainer, { childList: true });

    // 添加点击事件监听
    // 注意：不要在这里强制 blur 输入框，否则会影响桌面端“点击聊天区域聚焦输入框”等交互；
    // 需要 blur 的场景由全局点击逻辑处理即可。

    // 监听 AI 消息的右键点击
    chatContainer.addEventListener('contextmenu', (e) => {
        const messageElement = e.target.closest('.ai-message, .user-message');
        const codeElement = e.target.closest('pre > code');
        const imageElement = e.target.closest('img');

        if (messageElement) {
            currentMessageElement = messageElement;
            currentCodeElement = codeElement;

            // 获取菜单元素
            const copyCodeButton = document.getElementById('copy-code');
            const copyMathButton = document.getElementById('copy-math');
            const copyImageButton = document.getElementById('copy-image');
            const stopUpdateButton = document.getElementById('stop-update');
            const copyMessageButton = document.getElementById('copy-message');
            const deleteMessageButton = document.getElementById('delete-message');
            const regenerateMessageButton = document.getElementById('regenerate-message');

            // 根据右键点击的元素类型显示/隐藏相应的菜单项
            regenerateMessageButton.style.display = 'flex';
            copyMessageButton.style.display = 'flex';
            deleteMessageButton.style.display = 'flex';
            copyCodeButton.style.display = codeElement ? 'flex' : 'none';
            copyMathButton.style.display = 'none';  // 默认隐藏复制公式按钮

            // 只有AI消息且正在更新时才显示停止更新按钮
            stopUpdateButton.style.display = (messageElement.classList.contains('ai-message') && messageElement.classList.contains('updating')) ? 'flex' : 'none';

            const isImageClick = imageElement && messageElement.classList.contains('ai-message');
            copyImageButton.style.display = isImageClick ? 'flex' : 'none';
            if (isImageClick) {
                copyImageButton.dataset.src = imageElement.src;
            }

            showContextMenu({
                event: e,
                messageElement,
                contextMenu,
                stopUpdateButton,
                onMessageElementSelect: (element) => {
                    currentMessageElement = element;
                }
            });
        }
    });

    // 添加长按触发右键菜单的支持
    let touchTimeout;
    let touchStartX;
    let touchStartY;
    const LONG_PRESS_DURATION = 200; // 长按触发时间为200ms

    chatContainer.addEventListener('touchstart', (e) => {
        const messageElement = e.target.closest('.ai-message, .user-message');
        if (!messageElement) return;

        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;

        touchTimeout = setTimeout(() => {
            const codeElement = e.target.closest('pre > code');
            currentMessageElement = messageElement;
            currentCodeElement = codeElement;

            // 获取菜单元素
            const copyMessageButton = document.getElementById('copy-message');
            const copyCodeButton = document.getElementById('copy-code');
            const stopUpdateButton = document.getElementById('stop-update');
            const deleteMessageButton = document.getElementById('delete-message');
            const regenerateMessageButton = document.getElementById('regenerate-message');

             // 根据长按元素类型显示/隐藏相应的菜单项
            regenerateMessageButton.style.display = 'flex';
            copyMessageButton.style.display = 'flex';
            deleteMessageButton.style.display = 'flex';
            copyCodeButton.style.display = codeElement ? 'flex' : 'none';
            stopUpdateButton.style.display = (messageElement.classList.contains('ai-message') && messageElement.classList.contains('updating')) ? 'flex' : 'none';

            showContextMenu({
                event: {
                    preventDefault: () => {},
                    clientX: touchStartX,
                    clientY: touchStartY
                },
                messageElement,
                contextMenu,
                stopUpdateButton,
                onMessageElementSelect: (element) => {
                    currentMessageElement = element;
                }
            });
        }, LONG_PRESS_DURATION);
    }, { passive: false });

    chatContainer.addEventListener('touchmove', (e) => {
        // 如果移动超过10px，取消长按
        if (touchTimeout &&
            (Math.abs(e.touches[0].clientX - touchStartX) > 10 ||
            Math.abs(e.touches[0].clientY - touchStartY) > 10)) {
            clearTimeout(touchTimeout);
            touchTimeout = null;
        }
    }, { passive: true });

    chatContainer.addEventListener('touchend', () => {
        if (touchTimeout) {
            clearTimeout(touchTimeout);
            touchTimeout = null;
        }
        // 如果用户没有触发长按（即正常的触摸结束），则隐藏菜单
        if (!contextMenu.classList.contains('visible')) {
            hideContextMenu({
                contextMenu,
                onMessageElementReset: () => { currentMessageElement = null; }
            });
        }
    });

    // 为聊天区域添加拖放事件监听器
    chatContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    chatContainer.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    chatContainer.addEventListener('drop', (e) => {
        handleImageDrop(e, {
            messageInput,
            createImageTag,
            onSuccess: () => {
                // 可以在这里添加成功处理的回调
            },
            onError: (error) => {
                console.error('处理拖放事件失败:', error);
                showToast(error?.message || '处理图片失败', { type: 'error' });
            }
        });
    });

    // 阻止聊天区域的图片默认行为
    chatContainer.addEventListener('click', (e) => {
        if (e.target.tagName === 'IMG') {
            e.preventDefault();
            // 注意：这里不再调用 e.stopPropagation()。
            // 这样，点击事件可以冒泡到 document 上的全局监听器，
            // 该监听器会检查点击是否在菜单外部，并相应地隐藏菜单。
            // 我之前的修改错误地在这里隐藏了菜单，现在这个逻辑由全局监听器正确处理。
        }
    });

    // 创建消息同步函数
    const syncMessage = async (updatedChatId, message) => {
        const currentChat = chatManager.getCurrentChat();
        // 只有当更新的消息属于当前显示的对话时才更新界面
        if (currentChat && currentChat.id === updatedChatId) {
            await updateAIMessage({
                text: message,
                chatContainer
            });
        }
    };

    // 设置按钮事件处理器
    function setupButtonHandlers({
        copyMessageButton,
        copyCodeButton,
        copyImageButton,
        stopUpdateButton,
        deleteMessageButton,
        regenerateMessageButton,
        abortController,
        regenerateMessage
    }) {
        // 点击复制按钮
        copyMessageButton.addEventListener('click', () => {
            copyMessageContent({
                messageElement: currentMessageElement,
                onSuccess: () => {
                    showToast('已复制消息', { type: 'success' });
                    hideContextMenu({
                        contextMenu,
                        onMessageElementReset: () => {
                            currentMessageElement = null;
                            currentCodeElement = null;
                        }
                    });
                },
                onError: (err) => {
                    console.error('复制失败:', err);
                    showToast('复制失败', { type: 'error' });
                }
            });
        });

        // 点击复制代码按钮
        copyCodeButton.addEventListener('click', () => {
            if (currentCodeElement) {
                const codeText = currentCodeElement.textContent;
                navigator.clipboard.writeText(codeText)
                    .then(() => {
                        showToast('已复制代码', { type: 'success' });
                        hideContextMenu({
                            contextMenu,
                            onMessageElementReset: () => {
                                currentMessageElement = null;
                                currentCodeElement = null;
                            }
                        });
                    })
                    .catch(err => {
                        console.error('复制代码失败:', err);
                        showToast('复制代码失败', { type: 'error' });
                    });
            }
        });

        // 点击复制图片按钮
        copyImageButton.addEventListener('click', async () => {
            const imageUrl = copyImageButton.dataset.src;
            if (!imageUrl) return;

            // Find the actual image element in the message
            const imgElement = currentMessageElement.querySelector(`img[src="${imageUrl}"]`);

            try {
                let blob = imgElement ? imgElement.cachedBlob : null;

                // If not cached, fetch it on-demand
                if (!blob) {
                    if (imageUrl.startsWith('data:')) {
                        const response = await fetch(imageUrl);
                        blob = await response.blob();
                    } else {
                        // Try direct fetch first (works for same-origin / CORS-enabled images)
                        let response;
                        try {
                            response = await fetch(imageUrl);
                        } catch {
                            response = null;
                        }

                        if (!response || !response.ok) {
                            const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(imageUrl)}`;
                            response = await fetch(proxyUrl);
                            if (!response.ok) {
                                throw new Error(`通过代理获取图片失败: ${response.statusText}`);
                            }
                        }
                        blob = await response.blob();
                    }
                    if (imgElement && blob) imgElement.cachedBlob = blob;
                }

                if (blob) {
                    await navigator.clipboard.write([
                        new ClipboardItem({ [blob.type]: blob })
                    ]);
                    showToast('已复制图片', { type: 'success' });
                } else {
                    throw new Error('无法获取图片数据。');
                }

            } catch (err) {
                console.error('复制图片失败:', err);
                showToast(err.message || '复制图片失败', { type: 'error', durationMs: 2200 });
            } finally {
                hideContextMenu({
                    contextMenu,
                    onMessageElementReset: () => {
                        currentMessageElement = null;
                        currentCodeElement = null;
                    }
                });
            }
        });

        // 添加停止更新按钮的点击事件处理
        stopUpdateButton.addEventListener('click', () => {
            if (abortController.current) {
                abortController.current.abort();  // 中止当前请求
                abortController.current = null;
            } else {
                // 兼容“首 token 前”用户立即停止：controller 还未暴露出来时先记账
                abortController.pendingAbort = true;
            }
            hideContextMenu({
                contextMenu,
                onMessageElementReset: () => { currentMessageElement = null; }
            });
        });

        // 添加删除消息按钮的点击事件处理
        deleteMessageButton.addEventListener('click', () => {
            if (currentMessageElement) {
                // 如果消息正在更新，先中止请求
                if (currentMessageElement.classList.contains('updating') && abortController.current) {
                    abortController.current.abort();
                    abortController.current = null;
                }

                // 从DOM中移除消息元素
                const messageIndex = Array.from(chatContainer.children).indexOf(currentMessageElement);
                currentMessageElement.remove();

                // 从chatManager中删除对应的消息
                const currentChat = chatManager.getCurrentChat();
                if (currentChat && messageIndex !== -1) {
                    currentChat.messages.splice(messageIndex, 1);
                    chatManager.saveChats();
                }

                // 隐藏右键菜单
                hideContextMenu({
                    contextMenu,
                    onMessageElementReset: () => {
                        currentMessageElement = null;
                        currentCodeElement = null;
                    }
                });
            }
        });

        // 添加重新生成消息按钮的点击事件处理
        regenerateMessageButton.addEventListener('click', () => {
            if (currentMessageElement) {
                regenerateMessage(currentMessageElement);
                // 隐藏右键菜单
                hideContextMenu({
                    contextMenu,
                    onMessageElementReset: () => {
                        currentMessageElement = null;
                        currentCodeElement = null;
                    }
                });
            }
        });
    }

    // 设置数学公式上下文菜单处理
    function setupMathContextMenu() {
        document.addEventListener('contextmenu', (event) => {
            // 检查是否点击了 MathJax 3 的任何元素
            const isMathElement = (element) => {
                if (!(element instanceof Element)) return false;
                const tagName = element.tagName?.toLowerCase?.();
                const isMjx = tagName?.startsWith('mjx-');
                const hasContainer = element.closest('mjx-container') !== null;
                return isMjx || hasContainer;
            };

            if (!isMathElement(event.target)) return;

            event.preventDefault();
            event.stopPropagation();

            // 获取最外层的 mjx-container
            const container = event.target.closest('mjx-container');
            if (!container) return;

            const mathContextMenu = document.getElementById('copy-math');
            if (!mathContextMenu) return;

            const copyMessageButton = document.getElementById('copy-message');
            const copyCodeButton = document.getElementById('copy-code');
            const copyImageButton = document.getElementById('copy-image');
            const stopUpdateButton = document.getElementById('stop-update');
            const deleteMessageButton = document.getElementById('delete-message');
            const regenerateMessageButton = document.getElementById('regenerate-message');

            // 设置菜单项的显示状态
            mathContextMenu.style.display = 'flex';
            copyMessageButton.style.display = 'flex';
            deleteMessageButton.style.display = 'flex';
            regenerateMessageButton.style.display = 'flex';
            copyCodeButton.style.display = 'none';
            copyImageButton.style.display = 'none';

            // 获取包含公式的消息元素（AI 或用户）
            const messageElement = container.closest('.ai-message, .user-message');
            if (!messageElement) return;
            currentMessageElement = messageElement;

            showContextMenu({
                event,
                messageElement,
                contextMenu,
                stopUpdateButton
            });

            // 设置数学公式内容
            const assistiveMml = container.querySelector('mjx-assistive-mml');
            let mathContent;

            // 获取原始的 LaTeX 源码
            const mjxTexElement = container.querySelector('script[type="math/tex; mode=display"]') ||
                container.querySelector('script[type="math/tex"]');

            if (mjxTexElement) {
                mathContent = mjxTexElement.textContent;
            } else {
                // 如果找不到原始 LaTeX，尝试从 MathJax 内部存储获取
                const mjxInternal = container.querySelector('mjx-math');
                if (mjxInternal) {
                    const texAttr = mjxInternal.getAttribute('aria-label');
                    if (texAttr) {
                        // 移除 "TeX:" 前缀（如果有的话）
                        mathContent = texAttr.replace(/^TeX:\s*/, '');
                    }
                }
            }

            // 如果还是没有找到，尝试其他方法
            if (!mathContent && assistiveMml) {
                const texAttr = assistiveMml.getAttribute('aria-label');
                if (texAttr) {
                    mathContent = texAttr.replace(/^TeX:\s*/, '');
                }
            }

            mathContextMenu.dataset.mathContent = mathContent || container.textContent;
        }, { capture: true, passive: false });

        // 复制数学公式
        document.getElementById('copy-math')?.addEventListener('click', async () => {
            try {
                // 获取数学公式内容
                const mathContent = document.getElementById('copy-math').dataset.mathContent;

                if (mathContent) {
                    await navigator.clipboard.writeText(mathContent);
                    showToast('已复制公式', { type: 'success' });

                    // 隐藏上下文菜单
                    hideContextMenu({
                        contextMenu,
                        onMessageElementReset: () => {
                            currentMessageElement = null;
                        }
                    });
                } else {
                    console.error('没有找到可复制的数学公式内容');
                    showToast('没有找到可复制的公式', { type: 'error' });
                }
            } catch (err) {
                console.error('复制公式失败:', err);
                showToast('复制公式失败', { type: 'error' });
            }
        });
    }

    // 初始化用户问题历史
    function initializeUserQuestions() {
        const userMessages = document.querySelectorAll('.user-message');
        const questions = Array.from(userMessages).map(msg => msg.textContent.trim());

        // 清空并添加新问题
        userQuestions.length = 0;
        userQuestions.push(...questions);
    }

    // 设置全局点击和触摸事件，用于隐藏上下文菜单
    function setupGlobalEvents() {
        // 点击其他地方隐藏菜单
        document.addEventListener('click', (e) => {
            if (!contextMenu.contains(e.target)) {
                hideContextMenu({
                    contextMenu,
                    onMessageElementReset: () => { currentMessageElement = null; }
                });
            }
        });

        // 触摸其他地方隐藏菜单
        document.addEventListener('touchstart', (e) => {
            if (!contextMenu.contains(e.target)) {
                hideContextMenu({
                    contextMenu,
                    onMessageElementReset: () => { currentMessageElement = null; }
                });
            }
        });

        // 滚动时隐藏菜单
        chatContainer.addEventListener('scroll', () => {
            hideContextMenu({
                contextMenu,
                onMessageElementReset: () => { currentMessageElement = null; }
            });
        });

        // 按下 Esc 键隐藏菜单
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                hideContextMenu({
                    contextMenu,
                    onMessageElementReset: () => { currentMessageElement = null; }
                });
            }
        });
    }

    // 初始化函数
    function initialize() {
        setupMathContextMenu();
        setupGlobalEvents();
        initializeUserQuestions();
    }

    // 立即执行初始化
    initialize();

    // 添加自定义复制事件处理器
    chatContainer.addEventListener('copy', (event) => {
        const selection = document.getSelection();
        if (selection.rangeCount === 0 || selection.toString().trim() === '') {
            return;
        }

        // 检查选区是否在聊天容器内
        if (!chatContainer.contains(selection.anchorNode) || !chatContainer.contains(selection.focusNode)) {
            return;
        }

        event.preventDefault();

        const range = selection.getRangeAt(0);
        const fragment = range.cloneContents();
        const tempDiv = document.createElement('div');
        tempDiv.appendChild(fragment);

        // 优化MathJax公式的复制，移除导致换行的多余结构
        const mjxContainers = tempDiv.querySelectorAll('mjx-container');
        mjxContainers.forEach(container => {
            const assistiveMml = container.querySelector('mjx-assistive-mml math');
            if (assistiveMml) {
                // 用干净的 MathML 替换整个 mjx-container
                container.parentNode.replaceChild(assistiveMml.cloneNode(true), container);
            }
        });

        const html = tempDiv.innerHTML;
        const plainText = tempDiv.textContent; // 从清理后的div中获取纯文本

        event.clipboardData.setData('text/html', html);
        event.clipboardData.setData('text/plain', plainText);
    });

    // 返回包含公共方法的对象
    return {
        syncMessage,
        setupButtonHandlers,
        initializeUserQuestions
    };
}
