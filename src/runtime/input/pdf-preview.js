import { getDocument, PDFWorker, TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { appAssetUrl } from '../../platform/assets.js';

export { TextLayer };

export function openPdfPreview(source) {
    const encoded = source.slice('data:application/pdf;base64,'.length);
    const decoded = atob(encoded);
    const data = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
    const port = new Worker(new URL('./pdf-preview-worker.js', import.meta.url), { type: 'module' });
    const worker = new PDFWorker({ port });
    const assetBase = appAssetUrl(import.meta.env.DEV ? 'node_modules/pdfjs-dist/' : 'lib/pdfjs/');
    const loading = getDocument({
        data,
        worker,
        isEvalSupported: false,
        useWasm: false,
        cMapUrl: `${assetBase}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${assetBase}standard_fonts/`,
        verbosity: 0,
    });
    return {
        promise: loading.promise,
        async destroy() {
            try {
                await loading.destroy();
            } finally {
                worker.destroy();
                port.terminate();
            }
        },
    };
}
