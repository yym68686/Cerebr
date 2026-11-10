// Allowlist document fields: never expose private sync records or model settings.
export const SHARE_ID = /^[0-9a-f]{48}$/;

export function normalizeShareSnapshot(value) {
    const invalid = () => { throw new Error('share_invalid'); };
    const string = (text) => typeof text === 'string' ? text : invalid();
    const image = (url) => {
        string(url);
        if (!/^https?:\/\//i.test(url) && !/^data:image\/(?:png|jpeg|jpg|gif|webp|avif|bmp);base64,/i.test(url)) invalid();
        return url;
    };
    if (value?.version !== 1 || typeof value.chat?.title !== 'string' ||
        !Array.isArray(value.chat.messages) || !value.chat.messages.length || !Array.isArray(value.pages)) invalid();
    const messages = value.chat.messages.map((message) => {
        if (!message || !['user', 'assistant'].includes(message.role)) invalid();
        const content = Array.isArray(message.content) ? message.content.map((part) => {
            if (part?.type === 'text') return { type: 'text', text: string(part.text) };
            if (part?.type === 'image_url') return { type: 'image_url', image_url: { url: image(part.image_url?.url) } };
            return invalid();
        }) : string(message.content ?? '');
        const next = { role: message.role, content };
        if (typeof message.reasoning_content === 'string') next.reasoning_content = message.reasoning_content;
        if (Array.isArray(message.selectionQuotes)) next.selectionQuotes = message.selectionQuotes.map(string);
        if (typeof message.selectionQuestion === 'string') next.selectionQuestion = message.selectionQuestion;
        if (Array.isArray(message.textFiles)) next.textFiles = message.textFiles.map((file) => {
            if (!file || !Number.isSafeInteger(file.textLength) || file.textLength < 0 || !Number.isFinite(file.size) || file.size < 0) invalid();
            const attachment = { id: string(file.id), name: string(file.name), size: file.size, textLength: file.textLength };
            if (file.originalPdf !== undefined) {
                if (typeof file.originalPdf !== 'string' || !/^data:application\/pdf;base64,[A-Za-z0-9+/]*={0,2}$/.test(file.originalPdf)) invalid();
                attachment.originalPdf = file.originalPdf;
            }
            return attachment;
        });
        return next;
    });
    const pages = value.pages.map((page) => {
        if (!page || !/^https?:\/\//i.test(page.url)) invalid();
        const next = { url: string(page.url), title: string(page.title), content: string(page.content) };
        if (typeof page.sourceId === 'string') next.sourceId = page.sourceId;
        return next;
    });
    return { version: 1, chat: { title: value.chat.title, messages }, pages };
}
