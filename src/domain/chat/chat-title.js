import { DEFAULT_CHAT_KIND } from '../../utils/default-chat.js';
import { splitTextFileMessage } from '../../runtime/input/draft-files.js';
import { splitQuotedMessage } from '../../runtime/input/draft-quotes.js';
import { webpageTitle } from '../../utils/webpage-identity.js';

export function isLegacyQuestionTitle(chat) {
    if (!chat || chat.titleSource || chat.kind === DEFAULT_CHAT_KIND || chat.importedShareId) return false;
    const first = Array.isArray(chat.messages) && chat.messages.find((message) => message?.role === 'user');
    if (!first) return false;
    const { content, files } = splitTextFileMessage(first);
    const { content: question } = splitQuotedMessage({ ...first, content });
    const text = Array.isArray(question)
        ? question.filter((part) => part?.type === 'text').map((part) => part.text || '').join('\n')
        : question;
    const originalTitle = text || files[0]?.name;
    // Older versions didn't mark renames. Only infer a title when the saved
    // title still matches exactly what the old first-send rule would produce.
    return Boolean(originalTitle && chat.title === originalTitle);
}

export function updateTitleForQuestion(chat, webpageInfo, firstQuestionTitle) {
    if (chat.kind === DEFAULT_CHAT_KIND || chat.importedShareId || chat.titleSource === 'manual' || chat.titleSource === 'webpage') return;
    if (!firstQuestionTitle && chat.titleSource !== 'question' && !isLegacyQuestionTitle(chat)) return;

    const pages = Array.isArray(webpageInfo?.pages) ? webpageInfo.pages : [];
    const page = pages.find((page) => page?.isCurrent && webpageTitle(page)) || pages.find(webpageTitle);
    if (page) {
        chat.title = webpageTitle(page);
        chat.titleSource = 'webpage';
    } else if (firstQuestionTitle) {
        chat.title = firstQuestionTitle;
        chat.titleSource = 'question';
    }
}

export function displayChatTitle(chat, cachedPage) {
    if (!cachedPage || !isLegacyQuestionTitle(chat)) return chat.title;
    const lastQuestionAt = Date.parse(chat.lastUserMessageAt);
    // Extraction used to save pages before a send was accepted. A page first
    // seen after the last question isn't evidence of a webpage conversation.
    if (cachedPage.addedAt > lastQuestionAt) return chat.title;
    return cachedPage.title;
}
