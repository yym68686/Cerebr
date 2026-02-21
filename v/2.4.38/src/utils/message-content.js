/**
 * Convert markdown/HTML embedded data-url images into Chat Completions "content parts".
 *
 * Supported patterns:
 * - Markdown: ![alt](data:image/png;base64,....)
 * - HTML: <img src="data:image/png;base64,...." />
 *
 * @param {string} text
 * @returns {null | Array<{type: "text", text: string} | {type: "image_url", image_url: {url: string}}>}
 */
export function splitDataImageMarkdownIntoContentParts(text) {
    const input = String(text ?? '');
    if (!input) return null;

    /** @type {Array<{type: "text", text: string} | {type: "image_url", image_url: {url: string}}>} */
    const parts = [];

    const pushText = (segment) => {
        if (!segment) return;
        if (!String(segment).trim()) return;
        parts.push({ type: 'text', text: String(segment) });
    };

    const pushDataUrl = (prefix, base64) => {
        if (!prefix || !base64) return;
        const cleaned = String(base64).replace(/\s+/g, '');
        if (!cleaned) return;
        parts.push({ type: 'image_url', image_url: { url: `${prefix}${cleaned}` } });
    };

    // 1) Markdown images: ![alt](data:image/...;base64,AAAA "optional title")
    const mdRe = /!\[[^\]]*]\(\s*(data:image\/[A-Za-z0-9.+-]+;base64,)([A-Za-z0-9+/=_-\s]+?)\s*(?:"[^"]*"|'[^']*')?\s*\)/g;
    let lastIndex = 0;
    let matched = false;
    let match;
    while ((match = mdRe.exec(input)) !== null) {
        matched = true;
        const index = match.index;
        const raw = match[0] || '';
        const prefix = match[1] || '';
        const base64 = match[2] || '';

        pushText(input.slice(lastIndex, index));
        pushDataUrl(prefix, base64);
        lastIndex = index + raw.length;
    }

    if (matched) {
        pushText(input.slice(lastIndex));
        return parts.length ? parts : null;
    }

    // 2) HTML img tags with data url src
    const htmlRe = /<img\b[^>]*\bsrc\s*=\s*(?:"|')(data:image\/[A-Za-z0-9.+-]+;base64,)([A-Za-z0-9+/=_-\s]+)(?:"|')[^>]*>/gi;
    lastIndex = 0;
    matched = false;
    while ((match = htmlRe.exec(input)) !== null) {
        matched = true;
        const index = match.index;
        const raw = match[0] || '';
        const prefix = match[1] || '';
        const base64 = match[2] || '';

        pushText(input.slice(lastIndex, index));
        pushDataUrl(prefix, base64);
        lastIndex = index + raw.length;
    }

    if (matched) {
        pushText(input.slice(lastIndex));
        return parts.length ? parts : null;
    }

    return null;
}

/**
 * Normalize a message so that markdown data images are sent as image_url parts instead of plain text.
 * @param {{role?: string, content?: any}} message
 * @returns {{role?: string, content?: any}}
 */
export function normalizeMessageForChatCompletions(message) {
    const role = message?.role;
    const content = message?.content;
    if (!content || typeof content !== 'string') return message;
    if (role === 'system') return message;

    const parts = splitDataImageMarkdownIntoContentParts(content);
    if (!parts) return message;

    return { ...message, content: parts };
}
