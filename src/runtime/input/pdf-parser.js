import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { PDF_MAX_BYTES, PDF_MAX_PAGES } from './pdf-limits.js';

// PDF.js uses its in-process transport inside our dedicated, terminable Worker.
// No nested worker, blob script, CDN or main-thread parsing fallback is needed.
globalThis.pdfjsWorker = { WorkerMessageHandler };

const fail = (code) => {
    throw new Error(code);
};

export async function extractPdfText(buffer, { assetBase = '' } = {}) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length > PDF_MAX_BYTES) fail('pdf_too_large');
    if (bytes.length < 5 || !new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-'))
        fail('pdf_invalid');
    const loading = getDocument({
        data: bytes,
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: false,
        useWorkerFetch: true,
        useWasm: false,
        isOffscreenCanvasSupported: false,
        isImageDecoderSupported: false,
        stopAtErrors: true,
        verbosity: 0,
        ...(assetBase
            ? {
                  cMapUrl: `${assetBase}cmaps/`,
                  cMapPacked: true,
                  standardFontDataUrl: `${assetBase}standard_fonts/`,
              }
            : {}),
    });
    try {
        const pdf = await loading.promise;
        if (pdf.numPages > PDF_MAX_PAGES) fail('pdf_too_many_pages');
        const pages = [];
        for (let number = 1; number <= pdf.numPages; number++) {
            const page = await pdf.getPage(number);
            const reader = page.streamTextContent().getReader();
            const parts = [];
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    for (const item of value.items) {
                        if (typeof item.str !== 'string') continue;
                        parts.push(item.str + (item.hasEOL ? '\n' : ''));
                    }
                }
            } finally {
                await reader.cancel(new Error('PDF text extraction finished')).catch(() => {});
                reader.releaseLock();
                page.cleanup();
            }
            pages.push(parts.join('').trim());
        }
        const text = pages.join('\n\n').trim();
        if (!text) fail('pdf_empty');
        return text;
    } catch (error) {
        if (error.name === 'PasswordException') fail('pdf_password');
        if (/^pdf_/.test(error.message)) throw error;
        fail('pdf_invalid');
    } finally {
        await loading.destroy();
    }
}
