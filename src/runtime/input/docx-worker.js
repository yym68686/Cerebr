import { extractDocxText } from './docx-parser.js';

self.onmessage = async ({ data: file }) => {
    try {
        const text = await extractDocxText(await file.arrayBuffer());
        self.postMessage({ text });
    } catch (error) {
        self.postMessage({ error: /^docx_/.test(error.message) ? error.message : 'docx_invalid' });
    }
};
