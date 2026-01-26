/**
 * 消息输入组件
 * 处理用户输入、粘贴、拖放图片等交互
 */

import { adjustTextareaHeight, createImageTag, showToast } from '../utils/ui.js';
import { handleImageDrop, readImageFileAsDataUrl } from '../utils/image.js';
import { syncChatBottomExtraPadding } from '../utils/scroll.js';
import { t } from '../utils/i18n.js';

// 跟踪输入法状态
let isComposing = false;

function initAnimatedFakeCaret(messageInput) {
    if (!messageInput?.isConnected) return;
    if (messageInput.__cerebrFakeCaretInited) return;

    const shell = messageInput.closest?.('.message-input-shell');
    const caretEl = shell?.querySelector?.('.fake-caret');
    if (!shell || !caretEl) return;

    messageInput.__cerebrFakeCaretInited = true;
    shell.classList.add('fake-caret-enabled');

    let rafId = 0;
    let pendingForceScrollIntoView = false;

    const scheduleUpdate = (options) => {
        if (options?.forceScrollIntoView) pendingForceScrollIntoView = true;
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
            rafId = 0;
            const shouldForceScrollIntoView = pendingForceScrollIntoView;
            pendingForceScrollIntoView = false;
            update({ forceScrollIntoView: shouldForceScrollIntoView });
        });
    };

    const update = ({ forceScrollIntoView } = {}) => {
        if (!messageInput?.isConnected) return;

        const focused = document.activeElement === messageInput;
        const selection = window.getSelection?.();
        if (!focused || !selection || selection.rangeCount === 0) {
            shell.classList.remove('fake-caret-visible');
            return;
        }

        const range = selection.getRangeAt(0);
        if (!range?.collapsed || !messageInput.contains(range.startContainer)) {
            shell.classList.remove('fake-caret-visible');
            return;
        }

        const shellRect = shell.getBoundingClientRect();
        const inputRect = messageInput.getBoundingClientRect();
        const style = window.getComputedStyle(messageInput);
        const paddingLeft = parseFloat(style.paddingLeft) || 0;
        const paddingTop = parseFloat(style.paddingTop) || 0;
        const paddingRight = parseFloat(style.paddingRight) || 0;
        const paddingBottom = parseFloat(style.paddingBottom) || 0;
        const fontSize = parseFloat(style.fontSize) || 14;
        const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.5;

        const getRangeRect = () => {
            try {
                const rects = range.getClientRects?.();
                if (rects && rects.length) return rects[rects.length - 1];
            } catch {
                // ignore
            }

            try {
                const rect = range.getBoundingClientRect?.();
                if (rect && (rect.width || rect.height)) return rect;
            } catch {
                // ignore
            }

            // 某些情况下（例如 Shift+Enter 创建空行）折叠 range 可能拿不到任何 rect，
            // 用“探针节点”临时测量 caret 的可视位置，避免假光标回到首行。
            try {
                if (isComposing) return null;

                const marker = document.createElement('span');
                marker.setAttribute('data-cerebr-caret-probe', '1');
                marker.style.cssText = [
                    'display:inline-block',
                    'width:0',
                    'padding:0',
                    'margin:0',
                    'border:0',
                    'overflow:hidden',
                    'pointer-events:none',
                    'user-select:none',
                    'vertical-align:baseline'
                ].join(';');
                marker.textContent = '\u200b';

                const probeRange = range.cloneRange();
                probeRange.collapse(true);
                probeRange.insertNode(marker);
                try {
                    return marker.getBoundingClientRect?.() || null;
                } finally {
                    marker.remove();
                }
            } catch {
                return null;
            }
        };

        const rect = getRangeRect();
        const isEmptyInput = (messageInput.textContent || '').trim() === '' && !messageInput.querySelector?.('.image-tag');

        let viewportX;
        let viewportY;
        let caretH;
        let caretVisualH;
        let caretYOffset;

        if (isEmptyInput) {
            viewportX = inputRect.left + paddingLeft;
            viewportY = inputRect.top + paddingTop;
            caretH = lineHeight;
        } else if (!rect || (!rect.width && !rect.height)) {
            shell.classList.remove('fake-caret-visible');
            return;
        } else {
            viewportX = rect.left;
            viewportY = rect.top;
            caretH = rect.height || lineHeight;
        }

        // 视觉上 caret 更贴近“字形高度”（通常略小于 font-size），避免看起来比文本更高。
        const approxGlyphHeight = Math.max(8, Math.round(fontSize * 1.12));
        caretVisualH = Math.max(8, Math.min(caretH, approxGlyphHeight));
        caretYOffset = Math.max(0, (caretH - caretVisualH) / 2);
        viewportY += caretYOffset;

        const viewportTop = inputRect.top + paddingTop;
        const viewportBottom = inputRect.bottom - paddingBottom;
        const caretTop = viewportY;
        const caretBottom = viewportY + caretVisualH;

        if (forceScrollIntoView && messageInput.scrollHeight > messageInput.clientHeight + 1) {
            const desiredMargin = Math.min(12, Math.max(4, Math.round(fontSize * 0.4)));
            const viewportHeight = viewportBottom - viewportTop;
            const effectiveMargin = Math.max(0, Math.min(desiredMargin, (viewportHeight - caretVisualH) / 2));
            let delta = 0;

            if (caretTop < viewportTop + effectiveMargin) {
                delta = caretTop - (viewportTop + effectiveMargin);
            } else if (caretBottom > viewportBottom - effectiveMargin) {
                delta = caretBottom - (viewportBottom - effectiveMargin);
            }

            if (Math.abs(delta) >= 1) {
                const prevScrollTop = messageInput.scrollTop;
                messageInput.scrollTop += delta;
                if (messageInput.scrollTop !== prevScrollTop) {
                    scheduleUpdate({ forceScrollIntoView: true });
                    return;
                }
            }
        }

        const viewportTolerance = 1;
        if (caretTop < viewportTop - viewportTolerance || caretBottom > viewportBottom + viewportTolerance) {
            shell.classList.remove('fake-caret-visible');
            return;
        }

        const minX = inputRect.left + paddingLeft;
        const maxX = inputRect.right - paddingRight;
        const minY = inputRect.top + paddingTop;
        const maxY = inputRect.bottom - paddingBottom - caretVisualH;

        const clampedViewportX = Math.max(minX, Math.min(viewportX, maxX));
        const clampedViewportY = Math.max(minY, Math.min(viewportY, maxY));

        const x = clampedViewportX - shellRect.left;
        const y = clampedViewportY - shellRect.top;

        caretEl.style.setProperty('--cerebr-fake-caret-x', `${x}px`);
        caretEl.style.setProperty('--cerebr-fake-caret-y', `${y}px`);
        caretEl.style.setProperty('--cerebr-fake-caret-h', `${caretVisualH}px`);

        shell.classList.add('fake-caret-visible');
    };

    document.addEventListener('selectionchange', scheduleUpdate);
    window.addEventListener('resize', scheduleUpdate);

    messageInput.addEventListener('focus', () => scheduleUpdate({ forceScrollIntoView: true }));
    messageInput.addEventListener('blur', scheduleUpdate);
    messageInput.addEventListener('scroll', scheduleUpdate);
    messageInput.addEventListener('input', () => scheduleUpdate({ forceScrollIntoView: true }));
    messageInput.addEventListener('keydown', (e) => {
        if (
            e?.key === 'ArrowUp' ||
            e?.key === 'ArrowDown' ||
            e?.key === 'ArrowLeft' ||
            e?.key === 'ArrowRight' ||
            e?.key === 'Home' ||
            e?.key === 'End' ||
            e?.key === 'PageUp' ||
            e?.key === 'PageDown'
        ) {
            scheduleUpdate({ forceScrollIntoView: true });
            return;
        }
        scheduleUpdate();
    });
    messageInput.addEventListener('keyup', scheduleUpdate);
    messageInput.addEventListener('mousedown', scheduleUpdate);
    messageInput.addEventListener('mouseup', scheduleUpdate);
    messageInput.addEventListener('compositionstart', scheduleUpdate);
    messageInput.addEventListener('compositionend', scheduleUpdate);

    scheduleUpdate();
}

function isInputEffectivelyEmpty(messageInput) {
    const hasImages = !!messageInput.querySelector?.('.image-tag');
    const text = (messageInput.textContent || '').trim();
    return !hasImages && !text;
}

function insertPlainTextAtSelection(messageInput, text) {
    if (!messageInput) return;
    if (!text) return;

    messageInput.focus();

    const selection = window.getSelection();
    let range;
    if (selection.rangeCount > 0) {
        range = selection.getRangeAt(0);
    } else {
        range = document.createRange();
        range.selectNodeContents(messageInput);
        range.collapse(false);
    }

    if (!messageInput.contains(range.startContainer)) {
        range.selectNodeContents(messageInput);
        range.collapse(false);
    }

    range.deleteContents();

    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    const fragment = document.createDocumentFragment();
    let lastNode = null;

    lines.forEach((line, index) => {
        if (line) {
            lastNode = document.createTextNode(line);
            fragment.appendChild(lastNode);
        }
        if (index < lines.length - 1) {
            lastNode = document.createElement('br');
            fragment.appendChild(lastNode);
        }
    });

    range.insertNode(fragment);

    if (lastNode) {
        const newRange = document.createRange();
        newRange.setStartAfter(lastNode);
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
    }
}

function ensureSelectionInInput(messageInput) {
    if (!messageInput) return;
    messageInput.focus();

    const selection = window.getSelection();
    if (!selection) return;

    if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        if (messageInput.contains(range.startContainer)) {
            return;
        }
    }

    const range = document.createRange();
    range.selectNodeContents(messageInput);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
}

function execCommandInsertText(messageInput, text) {
    try {
        ensureSelectionInInput(messageInput);
        // `execCommand` 已废弃，但在 contenteditable 中仍然是最稳的“进入原生撤销栈”的方式之一。
        return document.execCommand('insertText', false, text);
    } catch {
        return false;
    }
}

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

    const isFinePointer = () => {
        try {
            return window.matchMedia('(any-pointer: fine)').matches || window.matchMedia('(pointer: fine)').matches;
        } catch {
            return false;
        }
    };

    let sendQueued = false;
    let suppressNextInput = false;
    let lastEnterKeydownAt = 0;
    let lastEnterKeydownWasShift = false;
    const ENTER_SHIFT_WINDOW_MS = 400;
    const LARGE_TEXT_PASTE_THRESHOLD = 10000;
    let largePasteModeUntil = 0;
    let ignoreEnterSendUntil = 0;

    const ignoreEnterSendFor = (ms) => {
        ignoreEnterSendUntil = Math.max(ignoreEnterSendUntil, performance.now() + ms);
    };

    const shouldIgnoreEnterSend = () => performance.now() < ignoreEnterSendUntil;

    let layoutUpdateRaf = 0;
    let postLargePasteLayoutTimer = 0;
    const clearEditableContent = (element) => {
        if (!element) return;
        try {
            element.replaceChildren();
        } catch {
            element.innerHTML = '';
        }
    };

    const fastClearMessageInput = () => {
        clearEditableContent(messageInput);
        scheduleLayoutUpdate();
        try {
            messageInput.focus?.();
        } catch {
            // ignore
        }
    };

    const schedulePostLargePasteLayoutUpdate = () => {
        if (postLargePasteLayoutTimer) return;
        const now = performance.now();
        const delayMs = Math.max(0, Math.ceil(largePasteModeUntil - now) + 50);
        postLargePasteLayoutTimer = setTimeout(() => {
            postLargePasteLayoutTimer = 0;
            scheduleLayoutUpdate();
        }, delayMs);
    };
    const scheduleLayoutUpdate = () => {
        if (layoutUpdateRaf) return;
        layoutUpdateRaf = requestAnimationFrame(() => {
            layoutUpdateRaf = 0;
            if (!messageInput?.isConnected) return;
            const inLargePasteMode = performance.now() < largePasteModeUntil;
            if (inLargePasteMode) {
                const maxHeight = uiConfig?.textarea?.maxHeight ?? 200;
                messageInput.style.height = `${maxHeight}px`;
                messageInput.style.overflowY = 'auto';
                schedulePostLargePasteLayoutUpdate();
                return;
            }

            adjustTextareaHeight({ textarea: messageInput, config: uiConfig.textarea });
            syncChatBottomExtraPadding();
        });
    };

    const isEnterLikeInputEvent = (event) => {
        const inputType = event?.inputType;
        if (inputType === 'insertParagraph' || inputType === 'insertLineBreak') return true;
        if (inputType === 'insertText' && event?.data === '\n') return true;
        return false;
    };

    const isShiftEnter = () => {
        if (!lastEnterKeydownWasShift) return false;
        return Date.now() - lastEnterKeydownAt < ENTER_SHIFT_WINDOW_MS;
    };

    const execCommandUndo = () => {
        try {
            ensureSelectionInInput(messageInput);
            return document.execCommand('undo');
        } catch {
            return false;
        }
    };

    const removeTrailingLineBreakArtifacts = () => {
        let removed = false;
        while (messageInput.lastChild) {
            const node = messageInput.lastChild;
            if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.tagName;
                if (tag === 'BR') {
                    node.remove();
                    removed = true;
                    continue;
                }
                if (tag === 'DIV') {
                    const html = (node.innerHTML || '').replace(/\s+/g, '').toLowerCase();
                    const isEmptyDiv = html === '' || html === '<br>' || html === '<br/>';
                    if (isEmptyDiv) {
                        node.remove();
                        removed = true;
                        continue;
                    }
                }
            }
            break;
        }
        return removed;
    };

    const requestSendMessage = () => {
        if (sendQueued) return true;

        historyCursor = null;

        const text = messageInput.textContent.trim();
        if (!text && !messageInput.querySelector('.image-tag')) return false;

        setTimeout(() => {
            sendQueued = false;
            void sendMessage();
        }, 0);

        sendQueued = true;
        return true;
    };

    // 点击输入框时不触发全局点击逻辑（比如关闭菜单、失焦）
    messageInput.addEventListener('click', (e) => e.stopPropagation());

    // 全局点击：在合适场景下收起输入法（移动端更友好）
    document.body.addEventListener('click', (e) => {
        // 如果有文本被选中，不处理
        if (window.getSelection().toString()) return;

        // 桌面端：点击聊天区域时允许“聚焦输入框”的逻辑生效，不要在这里把焦点又 blur 掉
        if (isFinePointer() && e.target.closest('#chat-container')) {
            return;
        }

        // 排除点击设置按钮、设置菜单、上下文菜单、对话列表页面的情况
        if (e.target.closest('#settings-button') ||
            e.target.closest('#settings-menu') ||
            e.target.closest('#context-menu') ||
            e.target.closest('#chat-list-page')) {
            return;
        }

        // 点击输入区域之外时，如果当前在输入则收起键盘
        if (!e.target.closest('#input-container') && document.activeElement === messageInput) {
            messageInput.blur();
        }
    });

    // 监听输入框变化
    let historyCursor = null;
    let isHistoryNavigation = false;

    messageInput.addEventListener('input', function(e) {
        const normalizeHtml = (html) => String(html || '').replace(/\s+/g, '').toLowerCase();

        if (suppressNextInput) {
            suppressNextInput = false;
            return;
        }

        const inLargePasteMode = performance.now() < largePasteModeUntil;

        if (inLargePasteMode) {
            scheduleLayoutUpdate();
            if (!isHistoryNavigation) {
                historyCursor = null;
            }
            return;
        }

        const currHtml = this.innerHTML;
        const normalizedTail = normalizeHtml(currHtml.slice(-80));
        const inputType = e?.inputType || '';
        const isDeleteInput = typeof inputType === 'string' && inputType.startsWith('delete');
        const isPasteLikeInput =
            inputType === 'insertFromPaste' ||
            inputType === 'insertFromDrop' ||
            inputType === 'insertReplacementText';
        const hasTrailingBreakArtifact =
            normalizedTail.endsWith('<div><br></div>') ||
            normalizedTail.endsWith('<br>') ||
            normalizedTail.endsWith('<br/>');
        const recentEnterKeydown =
            !!lastEnterKeydownAt &&
            !lastEnterKeydownWasShift &&
            Date.now() - lastEnterKeydownAt < 600;
        const looksLikeEnterInsert =
            isEnterLikeInputEvent(e) ||
            (!isDeleteInput && !isPasteLikeInput && recentEnterKeydown && hasTrailingBreakArtifact);

        if (!isComposing && looksLikeEnterInsert && !isShiftEnter() && !shouldIgnoreEnterSend()) {
            const removed = removeTrailingLineBreakArtifacts();
            const hadUndo = removed ? false : execCommandUndo();
            if (hadUndo) suppressNextInput = true;

            requestSendMessage();

            scheduleLayoutUpdate();

            // 用户主动输入会退出历史回溯模式
            if (!isHistoryNavigation) {
                historyCursor = null;
            }

            // 处理 placeholder 的显示
            if (this.textContent.trim() === '' && !this.querySelector('.image-tag')) {
                clearEditableContent(this);
            }
            return;
        }

        scheduleLayoutUpdate();

        // 用户主动输入会退出历史回溯模式
        if (!isHistoryNavigation) {
            historyCursor = null;
        }

        // 如果正在使用输入法，则不处理 placeholder
        if (isComposing) {
            return;
        }

        // 处理 placeholder 的显示
        if (this.textContent.trim() === '' && !this.querySelector('.image-tag')) {
            // 如果内容空且没有图片标签，清空内容以显示 placeholder
            clearEditableContent(this);
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

    });

    // 处理换行和输入
    messageInput.addEventListener('compositionstart', () => {
        isComposing = true;
    });

    messageInput.addEventListener('compositionend', () => {
        isComposing = false;
    });

    messageInput.addEventListener('beforeinput', (e) => {
        if (isComposing) return;

        if (e?.inputType && e.inputType.startsWith('delete')) {
            try {
                const selection = window.getSelection();
                if (selection?.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    const hasSelection = range && !range.collapsed;
                    if (hasSelection && messageInput.contains(range.commonAncestorContainer)) {
                        const fullRange = document.createRange();
                        fullRange.selectNodeContents(messageInput);
                        const isFullSelection =
                            range.compareBoundaryPoints(Range.START_TO_START, fullRange) === 0 &&
                            range.compareBoundaryPoints(Range.END_TO_END, fullRange) === 0;
                        if (isFullSelection && (messageInput.textContent || '').length >= LARGE_TEXT_PASTE_THRESHOLD) {
                            if (e.cancelable) e.preventDefault();
                            fastClearMessageInput();
                            messageInput.dispatchEvent(new Event('input'));
                            return;
                        }
                    }
                }
            } catch {
                // ignore
            }
        }

        if (!isEnterLikeInputEvent(e)) return;
        if (isShiftEnter()) return;

        const htmlBefore = messageInput.innerHTML;

        if (e.cancelable) {
            e.preventDefault();
        }

        const queued = requestSendMessage();

        setTimeout(() => {
            if (!queued && messageInput.innerHTML !== htmlBefore) {
                messageInput.innerHTML = htmlBefore;
                if (isInputEffectivelyEmpty(messageInput)) {
                    messageInput.dispatchEvent(new Event('input'));
                }
            }
        }, 0);
    });

    messageInput.addEventListener('keydown', function(e) {
        const isEnter =
            e.key === 'Enter' ||
            e.code === 'Enter' ||
            e.keyCode === 13 ||
            e.which === 13;

        if (isEnter) {
            lastEnterKeydownAt = Date.now();
            lastEnterKeydownWasShift = !!e.shiftKey;
        }

        if (isEnter && !e.shiftKey) {
            if (isComposing) {
                // 如果正在使用输入法，不发送消息
                return;
            }
            e.preventDefault();
            requestSendMessage();
        } else if (e.key === 'Escape') {
            // 按 ESC 键时让输入框失去焦点
            messageInput.blur();
        } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
            // 空输入框：上下方向键循环历史问题；进入历史模式后继续可上下切换；向下到末尾回到空输入框
            const empty = isInputEffectivelyEmpty(e.target);

            // ArrowUp：仅在“空输入框”或“已在历史模式”时接管，避免影响多行编辑/光标移动
            if (e.key === 'ArrowUp' && userQuestions.length > 0 && (empty || historyCursor !== null)) {
                e.preventDefault();
                isHistoryNavigation = true;
                if (historyCursor === null) {
                    historyCursor = userQuestions.length - 1;
                } else {
                    historyCursor = Math.max(0, historyCursor - 1);
                }
                e.target.textContent = userQuestions[historyCursor] || '';
                e.target.dispatchEvent(new Event('input', { bubbles: true }));
                moveCaretToEnd(e.target);
                isHistoryNavigation = false;
                return;
            }

            // ArrowDown：仅在历史模式下接管
            if (e.key === 'ArrowDown' && historyCursor !== null) {
                e.preventDefault();
                isHistoryNavigation = true;
                if (historyCursor < userQuestions.length - 1) {
                    historyCursor += 1;
                    e.target.textContent = userQuestions[historyCursor] || '';
                } else {
                    historyCursor = null;
                    e.target.textContent = '';
                }
                e.target.dispatchEvent(new Event('input', { bubbles: true }));
                moveCaretToEnd(e.target);
                isHistoryNavigation = false;
                return;
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
        // 粘贴文本可能以换行结尾，这不应触发“回车发送”的逻辑
        ignoreEnterSendFor(200);

        const items = Array.from(e.clipboardData.items);
        const imageItem = items.find(item => item.type.startsWith('image/'));

        if (imageItem) {
            e.preventDefault(); // 阻止默认粘贴行为
            // 处理图片粘贴
            const file = imageItem.getAsFile();
            try {
                const base64Data = await readImageFileAsDataUrl(file);
                const imageTag = createImageTag({
                    base64Data,
                    fileName: file.name,
                    config: uiConfig.imageTag
                });

                // 在光标位置插入图片标签
                const selection = window.getSelection();
                const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : document.createRange();
                if (selection.rangeCount === 0) {
                    range.selectNodeContents(messageInput);
                    range.collapse(false);
                }
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
                    if (br.previousSibling?.classList?.contains('image-tag')) {
                        br.remove();
                    }
                });

                // 触发输入事件以调整高度
                messageInput.dispatchEvent(new Event('input'));
            } catch (error) {
                console.error('处理粘贴图片失败:', error);
                showToast(error?.message || t('toast_handle_image_failed'), { type: 'error' });
            }
        } else {
            // 处理文本粘贴
            const text = e.clipboardData.getData('text/plain');
            if (text) {
                if (text.length >= LARGE_TEXT_PASTE_THRESHOLD) {
                    e.preventDefault();
                    largePasteModeUntil = performance.now() + 2000;
                    setTimeout(() => {
                        insertPlainTextAtSelection(messageInput, text);
                        messageInput.dispatchEvent(new Event('input'));
                    }, 0);
                    return;
                }

                e.preventDefault();
                // 优先使用 execCommand 以确保进入原生撤销栈（Cmd/Ctrl+Z 能先撤销粘贴内容）
                const ok = execCommandInsertText(messageInput, text);
                if (!ok) {
                    insertPlainTextAtSelection(messageInput, text);
                }
                messageInput.dispatchEvent(new Event('input'));
            }
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
                showToast(error?.message || t('toast_handle_image_failed'), { type: 'error' });
            }
        });
    });

    // 初始化时同步一次，避免输入栏高度变化导致底部消息被遮挡
    initAnimatedFakeCaret(messageInput);
    syncChatBottomExtraPadding();
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
        messageInput.setAttribute('placeholder', placeholder);
        if (timeout) {
            setTimeout(() => {
                messageInput.setAttribute('placeholder', t('message_input_placeholder'));
            }, timeout);
        }
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
    syncChatBottomExtraPadding();
}

/**
 * 将光标移动到元素末尾
 * @param {HTMLElement} element - 要操作的元素
 */
export function moveCaretToEnd(element) {
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
        moveCaretToEnd(messageInput);
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
