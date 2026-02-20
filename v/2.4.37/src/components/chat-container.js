import { createImageTag, showToast } from '../utils/ui.js';
import { showContextMenu, hideContextMenu, copyMessageContent } from './context-menu.js';
import { handleImageDrop } from '../utils/image.js';
import { updateAIMessage } from '../handlers/message-handler.js';
import { t } from '../utils/i18n.js';

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

    const isMathElement = (element) => {
        if (!(element instanceof Element)) return false;
        const tagName = element.tagName?.toLowerCase?.();
        const isMjx = tagName?.startsWith('mjx-');
        const hasContainer = element.closest('mjx-container') !== null;
        return isMjx || hasContainer;
    };

    const getMathContentFromContainer = (container) => {
        if (!(container instanceof Element)) return '';

        const mjxTexElement =
            container.querySelector('script[type="math/tex; mode=display"]') ||
            container.querySelector('script[type="math/tex"]');
        if (mjxTexElement?.textContent) return mjxTexElement.textContent.trim();

        const mjxInternal = container.querySelector('mjx-math');
        const internalLabel = mjxInternal?.getAttribute?.('aria-label');
        if (internalLabel) return internalLabel.replace(/^TeX:\s*/, '').trim();

        const assistiveMml = container.querySelector('mjx-assistive-mml');
        const assistiveLabel = assistiveMml?.getAttribute?.('aria-label');
        if (assistiveLabel) return assistiveLabel.replace(/^TeX:\s*/, '').trim();

        const containerLabel = container.getAttribute?.('aria-label');
        if (containerLabel) return containerLabel.replace(/^TeX:\s*/, '').trim();

        return (container.textContent || '').trim();
    };

    chatContainer.addEventListener('touchstart', (e) => {
        const targetElement = e.target instanceof Element ? e.target : e.target?.parentElement;
        if (!targetElement) return;

        const messageElement = targetElement.closest('.ai-message, .user-message');
        if (!messageElement) return;

        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;

        touchTimeout = setTimeout(() => {
            const codeElement = targetElement.closest('pre > code');
            const imageElement = targetElement.closest('img');
            const mathContainer = isMathElement(targetElement) ? targetElement.closest('mjx-container') : null;
            currentMessageElement = messageElement;
            currentCodeElement = codeElement;

            // 获取菜单元素
            const copyMessageButton = document.getElementById('copy-message');
            const copyCodeButton = document.getElementById('copy-code');
            const copyMathButton = document.getElementById('copy-math');
            const copyImageButton = document.getElementById('copy-image');
            const stopUpdateButton = document.getElementById('stop-update');
            const deleteMessageButton = document.getElementById('delete-message');
            const regenerateMessageButton = document.getElementById('regenerate-message');

             // 根据长按元素类型显示/隐藏相应的菜单项
            regenerateMessageButton.style.display = 'flex';
            copyMessageButton.style.display = 'flex';
            deleteMessageButton.style.display = 'flex';
            copyCodeButton.style.display = !mathContainer && codeElement ? 'flex' : 'none';
            stopUpdateButton.style.display = (messageElement.classList.contains('ai-message') && messageElement.classList.contains('updating')) ? 'flex' : 'none';

            if (copyMathButton) {
                if (mathContainer) {
                    copyMathButton.style.display = 'flex';
                    copyMathButton.dataset.mathContent = getMathContentFromContainer(mathContainer);
                } else {
                    copyMathButton.style.display = 'none';
                    delete copyMathButton.dataset.mathContent;
                }
            }

            const isImagePress = !mathContainer && imageElement && messageElement.classList.contains('ai-message');
            if (copyImageButton) {
                copyImageButton.style.display = isImagePress ? 'flex' : 'none';
                if (isImagePress) {
                    copyImageButton.dataset.src = imageElement.src;
                } else {
                    delete copyImageButton.dataset.src;
                }
            }

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
                showToast(error?.message || t('toast_handle_image_failed'), { type: 'error' });
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
        const on = (el, type, handler, options) => {
            if (!el) return;
            el.addEventListener(type, handler, options);
        };

        on(copyMessageButton, 'click', () => {
            copyMessageContent({
                messageElement: currentMessageElement,
                onSuccess: () => {
                    showToast(t('toast_copied_message'), { type: 'success' });
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
                    showToast(t('toast_copy_failed'), { type: 'error' });
                }
            });
        });

        // 点击复制代码按钮
        on(copyCodeButton, 'click', () => {
            if (currentCodeElement) {
                const codeText = currentCodeElement.textContent;
                navigator.clipboard.writeText(codeText)
                    .then(() => {
                        showToast(t('toast_copied_code'), { type: 'success' });
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
                        showToast(t('toast_copy_code_failed'), { type: 'error' });
                    });
            }
        });

        // 点击复制图片按钮
        on(copyImageButton, 'click', async () => {
            const imageUrl = copyImageButton?.dataset?.src;
            if (!imageUrl) return;

            // Find the actual image element in the message
            const imgElement = currentMessageElement?.querySelector?.(`img[src="${imageUrl}"]`) || null;

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
                                throw new Error(t('error_fetch_image_proxy_failed', [response.statusText]));
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
                    showToast(t('toast_copied_image'), { type: 'success' });
                } else {
                    throw new Error(t('error_unable_get_image_data'));
                }

            } catch (err) {
                console.error('复制图片失败:', err);
                showToast(err?.message || t('toast_copy_image_failed'), { type: 'error', durationMs: 2200 });
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
        on(stopUpdateButton, 'click', () => {
            if (abortController?.current) {
                abortController.current.abort();  // 中止当前请求
                abortController.current = null;
            } else {
                // 兼容“首 token 前”用户立即停止：controller 还未暴露出来时先记账
                if (abortController) abortController.pendingAbort = true;
            }
            hideContextMenu({
                contextMenu,
                onMessageElementReset: () => { currentMessageElement = null; }
            });
        });

        // 添加删除消息按钮的点击事件处理
        on(deleteMessageButton, 'click', () => {
            if (currentMessageElement) {
                // 如果消息正在更新，先中止请求
                if (currentMessageElement.classList.contains('updating') && abortController?.current) {
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
        on(regenerateMessageButton, 'click', () => {
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

            mathContextMenu.dataset.mathContent = getMathContentFromContainer(container);
        }, { capture: true, passive: false });

        // 复制数学公式
        document.getElementById('copy-math')?.addEventListener('click', async () => {
            try {
                // 获取数学公式内容
                const mathContent = document.getElementById('copy-math').dataset.mathContent;

                if (mathContent) {
                    await navigator.clipboard.writeText(mathContent);
                    showToast(t('toast_copied_math'), { type: 'success' });

                    // 隐藏上下文菜单
                    hideContextMenu({
                        contextMenu,
                        onMessageElementReset: () => {
                            currentMessageElement = null;
                        }
                    });
                } else {
                    console.error('没有找到可复制的数学公式内容');
                    showToast(t('toast_no_math_found'), { type: 'error' });
                }
            } catch (err) {
                console.error('复制公式失败:', err);
                showToast(t('toast_copy_math_failed'), { type: 'error' });
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
        const dismissContextMenu = ({ restoreFocus = false } = {}) => {
            if (!contextMenu.classList.contains('visible')) return;
            hideContextMenu({
                contextMenu,
                onMessageElementReset: () => { currentMessageElement = null; },
                restoreFocus
            });
        };

        document.addEventListener('pointerdown', (e) => {
            if (contextMenu.contains(e.target)) return;
            dismissContextMenu({ restoreFocus: false });
        }, { capture: true, passive: true });

        // 点击其他地方隐藏菜单
        document.addEventListener('click', (e) => {
            if (!contextMenu.contains(e.target)) {
                dismissContextMenu({ restoreFocus: false });
            }
        });

        // 触摸其他地方隐藏菜单
        document.addEventListener('touchstart', (e) => {
            if (!contextMenu.contains(e.target)) {
                dismissContextMenu({ restoreFocus: false });
            }
        });

        document.addEventListener('wheel', () => {
            dismissContextMenu({ restoreFocus: false });
        }, { capture: true, passive: true });

        // 滚动时隐藏菜单
        chatContainer.addEventListener('scroll', () => dismissContextMenu({ restoreFocus: false }), { passive: true });

        document.addEventListener('selectionchange', () => {
            if (!contextMenu.classList.contains('visible')) return;
            const selection = document.getSelection();
            if (!selection || selection.isCollapsed) return;
            if (!chatContainer.contains(selection.anchorNode) || !chatContainer.contains(selection.focusNode)) return;
            dismissContextMenu({ restoreFocus: false });
        });

        // 按下 Esc 键隐藏菜单
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                dismissContextMenu({ restoreFocus: true });
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
