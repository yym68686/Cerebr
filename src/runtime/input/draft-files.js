const drafts = new WeakMap();
const EMPTY = Object.freeze([]);

export const getDraftFiles = (input) => drafts.get(input) || EMPTY;
export const normalizeTextFiles = (files) => Array.isArray(files)
    ? files.filter(file => file && typeof file.name === 'string' && typeof file.text === 'string')
        .map(file => ({ id: file.id || crypto.randomUUID(), name: file.name,
            size: Number.isFinite(file.size) ? file.size : new TextEncoder().encode(file.text).length,
            text: file.text }))
    : [];

export function setDraftFiles(input, files, emit = true) {
    drafts.set(input, normalizeTextFiles(files));
    if (emit) input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function addDraftFile(input, file) {
    setDraftFiles(input, [...getDraftFiles(input), file]);
}

const fileHeader = (file) => `--- ${file.name} ---\n`;
const fileFooter = '\n---\n\n';
export function withTextFiles(text, files = []) {
    return files.map(file => `${fileHeader(file)}${file.text}${fileFooter}`).join('') + text;
}

// Text is stored once, in ordinary API-compatible message content. The small
// descriptors let newer clients recover attachment chips without rendering a
// multi-megabyte file as Markdown; older clients can still read the content.
export const textFileMetadata = (files = []) => files.map(({ id, name, size, text }) =>
    ({ id, name, size, textLength: text.length }));

export function splitTextFileMessage(message) {
    const content = message.content;
    const text = Array.isArray(content)
        ? content.filter(part => part.type === 'text').map(part => part.text || '').join('\n')
        : String(content || '');
    const files = [];
    let offset = 0;
    for (const file of Array.isArray(message.textFiles) ? message.textFiles : []) {
        if (!file || typeof file.name !== 'string' || !Number.isSafeInteger(file.textLength) || file.textLength < 0)
            return { content, files: [] };
        const header = fileHeader(file), start = offset + header.length, end = start + file.textLength;
        if (!text.startsWith(header, offset) || !text.startsWith(fileFooter, end))
            return { content, files: [] };
        files.push({ id: file.id, name: file.name, size: file.size, text: text.slice(start, end) });
        offset = end + fileFooter.length;
    }
    if (!files.length) return { content, files };
    const question = text.slice(offset);
    return { files, content: Array.isArray(content)
        ? [{ type: 'text', text: question }, ...content.filter(part => part.type !== 'text')]
        : question };
}
