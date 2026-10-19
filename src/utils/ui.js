/**
 * 输入框配置接口
 * @typedef {Object} TextareaConfig
 * @property {number} maxHeight - 输入框最大高度
 */

import { t } from './i18n.js';
import { uiStore, notify } from '../app/state/ui-store.js';

/**
 * 图片预览配置接口
 * @property {HTMLElement} previewModal - 预览模态框元素
 * @property {HTMLElement} previewImage - 预览图片元素
 */

/**
 * 图片标签配置接口
 * @typedef {Object} ImageTagConfig
 * @property {function} onImageClick - 图片点击回调
 * @property {function} onDeleteClick - 删除按钮点击回调
 */

/**
 * 调整输入框高度
 * @param {Object} params - 参数对象
 * @param {HTMLElement} params.textarea - 输入框元素
 * @param {TextareaConfig} params.config - 输入框配置
 */
export function adjustTextareaHeight({
    textarea,
    config = { maxHeight: 200 }
}) {
    textarea.style.height = 'auto';
    // Browsers can retain empty <br>/<div> nodes after deletion or undo. They
    // must not keep a visually empty editor taller than one line.
    const empty = !(textarea.textContent || '').trim() && !textarea.querySelector('.image-tag');
    let height = textarea.scrollHeight;
    if (empty) {
        const style = getComputedStyle(textarea);
        height = Math.max(
            parseFloat(style.minHeight) || 0,
            (parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 14) * 1.5) +
                (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
        );
    }
    textarea.style.height = Math.min(height, config.maxHeight) + 'px';
    // CSS also caps the editor against the visual viewport when the keyboard is open.
    if (!empty && textarea.scrollHeight > textarea.clientHeight + 1) {
        textarea.style.overflowY = 'auto';
    } else {
        textarea.style.overflowY = 'hidden';
    }
}

/**
 * 显示图片预览
 * @param {Object} params - 参数对象
 * @param {string} params.base64Data - 图片base64数据
 */
export function showImagePreview({ base64Data }) {
    uiStore.set({ image: base64Data });
}
export function hideImagePreview() { uiStore.set({ image: null }); }

/**
 * 创建图片标签
 * @param {Object} params - 参数对象
 * @param {string} params.base64Data - 图片base64数据
 * @param {string} [params.fileName] - 文件名（可选）
 * @param {ImageTagConfig} params.config - 图片标签配置
 * @returns {HTMLElement} 创建的图片标签元素
 */
export function createImageTag({
    base64Data,
    fileName = null,
    config = {}
}) {
    const resolvedFileName = fileName || t('label_image');
    const safeConfig = config || {};
    if (!safeConfig.onDeleteClick) {
        safeConfig.onDeleteClick = (container) => {
            try {
                container.remove();
                const input = container.closest?.('#message-input');
                input?.dispatchEvent?.(new Event('input', { bubbles: true }));
            } catch {
                // ignore
            }
        };
    }
    const container = document.createElement('span');
    container.className = 'image-tag';
    container.contentEditable = false;
    container.setAttribute('data-image', base64Data);
    container.title = resolvedFileName;

    const thumbnail = document.createElement('img');
    thumbnail.src = base64Data.startsWith('data:') ? base64Data : `data:image/png;base64,${base64Data}`;
    thumbnail.alt = resolvedFileName;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-linecap="round"/></svg>';
    deleteBtn.title = t('label_delete_image');
    deleteBtn.type = 'button';
    deleteBtn.setAttribute('aria-label', `${t('label_delete_image')}: ${resolvedFileName}`);

    // 点击删除按钮时删除整个标签
    deleteBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (safeConfig.onDeleteClick) {
            safeConfig.onDeleteClick(container);
        }
    });

    if (safeConfig.attachment) {
        container.classList.add('composer-attachment');
        const preview = document.createElement('button');
        preview.type = 'button';
        preview.className = 'composer-attachment__preview';
        preview.setAttribute('aria-label', `${t('label_image')}: ${resolvedFileName}`);
        preview.append(thumbnail);
        const name = document.createElement('span');
        name.className = 'composer-attachment__name';
        name.textContent = resolvedFileName;
        preview.append(name);
        preview.addEventListener('click', (event) => {
            if (event.target !== thumbnail) safeConfig.onImageClick?.(base64Data);
        });
        container.append(preview);
    } else {
        container.appendChild(thumbnail);
    }
    container.appendChild(deleteBtn);

    // 点击图片区域预览图片
    thumbnail.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (safeConfig.onImageClick) {
            safeConfig.onImageClick(base64Data);
        }
    });

    return container;
}

export function showToast(message, options) { return notify(message, options); }
