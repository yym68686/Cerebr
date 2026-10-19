const drafts = new WeakMap();
const EMPTY = Object.freeze([]);
export const getDraftQuotes = (input) => drafts.get(input) || EMPTY;
export const normalizeQuotes = (quotes) =>
    Array.isArray(quotes) ? quotes.filter((q) => typeof q === 'string' && q.trim()).map((q) => q.trim()) : [];
export function setDraftQuotes(input, quotes, emit = true) {
    drafts.set(input, normalizeQuotes(quotes));
    if (emit) input.dispatchEvent(new Event('input', { bubbles: true }));
}
export function addDraftQuote(input, text) {
    if (!String(text || '').trim()) return;
    setDraftQuotes(input, [...getDraftQuotes(input), text]);
}
export function quotedText(text, quotes = []) {
    const prefix = normalizeQuotes(quotes)
        .map((quote) =>
            quote
                .split('\n')
                .map((line) => `> ${line}`)
                .join('\n')
        )
        .join('\n\n');
    return [prefix, text].filter(Boolean).join('\n\n');
}
// Metadata is only used to split the visible quote from the question. API and
// clipboard consumers still receive complete, ordinary text content.
export function splitQuotedMessage(message) {
    const quotes = normalizeQuotes(message.selectionQuotes);
    const content = message.content;
    const text = Array.isArray(content)
        ? content
              .filter((p) => p.type === 'text')
              .map((p) => p.text || '')
              .join('\n')
        : String(content || '');
    const question = typeof message.selectionQuestion === 'string' ? message.selectionQuestion : '';
    if (!quotes.length || text !== quotedText(question, quotes)) return { content, quotes: [] };
    return {
        quotes,
        content: Array.isArray(content)
            ? [{ type: 'text', text: question }, ...content.filter((p) => p.type !== 'text')]
            : question,
    };
}
