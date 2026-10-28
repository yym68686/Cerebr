export const DOCX_MAX_BYTES = 10 * 1024 * 1024;
export const DOCX_MAX_TEXT = 100_000;
export const DOCX_TOTAL_TEXT = 200_000;
export const DOCX_TIMEOUT_MS = 30_000;
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const isDocx = (file) => /\.docx$/i.test(file.name || '') || file.type === DOCX_MIME;
