/**
 * 消息输入组件
 * 处理用户输入、粘贴、拖放图片等交互
 */

import { adjustTextareaHeight, createImageTag, showImagePreview, hideImagePreview } from '../utils/ui.js';
import { handleImageDrop } from '../utils/image.js';

// 跟踪输入法状态
let isComposing = false;

/**
 * 初始化消息输入组件
 * @param {Object} config - 配置对象
 * @param {HTMLElement} config.messageInput - 消息输入框元素
 * @param {Function} config.sendMessage - 发送消息的回调函数
 * @param {Array} config.userQuestions - 用户问题历史数组
 * @param {Object} config.contextMenu - 上下文菜单对象
 * @param {Function} config.hideContextMenu - 隐藏上下文菜单的函数
 * @param {Object} config.uiConfig - UI配置对象
 * @param {HTMLElement} [config.settingsMenu] - 设置菜单元素（可选）
 * @param {HTMLElement} [config.webpageContentMenu] - 网页内容菜单元素（可选）
 */
export function initMessageInput(config) {
    const {
        messageInput,
        sendMessage,
        userQuestions,
        contextMenu,
        hideContextMenu,
        uiConfig,
        settingsMenu,
        webpageContentMenu // 接收二级菜单
    } = config;

    // 添加点击事件监听
    document.body.addEventListener('click', (e) => {
        // 如果有文本被选中，不要触发输入框聚焦
        if (window.getSelection().toString()) {
            return;
        }

        // 排除点击设置按钮、设置菜单、上下文菜单、对话列表页面的情况
        if (!e.target.closest('#settings-button') &&
            !e.target.closest('#settings-menu') &&
            !e.target.closest('#context-menu') &&
            !e.target.closest('#chat-list-page') &&
            !e.target.closest('#quick-chat-settings-page')) {

            // 切换输入框焦点状态
            if (document.activeElement === messageInput) {
                messageInput.blur();
            } else {
                messageInput.focus();
            }
        }
    });

    // 监听输入框变化
    messageInput.addEventListener('input', function() {
        adjustTextareaHeight({
            textarea: this,
            config: uiConfig.textarea
        });

        // 如果正在使用输入法，则不处理 placeholder
        if (isComposing) {
            return;
        }

        // 处理 placeholder 的显示
        if (this.textContent.trim() === '' && !this.querySelector('.image-tag')) {
            // 如果内容空且没有图片标签，清空内容以显示 placeholder
            while (this.firstChild) {
                this.removeChild(this.firstChild);
            }
        }
    });

    // 监听输入框的焦点状态
    messageInput.addEventListener('focus', () => {
        // 输入框获得焦点时隐藏右键菜单
        if (hideContextMenu) {
            hideContextMenu({
                contextMenu,
                onMessageElementReset: () => {}
            });
        }

        // 如果存在设置菜单，则隐藏它
        if (settingsMenu) {
            settingsMenu.classList.remove('visible');
        }

        // 如果存在网页内容菜单，则隐藏它
        if (webpageContentMenu) {
            webpageContentMenu.classList.remove('visible');
        }

        // 输入框获得焦点，阻止事件冒泡
        messageInput.addEventListener('click', (e) => e.stopPropagation());
    });

    messageInput.addEventListener('blur', () => {
        // 输入框失去焦点时，移除点击事件监听
        messageInput.removeEventListener('click', (e) => e.stopPropagation());
    });

    // 处理换行和输入
    messageInput.addEventListener('compositionstart', () => {
        isComposing = true;
    });

    messageInput.addEventListener('compositionend', () => {
        isComposing = false;
    });

    messageInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            if (isComposing) {
                // 如果正在使用输入法，不发送消息
                return;
            }
            e.preventDefault();
            const text = this.textContent.trim();
            if (text || this.querySelector('.image-tag')) {  // 检查是否有文本或图片
                sendMessage();
            }
        } else if (e.key === 'Escape') {
            // 按 ESC 键时让输入框失去焦点
            messageInput.blur();
        } else if (e.key === 'ArrowUp' && e.target.textContent.trim() === '') {
            // 处理输入框特定的键盘事件
            // 当按下向上键且输入框为空时
            e.preventDefault(); // 阻止默认行为

            // 如果有历史记录
            if (userQuestions.length > 0) {
                // 获取最后一个问题
                e.target.textContent = userQuestions[userQuestions.length - 1];
                // 触发入事件以调整高度
                e.target.dispatchEvent(new Event('input', { bubbles: true }));
                // 移动光标到末尾
                moveCaretToEnd(e.target);
            }
        } else if ((e.key === 'Backspace' || e.key === 'Delete')) {
            // 处理图片标签的删除
            const selection = window.getSelection();
            if (selection.rangeCount === 0) return;

            const range = selection.getRangeAt(0);
            const startContainer = range.startContainer;

            // 检查是否在图片标签旁边
            if (startContainer.nodeType === Node.TEXT_NODE && startContainer.textContent === '') {
                const previousSibling = startContainer.previousSibling;
                if (previousSibling && previousSibling.classList?.contains('image-tag')) {
                    e.preventDefault();
                    previousSibling.remove();

                    // 移除可能存在的多余换行
                    const brElements = messageInput.getElementsByTagName('br');
                    Array.from(brElements).forEach(br => {
                        if (!br.nextSibling || (br.nextSibling.nodeType === Node.TEXT_NODE && br.nextSibling.textContent.trim() === '')) {
                            br.remove();
                        }
                    });

                    // 触发输入事件以调整高度
                    messageInput.dispatchEvent(new Event('input'));
                }
            }
        }
    });

    // 粘贴事件处理
    messageInput.addEventListener('paste', async (e) => {
        e.preventDefault(); // 阻止默认粘贴行为

        const items = Array.from(e.clipboardData.items);
        const imageItem = items.find(item => item.type.startsWith('image/'));

        if (imageItem) {
            // 处理图片粘贴
            const file = imageItem.getAsFile();
            const reader = new FileReader();

            reader.onload = async () => {
                const base64Data = reader.result;
                const imageTag = createImageTag({
                    base64Data,
                    fileName: file.name,
                    config: uiConfig.imageTag
                });

                // 在光标位置插入图片标签
                const selection = window.getSelection();
                const range = selection.getRangeAt(0);
                range.deleteContents();
                range.insertNode(imageTag);

                // 移动光标到图片标签后面，并确保不会插入额外的换行
                const newRange = document.createRange();
                newRange.setStartAfter(imageTag);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);

                // 移除可能存在的多余行
                const brElements = messageInput.getElementsByTagName('br');
                Array.from(brElements).forEach(br => {
                    if (br.previousSibling && br.previousSibling.classList && br.previousSibling.classList.contains('image-tag')) {
                        br.remove();
                    }
                });

                // 触发输入事件以调整高度
                messageInput.dispatchEvent(new Event('input'));
            };

            reader.readAsDataURL(file);
        } else {
            // 处理文本粘贴
            const text = e.clipboardData.getData('text/plain');
            document.execCommand('insertText', false, text);
        }
    });

    // 拖放事件监听器
    messageInput.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    messageInput.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    messageInput.addEventListener('drop', (e) => {
        handleImageDrop(e, {
            messageInput,
            createImageTag,
            onSuccess: () => {
                // 成功处理后的回调
            },
            onError: (error) => {
                console.error('处理拖放事件失败:', error);
            }
        });
    });
}

/**
 * 设置消息输入框的 placeholder
 * @param {Object} params - 参数对象
 * @param {HTMLElement} params.messageInput - 消息输入框元素
 * @param {string} params.placeholder - placeholder 文本
 * @param {number} [params.timeout] - 超时时间（可选），超时后恢复默认 placeholder
 */
export function setPlaceholder({ messageInput, placeholder, timeout }) {
    if (messageInput) {
        const originalPlaceholder = messageInput.getAttribute('data-original-placeholder') || '输入消息...';
        messageInput.setAttribute('placeholder', placeholder);
        if (timeout) {
            setTimeout(() => {
                messageInput.setAttribute('placeholder', originalPlaceholder);
            }, timeout);
        }
    }
}

/**
 * 更新输入框的永久 placeholder
 * @param {HTMLElement} messageInput - 消息输入框元素
 * @param {string} modelName - 当前模型的名称
 */
export function updatePermanentPlaceholder(messageInput, modelName) {
    if (messageInput) {
        const placeholder = `向 ${modelName} 发送消息...`;
        messageInput.setAttribute('placeholder', placeholder);
        messageInput.setAttribute('data-original-placeholder', placeholder);
    }
}

/**
 * 获取格式化后的消息内容（处理HTML转义和图片）
 * @param {HTMLElement} messageInput - 消息输入框元素
 * @returns {Object} 格式化后的内容和图片标签
 */
export function getFormattedMessageContent(messageInput) {
    // 使用innerHTML获取内容，并将<br>转换为\n
    let message = messageInput.innerHTML
        .replace(/<div><br><\/div>/g, '\n')  // 处理换行后的空行
        .replace(/<div>/g, '\n')             // 处理换行后的新行开始
        .replace(/<\/div>/g, '')             // 处理换行后的新行结束
        .replace(/<br\s*\/?>/g, '\n')        // 处理单个换行
        .replace(/&nbsp;/g, ' ');            // 处理空格

    // 将HTML实体转换回实际字符
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = message;
    message = tempDiv.textContent;

    // 获取图片标签
    const imageTags = messageInput.querySelectorAll('.image-tag');

    return { message, imageTags };
}

/**
 * 构建消息内容对象（文本+图片）
 * @param {string} message - 消息文本
 * @param {NodeList} imageTags - 图片标签节点列表
 * @returns {string|Array} 格式化后的消息内容
 */
export function buildMessageContent(message, imageTags) {
    if (imageTags.length > 0) {
        const content = [];
        if (message.trim()) {
            content.push({
                type: "text",
                text: message
            });
        }
        imageTags.forEach(tag => {
            const base64Data = tag.getAttribute('data-image');
            if (base64Data) {
                content.push({
                    type: "image_url",
                    image_url: {
                        url: base64Data
                    }
                });
            }
        });
        return content;
    } else {
        return message;
    }
}

/**
 * 清空输入框
 * @param {HTMLElement} messageInput - 消息输入框元素
 * @param {Object} config - UI配置
 */
export function clearMessageInput(messageInput, config) {
    messageInput.innerHTML = '';
    adjustTextareaHeight({
        textarea: messageInput,
        config: config.textarea
    });
}

/**
 * 将光标移动到元素末尾
 * @param {HTMLElement} element - 要操作的元素
 */
function moveCaretToEnd(element) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
}

/**
 * 处理消息输入组件的窗口消息
 * @param {MessageEvent} event - 消息事件对象
 * @param {Object} config - 配置对象
 */
export function handleWindowMessage(event, config) {
    const { messageInput, newChatButton, uiConfig } = config;

    if (event.data.type === 'DROP_IMAGE') {
        const imageData = event.data.imageData;
        if (imageData && imageData.data) {
            // 确保base64数据格式正确
            const base64Data = imageData.data.startsWith('data:') ? imageData.data : `data:image/png;base64,${imageData.data}`;
            const imageTag = createImageTag({
                base64Data: base64Data,
                fileName: imageData.name,
                config: uiConfig.imageTag
            });

            // 确保输入框有焦点
            messageInput.focus();

            // 获取或创建选区
            const selection = window.getSelection();
            let range;

            // 检查是否有现有选区
            if (selection.rangeCount > 0) {
                range = selection.getRangeAt(0);
            } else {
                // 创建新的选区
                range = document.createRange();
                // 将选区设置到输入框的末尾
                range.selectNodeContents(messageInput);
                range.collapse(false);
                selection.removeAllRanges();
                selection.addRange(range);
            }

            // 插入图片标签
            range.deleteContents();
            range.insertNode(imageTag);

            // 移动光标到图片标签后面
            const newRange = document.createRange();
            newRange.setStartAfter(imageTag);
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);

            // 触发输入事件以调整高度
            messageInput.dispatchEvent(new Event('input'));
        }
    } else if (event.data.type === 'FOCUS_INPUT') {
        messageInput.focus();
        const range = document.createRange();
        range.selectNodeContents(messageInput);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    } else if (event.data.type === 'UPDATE_PLACEHOLDER') {
        setPlaceholder({
            messageInput,
            placeholder: event.data.placeholder,
            timeout: event.data.timeout
        });
    } else if (event.data.type === 'NEW_CHAT') {
        // 模拟点击新对话按钮
        newChatButton.click();
        messageInput.focus();
    }
}