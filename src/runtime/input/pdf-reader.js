import { t } from '../../utils/i18n.js';
import { appAssetUrl } from '../../platform/assets.js';
import { PDF_MAX_BYTES, PDF_TIMEOUT_MS } from './pdf-limits.js';

export function readPdf(file, { signal } = {}) {
    if (file.size > PDF_MAX_BYTES) return Promise.reject(new Error(t('pdf_too_large')));
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        const worker = new Worker(new URL('./pdf-worker.js', import.meta.url), { type: 'module' });
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
        timer = setTimeout(() => finish(new Error(t('pdf_timeout'))), PDF_TIMEOUT_MS);
        worker.onmessage = ({ data }) => {
            // PDF.js may emit its own transport-ready notification on import.
            if (data?.type !== 'cerebr:pdf-result') return;
            if (data?.error) finish(new Error(t(data.error)));
            else if (typeof data?.text !== 'string' || !data.text.trim()) finish(new Error(t('pdf_empty')));
            else finish(null, data.text);
        };
        worker.onerror = (event) => {
            event.preventDefault();
            finish(new Error(t('pdf_invalid')));
        };
        worker.onmessageerror = () => finish(new Error(t('pdf_invalid')));
        try {
            worker.postMessage({
                file,
                assetBase: appAssetUrl(import.meta.env.DEV ? 'node_modules/pdfjs-dist/' : 'lib/pdfjs/'),
            });
        } catch {
            finish(new Error(t('pdf_invalid')));
        }
    });
}
