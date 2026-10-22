import { captureImageTarget } from './draft-attachments.js';
import { addImageFilesToDraft, insertTextIntoMessageInput, appendDraftImage } from './native-editor.js';
import { handleImageDrop } from '../../utils/image.js';
import { showToast } from '../../utils/ui.js';
import { t } from '../../utils/i18n.js';

const PAGE_IMAGE = 'application/x-cerebr-page-image';
export function acceptsDrop(transfer) {
    const types = Array.from(transfer?.types || []);
    return (
        !!transfer?.files?.length ||
        types.includes('Files') ||
        types.includes(PAGE_IMAGE) ||
        types.includes('text/uri-list')
    );
}
const readText = (file) =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).replace(/^\uFEFF/, ''));
        reader.onerror = () => reject(reader.error || new Error(t('drop_read_failed')));
        reader.readAsText(file);
    });
export function attachFileDrop({ messageInput, uiConfig, onState = () => {}, enabled = () => true }) {
    const controller = new AbortController(),
        pending = new Map();
    const listen = (target, type, fn) => target.addEventListener(type, fn, { signal: controller.signal });
    let depth = 0,
        feedbackTimer,
        busy = 0,
        disposed = false;
    const set = (phase) => {
        clearTimeout(feedbackTimer);
        if (!disposed) onState(phase);
    };
    const finish = () => {
        if (--busy <= 0) {
            busy = 0;
            set(null);
        }
    };
    const fail = (error) => showToast(error?.message || t('drop_read_failed'), { type: 'error' });
    const focus = () => messageInput.focus({ preventScroll: true });
    listen(document, 'dragenter', (event) => {
        if (!enabled() || !acceptsDrop(event.dataTransfer)) return;
        event.preventDefault();
        depth++;
        set('ready');
    });
    listen(document, 'dragover', (event) => {
        if (!enabled() || !acceptsDrop(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        if (!busy) set('ready');
    });
    listen(document, 'dragleave', (event) => {
        if (!acceptsDrop(event.dataTransfer)) return;
        depth = Math.max(0, depth - 1);
        if (!depth || !event.relatedTarget) {
            clearTimeout(feedbackTimer);
            feedbackTimer = setTimeout(() => {
                if (!busy) onState(null);
            }, 70);
        }
    });
    listen(document, 'dragend', () => {
        depth = 0;
        if (!busy) set(null);
    });
    listen(document, 'drop', (event) => {
        if (!enabled()) return;
        const transfer = event.dataTransfer;
        if (!acceptsDrop(transfer)) return;
        event.preventDefault();
        event.stopPropagation();
        depth = 0;
        const current = captureImageTarget(messageInput);
        busy++;
        set('reading');
        const files = Array.from(transfer.files || []);
        if (Array.from(transfer.types || []).includes(PAGE_IMAGE)) {
            const requestId = crypto.randomUUID();
            const timer = setTimeout(() => {
                pending.delete(requestId);
                finish();
                fail(new Error(t('drop_read_failed')));
            }, 30000);
            pending.set(requestId, { current, timer });
            window.parent.postMessage({ type: 'CEREBR_DROP_PAGE_IMAGE', requestId }, '*');
            return;
        }
        void (async () => {
            if (files.length) {
                for (const file of files) {
                    if (!current()) break;
                    if (file.type.startsWith('image/'))
                        await addImageFilesToDraft(messageInput, [file], uiConfig);
                    else if (/\.txt$/i.test(file.name) || file.type === 'text/plain') {
                        if (file.size > 10 * 1024 * 1024) throw new Error(t('drop_text_too_large'));
                        const text = await readText(file);
                        if (current() && text.trim())
                            insertTextIntoMessageInput(messageInput, text, { separator: '\n\n' });
                    } else throw new Error(t('drop_unsupported'));
                }
            } else {
                await handleImageDrop(event, {
                    messageInput,
                    insertImage: (data) => {
                        if (current()) appendDraftImage(messageInput, data, uiConfig);
                    },
                    onError: fail,
                });
            }
            if (current()) focus();
        })()
            .catch(fail)
            .finally(finish);
    });
    listen(window, 'message', (event) => {
        if (event.source !== window.parent || event.data?.type !== 'CEREBR_DROP_PAGE_IMAGE_RESULT') return;
        const request = pending.get(event.data.requestId);
        if (!request) return;
        pending.delete(event.data.requestId);
        clearTimeout(request.timer);
        if (request.current()) {
            if (event.data.imageData?.data) {
                appendDraftImage(
                    messageInput,
                    { base64Data: event.data.imageData.data, fileName: event.data.imageData.name },
                    uiConfig
                );
                focus();
            } else fail(new Error(t('drop_read_failed')));
        }
        finish();
    });
    return () => {
        disposed = true;
        controller.abort();
        clearTimeout(feedbackTimer);
        for (const item of pending.values()) clearTimeout(item.timer);
    };
}
