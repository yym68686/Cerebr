/**
 * 处理图片拖放的通用函数
 * @param {DragEvent} e - 拖放事件对象
 * @param {Object} config - 配置对象
 * @param {HTMLElement} config.messageInput - 消息输入框元素
 * @param {Function} config.createImageTag - 创建图片标签的函数
 * @param {Function} config.onSuccess - 成功处理后的回调函数
 * @param {Function} config.onError - 错误处理的回调函数
 */
export function handleImageDrop(e, config) {
    const {
        messageInput,
        createImageTag,
        onSuccess = () => {},
        onError = (error) => console.error('处理拖放事件失败:', error)
    } = config;

    e.preventDefault();
    e.stopPropagation();

    try {
        // 处理文件拖放
        if (e.dataTransfer.files.length > 0) {
            const file = e.dataTransfer.files[0];
            if (file.type.startsWith('image/')) {
                const reader = new FileReader();
                reader.onload = () => {
                    try {
                        insertImageToInput({
                            messageInput,
                            createImageTag,
                            imageData: {
                                base64Data: reader.result,
                                fileName: file.name
                            }
                        });
                        onSuccess();
                    } catch (error) {
                        onError(error);
                    }
                };
                reader.readAsDataURL(file);
                return;
            }
        }

        // 处理网页图片拖放
        const data = e.dataTransfer.getData('text/plain');
        if (data) {
            try {
                const imageData = JSON.parse(data);
                if (imageData.type === 'image') {
                    insertImageToInput({
                        messageInput,
                        createImageTag,
                        imageData: {
                            base64Data: imageData.data,
                            fileName: imageData.name
                        }
                    });
                    onSuccess();
                }
            } catch (error) {
                onError(error);
            }
        }
    } catch (error) {
        onError(error);
    }
}

/**
 * 在输入框中插入图片
 * @param {Object} params - 参数对象
 * @param {HTMLElement} params.messageInput - 消息输入框元素
 * @param {Function} params.createImageTag - 创建图片标签的函数
 * @param {Object} params.imageData - 图片数据
 * @param {string} params.imageData.base64Data - 图片的base64数据
 * @param {string} params.imageData.fileName - 图片文件名
 */
function insertImageToInput({ messageInput, createImageTag, imageData }) {
    const imageTag = createImageTag({
        base64Data: imageData.base64Data,
        fileName: imageData.fileName
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