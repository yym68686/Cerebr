function formatMessageTime(value, isoFormat) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    if (isoFormat) return date.toISOString();
    const pad = value => String(value).padStart(2, '0');
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} (${zone})`;
}

/** Keep a static system prefix. Time is tied to the stored user message, not each API round. */
export function applyAssistantMessageSettings(messages, settings = {}) {
    const profile = settings.kelivo || {};
    let source = Array.isArray(messages) ? messages : [];
    if (profile.limitContextMessages && Number(profile.contextMessageSize) > 0) {
        const count = Math.max(1, Math.floor(Number(profile.contextMessageSize)));
        let start = Math.max(0, source.length - count);
        // Never start a history slice with orphaned assistant/tool items.
        while (start > 0 && source[start]?.role !== 'user') start--;
        source = source.slice(start);
    }
    return source.map(message => {
        if (message?.role !== 'user') return message;
        const template = profile.messageTemplate || '{{ message }}';
        const time = profile.appendCurrentTimeToUserMessage
            ? formatMessageTime(message.createdAt, profile.useIso8601TimeFormat) : '';
        const transform = text => template.replace(/\{\{\s*message\s*\}\}/g, () => String(text || ''))
            + (time ? `\n\n[消息发送时间：${time}]` : '');
        if (typeof message.content === 'string') return { ...message, content: transform(message.content) };
        if (!Array.isArray(message.content)) return message;
        let added = false;
        const content = message.content.map(part => {
            if (part.type !== 'text' || added) return part;
            added = true;
            return { ...part, text: transform(part.text) };
        });
        if (!added && time) content.unshift({ type: 'text', text: transform('') });
        return { ...message, content };
    });
}
