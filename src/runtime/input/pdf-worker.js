import { extractPdfText } from './pdf-parser.js';

self.onmessage = async ({ data: { file, assetBase } }) => {
    try {
        const text = await extractPdfText(await file.arrayBuffer(), { assetBase });
        self.postMessage({ type: 'cerebr:pdf-result', text });
    } catch (error) {
        self.postMessage({
            type: 'cerebr:pdf-result',
            error: /^pdf_/.test(error.message) ? error.message : 'pdf_invalid',
        });
    }
};
