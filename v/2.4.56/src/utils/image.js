/**
 * 处理图片拖放的通用函数
 * @param {DragEvent} e - 拖放事件对象
 * @param {Object} config - 配置对象
 * @param {HTMLElement} config.messageInput - 消息输入框元素
 * @param {Function} config.createImageTag - 创建图片标签的函数
 * @param {Function} config.onSuccess - 成功处理后的回调函数
 * @param {Function} config.onError - 错误处理的回调函数
 */
import { t } from './i18n.js';

export async function handleImageDrop(e, config) {
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
                try {
                    const base64Data = await readImageFileAsDataUrl(file);
                    insertImageToInput({
                        messageInput,
                        createImageTag,
                        imageData: {
                            base64Data,
                            fileName: file.name
                        }
                    });
                    onSuccess();
                } catch (error) {
                    onError(error);
                }
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

function estimateDataUrlBytes(dataUrl) {
    if (typeof dataUrl !== 'string') return 0;
    const commaIndex = dataUrl.indexOf(',');
    if (commaIndex === -1) return 0;
    const base64 = dataUrl.slice(commaIndex + 1);
    // base64 length -> bytes (rough)
    return Math.floor((base64.length * 3) / 4);
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error(t('error_read_image_failed')));
        reader.readAsDataURL(file);
    });
}

function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(t('error_parse_image_failed')));
        img.src = dataUrl;
    });
}

/**
 * 将图片文件读取为 dataURL，并在较大时做降采样压缩，避免传输/渲染卡顿。
 * @param {File} file
 * @param {Object} [options]
 * @param {number} [options.maxBytes=3500000] - 目标最大字节数（近似）
 * @param {number} [options.maxDimension=1600] - 最大边长
 * @param {number} [options.maxPixels=2600000] - 最大像素数（约 2.6MP）
 * @returns {Promise<string>} dataURL
 */
export async function readImageFileAsDataUrl(
    file,
    { maxBytes = 3_500_000, maxDimension = 1600, maxPixels = 2_600_000 } = {}
) {
    if (!file || !file.type?.startsWith('image/')) {
        throw new Error(t('error_not_image_file'));
    }

    const originalDataUrl = await readFileAsDataUrl(file);
    if (file.size <= maxBytes) return originalDataUrl;

    const img = await loadImage(originalDataUrl);
    const srcWidth = img.naturalWidth || img.width;
    const srcHeight = img.naturalHeight || img.height;
    if (!srcWidth || !srcHeight) return originalDataUrl;

    let scale = 1;
    const maxSide = Math.max(srcWidth, srcHeight);
    if (maxSide > maxDimension) {
        scale = Math.min(scale, maxDimension / maxSide);
    }
    const pixels = srcWidth * srcHeight;
    if (pixels > maxPixels) {
        scale = Math.min(scale, Math.sqrt(maxPixels / pixels));
    }

    if (scale >= 0.999) {
        // 仅文件较大但像素不大：尝试压 jpeg
        scale = 1;
    }

    const targetWidth = Math.max(1, Math.round(srcWidth * scale));
    const targetHeight = Math.max(1, Math.round(srcHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return originalDataUrl;

    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

    // 逐步降低质量，直到接近目标大小（或达到下限）
    const mimeType = 'image/jpeg';
    let quality = 0.86;
    let optimized = canvas.toDataURL(mimeType, quality);
    for (let i = 0; i < 3 && estimateDataUrlBytes(optimized) > maxBytes && quality > 0.62; i++) {
        quality -= 0.1;
        optimized = canvas.toDataURL(mimeType, quality);
    }

    // 如果仍然过大，拒绝插入（避免后续发送必然失败）
    const optimizedBytes = estimateDataUrlBytes(optimized);
    if (optimizedBytes > Math.max(maxBytes * 1.8, 8_000_000)) {
        throw new Error(t('error_image_too_large'));
    }

    return optimizedBytes <= estimateDataUrlBytes(originalDataUrl) ? optimized : originalDataUrl;
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
