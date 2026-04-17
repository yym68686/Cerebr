import { detectSystemLocale, getLanguagePreference, LANGUAGE_AUTO } from './i18n.js';

export const DEFAULT_CHAT_KIND = 'default';
export const DEFAULT_CHAT_SEED_VERSION = 1;

const SUPPORTED_LOCALES = ['en', 'zh_CN', 'zh_TW'];
const LEGACY_DEFAULT_TITLES = new Set(['默认对话', '預設對話', 'Default chat', 'Default Chat']);

const DEFAULT_CHAT_CONTENT = {
    en: {
        title: 'Default chat',
        seeds: [
            {
                id: 'usage_question',
                role: 'user',
                content: 'How do I use this extension?'
            },
            {
                id: 'usage_answer',
                role: 'assistant',
                content: 'Open **Settings -> API settings** first and add an API key, base URL, and model name. After that, you can chat normally, paste text or images, and continue asking follow-up questions in this default chat.'
            },
            {
                id: 'webpage_question',
                role: 'user',
                content: 'Can you answer questions about the current webpage?'
            },
            {
                id: 'webpage_answer',
                role: 'assistant',
                content: 'Yes. In the extension, open **Settings -> Webpage content** and keep the current tab enabled. Then ask me to summarize the page, extract key points, explain a paragraph, or draft something based on the page.'
            },
            {
                id: 'starter_question',
                role: 'user',
                content: 'What should I try first?'
            },
            {
                id: 'starter_answer',
                role: 'assistant',
                content: 'Try prompts like: `Summarize this page`, `Extract the key facts`, `Translate the selected content`, `Explain this paragraph`, or `Draft a reply based on this page`. If you want a clean context, create a new empty chat from the menu.'
            }
        ]
    },
    zh_CN: {
        title: '默认对话',
        seeds: [
            {
                id: 'usage_question',
                role: 'user',
                content: '我该怎么使用这个插件？'
            },
            {
                id: 'usage_answer',
                role: 'assistant',
                content: '先打开 **设置 -> API 设置**，填入 API Key、Base URL 和模型名称。完成后你就可以像普通聊天一样提问，也可以粘贴文字、图片，并且继续在这个默认对话里追问。'
            },
            {
                id: 'webpage_question',
                role: 'user',
                content: '你能回答当前网页里的内容吗？'
            },
            {
                id: 'webpage_answer',
                role: 'assistant',
                content: '可以。在扩展里打开 **设置 -> 网页内容**，确保当前标签页保持启用。之后你可以让我总结页面、提取重点、解释某一段，或者基于当前网页内容帮你起草回复。'
            },
            {
                id: 'starter_question',
                role: 'user',
                content: '我可以先试些什么问题？'
            },
            {
                id: 'starter_answer',
                role: 'assistant',
                content: '可以先试试：`总结这个网页`、`提取关键事实`、`翻译选中的内容`、`解释这一段`、`基于这个页面起草一封回复`。如果你想要一个干净上下文，可以从菜单里新建一个空对话。'
            }
        ]
    },
    zh_TW: {
        title: '預設對話',
        seeds: [
            {
                id: 'usage_question',
                role: 'user',
                content: '我要怎麼使用這個外掛？'
            },
            {
                id: 'usage_answer',
                role: 'assistant',
                content: '先打開 **設定 -> API 設定**，填入 API Key、Base URL 和模型名稱。完成後你就可以像一般聊天一樣提問，也可以貼上文字、圖片，並繼續在這個預設對話裡追問。'
            },
            {
                id: 'webpage_question',
                role: 'user',
                content: '你可以回答目前網頁裡的內容嗎？'
            },
            {
                id: 'webpage_answer',
                role: 'assistant',
                content: '可以。在擴充功能裡打開 **設定 -> 網頁內容**，確認目前分頁保持啟用。之後你可以要我總結頁面、提取重點、解釋某一段，或根據目前網頁內容幫你起草回覆。'
            },
            {
                id: 'starter_question',
                role: 'user',
                content: '我可以先試哪些問題？'
            },
            {
                id: 'starter_answer',
                role: 'assistant',
                content: '你可以先試試：`總結這個網頁`、`提取關鍵事實`、`翻譯選取的內容`、`解釋這一段`、`根據這個頁面起草一封回覆`。如果你想要一個乾淨上下文，可以從選單裡新建一個空對話。'
            }
        ]
    }
};

function normalizeLocale(locale) {
    if (!locale || !SUPPORTED_LOCALES.includes(locale)) return 'en';
    return locale;
}

function getLocaleContent(locale) {
    return DEFAULT_CHAT_CONTENT[normalizeLocale(locale)] || DEFAULT_CHAT_CONTENT.en;
}

export async function resolveDefaultChatLocale() {
    try {
        const preference = await getLanguagePreference();
        if (preference && preference !== LANGUAGE_AUTO) {
            return normalizeLocale(preference);
        }
    } catch {
        // ignore
    }
    return normalizeLocale(detectSystemLocale());
}

export function getDefaultChatTitle(locale) {
    return getLocaleContent(locale).title;
}

export function buildDefaultChatSeedMessages(locale) {
    return getLocaleContent(locale).seeds.map((seed) => ({
        role: seed.role,
        content: seed.content,
        seedId: seed.id,
        seedVersion: DEFAULT_CHAT_SEED_VERSION,
        seedLocaleBound: true
    }));
}

export function isDefaultChat(chat) {
    return chat?.kind === DEFAULT_CHAT_KIND;
}

export function isLegacyDefaultChatTitle(title) {
    return LEGACY_DEFAULT_TITLES.has(String(title || '').trim());
}

export function isSeedManagedMessage(message) {
    return !!(message?.seedLocaleBound && typeof message?.seedId === 'string');
}

export function hasSeedManagedMessages(chat) {
    return Array.isArray(chat?.messages) && chat.messages.some(isSeedManagedMessage);
}

export function isDefaultChatSeedOnly(chat) {
    return isDefaultChat(chat) &&
        Array.isArray(chat?.messages) &&
        chat.messages.length > 0 &&
        chat.messages.every(isSeedManagedMessage);
}

export function syncDefaultChatForLocale(chat, locale, { insertSeedsWhenEmpty = false } = {}) {
    if (!chat) return false;

    const localizedTitle = getDefaultChatTitle(locale);
    const localizedSeeds = buildDefaultChatSeedMessages(locale);
    const localizedSeedMap = new Map(localizedSeeds.map((message) => [message.seedId, message]));
    const shouldSyncTitle = chat.titleLocaleBound !== false;

    let changed = false;

    if (shouldSyncTitle && chat.title !== localizedTitle) {
        chat.title = localizedTitle;
        changed = true;
    }

    const currentMessages = Array.isArray(chat.messages) ? chat.messages : [];
    const hasManagedSeedMessages = currentMessages.some(isSeedManagedMessage);

    if (!hasManagedSeedMessages) {
        if (insertSeedsWhenEmpty && currentMessages.length === 0) {
            chat.messages = localizedSeeds;
            changed = true;
        }
        return changed;
    }

    const nextMessages = currentMessages.map((message) => {
        if (!isSeedManagedMessage(message)) return message;
        const localized = localizedSeedMap.get(message.seedId);
        if (!localized) return message;

        const roleChanged = message.role !== localized.role;
        const contentChanged = message.content !== localized.content;
        const versionChanged = message.seedVersion !== DEFAULT_CHAT_SEED_VERSION;
        const localeBindingChanged = message.seedLocaleBound !== true;

        if (!roleChanged && !contentChanged && !versionChanged && !localeBindingChanged) {
            return message;
        }

        changed = true;
        return {
            ...message,
            role: localized.role,
            content: localized.content,
            seedVersion: DEFAULT_CHAT_SEED_VERSION,
            seedLocaleBound: true
        };
    });

    if (changed) {
        chat.messages = nextMessages;
    }

    return changed;
}
