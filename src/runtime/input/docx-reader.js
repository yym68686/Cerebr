import { t } from '../../utils/i18n.js';
import { DOCX_MAX_BYTES, DOCX_TIMEOUT_MS } from './docx-limits.js';

export function readDocx(file, { signal } = {}) {
    if (file.size > DOCX_MAX_BYTES) return Promise.reject(new Error(t('docx_too_large')));
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        const worker = new Worker(new URL('./docx-worker.js', import.meta.url), { type: 'module' });
        let timer,
            settled = false;
        const finish = (error, text) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            worker.terminate();
            if (error) reject(error);
            else resolve(text);
        };
        const abort = () => finish(new DOMException('Aborted', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => finish(new Error(t('docx_timeout'))), DOCX_TIMEOUT_MS);
        worker.onmessage = ({ data }) => {
            if (data?.error) finish(new Error(t(data.error)));
            else if (typeof data?.text !== 'string' || !data.text.trim()) finish(new Error(t('docx_empty')));
            else finish(null, data.text);
        };
        worker.onerror = (event) => {
            event.preventDefault();
            finish(new Error(t('docx_invalid')));
        };
        worker.onmessageerror = () => finish(new Error(t('docx_invalid')));
        try {
            worker.postMessage(file);
        } catch {
            finish(new Error(t('docx_invalid')));
        }
    });
}
