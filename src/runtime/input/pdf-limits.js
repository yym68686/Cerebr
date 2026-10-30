export const PDF_MAX_BYTES = 10 * 1024 * 1024;
export const PDF_MAX_TEXT = 100_000;
export const PDF_MAX_PAGES = 500;
export const PDF_TIMEOUT_MS = 30_000;
export const isPdf = (file) => /\.pdf$/i.test(file.name || '') || file.type === 'application/pdf';
