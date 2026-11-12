import { captureImageTarget } from './draft-attachments.js';
import { appendDraftImage } from './native-editor.js';
import { handleImageDrop, readImageFileAsDataUrl } from '../../utils/image.js';
import { showToast } from '../../utils/ui.js';
import { t } from '../../utils/i18n.js';
import { addDraftFile } from './draft-files.js';
import { readDocx } from './docx-reader.js';
import { isDocx } from './docx-limits.js';
import { readPdf } from './pdf-reader.js';
import { isPdf } from './pdf-limits.js';
import { beginFileImport } from './file-import-state.js';

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
const readFile = (file, signal, pdf = false) =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        const abort = () => {
            reader.abort?.();
            reject(new DOMException('Aborted', 'AbortError'));
        };
        const finish = (error) => {
            signal.removeEventListener('abort', abort);
            if (error) reject(error);
            else resolve(String(reader.result).replace(/^\uFEFF/, ''));
        };
        reader.onload = () => finish();
        reader.onerror = () => finish(reader.error || new Error(t('drop_read_failed')));
        signal.addEventListener('abort', abort, { once: true });
        if (pdf) reader.readAsDataURL(file.slice(0, file.size, 'application/pdf'));
        else reader.readAsText(file);
    });
export async function addFilesToDraft(messageInput, files, uiConfig = {}) {
    const current = captureImageTarget(messageInput);
    // Reserve every attachment immediately, then read in order without launching
    // an unbounded number of document workers or reordering pasted images.
    const entries = Array.from(files, file => ({ file, task: beginFileImport(messageInput, file) }));
    let failure;
    for (const { file, task } of entries) {
        try {
            if (!current() || task.signal.aborted) continue;
            if (file.type.startsWith('image/')) {
                const base64Data = await readImageFileAsDataUrl(file, { signal: task.signal });
                if (current() && !task.signal.aborted) appendDraftImage(messageInput, { base64Data, fileName: file.name }, uiConfig);
                continue;
            }
            const docx = isDocx(file);
            const pdf = isPdf(file);
            let text;
            let originalPdf;
            if (docx) text = await readDocx(file, { signal: task.signal });
            else if (pdf) {
                text = await readPdf(file, { signal: task.signal });
                if (!current() || task.signal.aborted) continue;
                originalPdf = await readFile(file, task.signal, true);
            }
            else if (/\.txt$/i.test(file.name) || file.type === 'text/plain') {
                if (file.size > 10 * 1024 * 1024) throw new Error(t('drop_text_too_large'));
                text = await readFile(file, task.signal);
            } else throw new Error(t('drop_unsupported'));
            if (!current() || task.signal.aborted) continue;
            addDraftFile(messageInput, {
                name:
                    docx && !/\.docx$/i.test(file.name)
                        ? `${file.name}.docx`
                        : pdf && !/\.pdf$/i.test(file.name)
                          ? `${file.name}.pdf`
                          : file.name,
                text,
                size: file.size,
                ...(originalPdf ? { originalPdf } : {}),
            });
        } catch (error) {
            if (error.name !== 'AbortError') failure ||= error;
        } finally {
            task.finish();
        }
    }
    if (failure) throw failure;
}
export function attachFileDrop({ messageInput, uiConfig, onState = () => {}, enabled = () => true }) {
    const controller = new AbortController(),
        pending = new Map();
    const listen = (target, type, fn) => target.addEventListener(type, fn, { signal: controller.signal });
    let depth = 0,
        feedbackTimer,
        disposed = false;
    const set = (phase) => {
        clearTimeout(feedbackTimer);
        if (!disposed) onState(phase);
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
        set('ready');
    });
    listen(document, 'dragleave', (event) => {
        if (!acceptsDrop(event.dataTransfer)) return;
        depth = Math.max(0, depth - 1);
        if (!depth || !event.relatedTarget) {
            clearTimeout(feedbackTimer);
            feedbackTimer = setTimeout(() => {
                set(null);
            }, 70);
        }
    });
    listen(document, 'dragend', () => {
        depth = 0;
        set(null);
    });
    listen(document, 'drop', (event) => {
        if (!enabled()) return;
        const transfer = event.dataTransfer;
        if (!acceptsDrop(transfer)) return;
        event.preventDefault();
        event.stopPropagation();
        depth = 0;
        const current = captureImageTarget(messageInput);
        set(null);
        focus();
        const files = Array.from(transfer.files || []);
        if (Array.from(transfer.types || []).includes(PAGE_IMAGE)) {
            const requestId = crypto.randomUUID();
            const task = beginFileImport(messageInput, { name: t('label_image'), type: 'image/*' });
            const timer = setTimeout(() => {
                pending.delete(requestId);
                task.finish();
                if (current() && !task.signal.aborted) fail(new Error(t('drop_read_failed')));
            }, 30000);
            task.signal.addEventListener('abort', () => {
                clearTimeout(timer);
                pending.delete(requestId);
            }, { once: true });
            pending.set(requestId, { current, timer, task });
            window.parent.postMessage({ type: 'CEREBR_DROP_PAGE_IMAGE', requestId }, '*');
            return;
        }
        void (async () => {
            if (files.length) {
                await addFilesToDraft(messageInput, files, uiConfig);
            } else {
                const task = beginFileImport(messageInput, { name: t('label_image'), type: 'image/*' });
                try {
                    await handleImageDrop(event, {
                        messageInput,
                        signal: task.signal,
                        insertImage: (data) => {
                            if (current() && !task.signal.aborted) appendDraftImage(messageInput, data, uiConfig);
                        },
                        onError: error => { if (current() && !task.signal.aborted) fail(error); },
                    });
                } finally { task.finish(); }
            }
        })()
            .catch(error => { if (current()) fail(error); });
    });
    listen(window, 'message', (event) => {
        if (event.source !== window.parent || event.data?.type !== 'CEREBR_DROP_PAGE_IMAGE_RESULT') return;
        const request = pending.get(event.data.requestId);
        if (!request) return;
        pending.delete(event.data.requestId);
        clearTimeout(request.timer);
        if (request.current() && !request.task.signal.aborted) {
            if (event.data.imageData?.data) {
                appendDraftImage(
                    messageInput,
                    { base64Data: event.data.imageData.data, fileName: event.data.imageData.name },
                    uiConfig
                );
            } else fail(new Error(t('drop_read_failed')));
        }
        request.task.finish();
    });
    return () => {
        disposed = true;
        controller.abort();
        clearTimeout(feedbackTimer);
        for (const item of pending.values()) { clearTimeout(item.timer); item.task.cancel(); }
        pending.clear();
    };
}
