const PLUGIN_ID = 'cerebr.shell.share-snapshot';
const PAGE_ID = `${PLUGIN_ID}:page`;
const SETTINGS_KEY = `${PLUGIN_ID}:settings`;
const HISTORY_KEY = `${PLUGIN_ID}:history`;
const MAX_HISTORY_ITEMS = 200;
const DEFAULT_UPLOAD_TIMEOUT_MS = 20_000;
const HISTORY_PAGE_SIZE_DEFAULT = 10;
const HISTORY_PAGE_SIZE_OPTIONS = Object.freeze([10, 20, 50]);
const HISTORY_QUERY_FIELD_ID = 'historyQuery';
const HISTORY_PAGE_SIZE_FIELD_ID = 'historyPageSize';
const HISTORY_PAGE_FIELD_ID = 'historyPage';
const UPLOAD_SPINNER_FRAMES = Object.freeze(['◜', '◠', '◝', '◞', '◡', '◟']);
const MENU_ICON_SHARE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19 C4 9.5 8 7 14 7 V3 L22 12 L14 21 V16 C9 16 5.5 17.5 4 19 Z" /></svg>';

const DEFAULT_SETTINGS = Object.freeze({
    filename: '',
    serverUrl: 'https://snap.fugue.pro',
    uploadToken: '',
    themeMode: 'current',
    includeReasoning: true,
    includeDraft: true,
    includeMetadata: true,
});

const GENERIC_PLUGIN_TITLES = Object.freeze([
    'Cerebr Snapshot',
    'Cerebr 快照',
]);
let runtimeI18nApi = null;

function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function setRuntimeI18nApi(i18nApi = null) {
    runtimeI18nApi = i18nApi && typeof i18nApi === 'object'
        ? i18nApi
        : null;
}

function getPluginMessage(key, fallback = '') {
    const normalizedKey = normalizeString(key);
    const normalizedFallback = normalizeString(fallback, normalizedKey);
    if (!normalizedKey) {
        return normalizedFallback;
    }

    if (typeof runtimeI18nApi?.getMessage === 'function') {
        return normalizeString(
            runtimeI18nApi.getMessage(normalizedKey, [], normalizedFallback),
            normalizedFallback
        );
    }

    return normalizedFallback;
}

function interpolateMessage(message, substitutions = {}) {
    if (message == null) {
        return '';
    }

    const values = Array.isArray(substitutions)
        ? Object.fromEntries(substitutions.map((value, index) => [String(index), value]))
        : (substitutions && typeof substitutions === 'object' ? substitutions : {});

    return String(message).replace(/\{([^}]+)\}/g, (_, key) => {
        return String(values[key] ?? '');
    });
}

function t(locale, key, substitutions = {}, fallback = '') {
    void locale;
    return interpolateMessage(getPluginMessage(key, fallback), substitutions);
}

function normalizeLocaleTag(value, fallback = 'zh-CN') {
    const candidates = [
        value,
        fallback,
        'zh-CN',
        'en-US',
    ];

    for (const candidate of candidates) {
        const normalized = normalizeString(candidate).replace(/_/g, '-');
        if (!normalized) {
            continue;
        }

        try {
            const [canonical] = Intl.getCanonicalLocales(normalized);
            if (canonical) {
                return canonical;
            }
        } catch {
            // Ignore invalid locale tags and keep trying fallbacks.
        }
    }

    return 'en-US';
}

function normalizeBoolean(value, fallback = false) {
    if (typeof value === 'boolean') {
        return value;
    }
    if (value == null) {
        return fallback;
    }
    const normalized = String(value).trim().toLowerCase();
    if (normalized === 'true') {
        return true;
    }
    if (normalized === 'false') {
        return false;
    }
    return !!value;
}

function normalizePositiveInt(value, fallback = 0) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return fallback;
    }
    return Math.floor(numeric);
}

function normalizeThemeMode(value, fallback = 'current') {
    const normalized = normalizeString(value, fallback).toLowerCase();
    return ['current', 'light', 'dark'].includes(normalized)
        ? normalized
        : fallback;
}

function normalizeServerUrl(value, fallback = '') {
    const normalized = normalizeString(value, fallback).replace(/\/+$/g, '');
    return normalized || fallback;
}

function cloneValue(value, fallback = null) {
    if (value == null) {
        return fallback;
    }

    try {
        if (typeof structuredClone === 'function') {
            return structuredClone(value);
        }
        return JSON.parse(JSON.stringify(value));
    } catch {
        return fallback;
    }
}

function escapeHtml(value = '') {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatDateTime(value, locale = 'zh-CN') {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) {
        return '';
    }

    try {
        return new Intl.DateTimeFormat(normalizeLocaleTag(locale, 'zh-CN'), {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        }).format(date);
    } catch {
        return new Intl.DateTimeFormat('en-US', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        }).format(date);
    }
}

function formatBytes(bytes) {
    const numeric = Number(bytes);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB'];
    let value = numeric;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    const precision = value >= 100 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function truncateText(value, maxLength = 160) {
    const normalized = normalizeString(value);
    if (!normalized) {
        return '';
    }
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, maxLength - 1)}...`;
}

function normalizeHistoryQuery(value, fallback = '') {
    return normalizeString(value, fallback);
}

function normalizeHistoryPageSize(value, fallback = HISTORY_PAGE_SIZE_DEFAULT) {
    const normalized = normalizePositiveInt(value, fallback);
    return HISTORY_PAGE_SIZE_OPTIONS.includes(normalized)
        ? normalized
        : fallback;
}

function normalizeHistoryPage(value, fallback = 1) {
    return Math.max(1, normalizePositiveInt(value, fallback));
}

function normalizeHistoryUiState(ui = {}) {
    return {
        query: normalizeHistoryQuery(ui?.query),
        pageSize: normalizeHistoryPageSize(ui?.pageSize, HISTORY_PAGE_SIZE_DEFAULT),
        page: normalizeHistoryPage(ui?.page, 1),
    };
}

function createDefaultHistoryUiState() {
    return normalizeHistoryUiState();
}

function normalizeHistoryPreviewText(value, fallback = '') {
    const normalized = normalizeString(value, fallback).replace(/\s+/g, ' ').trim();
    return truncateText(normalized, 72);
}

function isGenericPluginTitle(value = '') {
    const normalized = normalizeHistoryPreviewText(value).toLowerCase();
    if (!normalized) {
        return true;
    }

    return GENERIC_PLUGIN_TITLES.some((title) => {
        return normalizeHistoryPreviewText(title).toLowerCase() === normalized;
    });
}

function buildHistoryPreviewText(snapshot = null, fallback = '') {
    const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
    const firstUserMessage = messages.find((message) => {
        return message?.role === 'user' && normalizeString(message?.excerpt);
    });
    const firstMessage = messages.find((message) => normalizeString(message?.excerpt));
    return normalizeHistoryPreviewText(
        firstUserMessage?.excerpt || firstMessage?.excerpt,
        fallback
    );
}

function getDateValue(value = '') {
    const timestamp = Date.parse(normalizeString(value));
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function pickLatestDateString(...values) {
    const normalizedValues = values
        .map((value) => normalizeString(value))
        .filter(Boolean)
        .sort((left, right) => getDateValue(right) - getDateValue(left));
    return normalizedValues[0] || '';
}

function pickEarliestDateString(...values) {
    const normalizedValues = values
        .map((value) => normalizeString(value))
        .filter(Boolean)
        .sort((left, right) => getDateValue(left) - getDateValue(right));
    return normalizedValues[0] || '';
}

function normalizeFileBaseName(value, fallback = 'cerebr-snapshot') {
    const normalized = String(value ?? '')
        .replace(/\.html?$/i, '')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return normalized || fallback;
}

function buildTimestampTag(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) {
        return 'snapshot';
    }

    const parts = [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
        String(date.getHours()).padStart(2, '0'),
        String(date.getMinutes()).padStart(2, '0'),
    ];

    return parts.join('');
}

function buildExportFileName(snapshot, settings) {
    const sourceName = normalizeString(settings?.filename)
        || normalizeString(snapshot?.chat?.title)
        || 'cerebr-snapshot';
    const baseName = normalizeFileBaseName(sourceName, 'cerebr-snapshot');
    const timestamp = buildTimestampTag(snapshot?.collectedAt);
    return `${baseName}-${timestamp}.html`;
}

function getRoleLabel(role = '', locale = 'en-US') {
    const normalized = normalizeString(role, 'assistant').toLowerCase();
    if (normalized === 'user') {
        return t(locale, 'role_user');
    }
    if (normalized === 'system') {
        return t(locale, 'role_system');
    }
    if (normalized === 'tool') {
        return t(locale, 'role_tool');
    }
    return t(locale, 'role_assistant');
}

function getRoleTone(role = '') {
    const normalized = normalizeString(role, 'assistant').toLowerCase();
    if (normalized === 'user') {
        return 'primary';
    }
    if (normalized === 'system') {
        return 'warning';
    }
    if (normalized === 'tool') {
        return 'muted';
    }
    return 'success';
}

function normalizeMessagePart(part, index = 0) {
    if (typeof part === 'string') {
        const text = String(part);
        if (!text.trim()) {
            return null;
        }
        return {
            id: `text-${index}`,
            kind: 'text',
            text,
        };
    }

    if (!part || typeof part !== 'object') {
        return null;
    }

    const type = normalizeString(part.type).toLowerCase();
    if (type === 'text') {
        const text = String(part.text ?? '');
        if (!text.trim()) {
            return null;
        }
        return {
            id: normalizeString(part.id, `text-${index}`),
            kind: 'text',
            text,
        };
    }

    if (type === 'image_url') {
        const url = normalizeString(part?.image_url?.url || part?.url);
        if (!url) {
            return null;
        }
        return {
            id: normalizeString(part.id, `image-${index}`),
            kind: 'image',
            url,
        };
    }

    const fallbackText = JSON.stringify(part, null, 2);
    if (!fallbackText) {
        return null;
    }
    return {
        id: normalizeString(part.id, `unknown-${index}`),
        kind: 'text',
        text: fallbackText,
    };
}

function buildMessageExcerpt(parts = [], reasoning = '', locale = 'en-US') {
    const pieces = [];

    parts.forEach((part) => {
        if (part?.kind === 'text') {
            pieces.push(part.text);
            return;
        }
        if (part?.kind === 'image') {
            pieces.push(t(locale, 'excerpt_image'));
        }
    });

    if (normalizeString(reasoning)) {
        pieces.push(t(locale, 'excerpt_reasoning', { text: reasoning }));
    }

    return truncateText(pieces.join('\n\n').replace(/\s+/g, ' '), 180);
}

function normalizeMessage(message, index = 0, locale = 'en-US') {
    if (!message || typeof message !== 'object') {
        return null;
    }

    const parts = Array.isArray(message.content)
        ? message.content.map((part, partIndex) => normalizeMessagePart(part, partIndex)).filter(Boolean)
        : [normalizeMessagePart(message.content, 0)].filter(Boolean);
    const reasoning = normalizeString(message.reasoning_content || message.reasoningContent);

    return {
        id: normalizeString(message.id, `message-${index}`),
        role: normalizeString(message.role, 'assistant').toLowerCase(),
        roleLabel: getRoleLabel(message.role, locale),
        tone: getRoleTone(message.role),
        parts,
        reasoning,
        excerpt: buildMessageExcerpt(parts, reasoning, locale),
    };
}

function normalizeDraftSnapshot(api) {
    try {
        const snapshot = api.editor?.getDraftSnapshot?.();
        const text = normalizeString(snapshot?.text);
        return {
            text,
            empty: !text,
        };
    } catch {
        return {
            text: '',
            empty: true,
        };
    }
}

function normalizeTab(tab = null) {
    if (!tab || typeof tab !== 'object') {
        return null;
    }

    return {
        id: tab.id ?? null,
        title: normalizeString(tab.title),
        url: normalizeString(tab.url),
        hostname: normalizeString(tab.hostname),
    };
}

function normalizeRenderedTranscript(transcript = null) {
    if (!transcript || typeof transcript !== 'object') {
        return {
            html: '',
            styleText: '',
            messageCount: 0,
            imageCount: 0,
        };
    }

    const messageCount = Number(transcript.messageCount || 0);
    const imageCount = Number(transcript.imageCount || 0);

    return {
        html: typeof transcript.html === 'string' ? transcript.html : '',
        styleText: typeof transcript.styleText === 'string' ? transcript.styleText : '',
        messageCount: Number.isFinite(messageCount) && messageCount > 0 ? messageCount : 0,
        imageCount: Number.isFinite(imageCount) && imageCount > 0 ? imageCount : 0,
    };
}

function buildSummary(messages = [], draft = { empty: true, text: '' }, renderedTranscript = null) {
    const summary = {
        messageCount: 0,
        userCount: 0,
        assistantCount: 0,
        systemCount: 0,
        toolCount: 0,
        imageCount: 0,
        reasoningCount: 0,
        textChars: 0,
        draftChars: normalizeString(draft?.text).length,
    };

    messages.forEach((message) => {
        summary.messageCount += 1;

        if (message.role === 'user') {
            summary.userCount += 1;
        } else if (message.role === 'assistant') {
            summary.assistantCount += 1;
        } else if (message.role === 'system') {
            summary.systemCount += 1;
        } else if (message.role === 'tool') {
            summary.toolCount += 1;
        }

        message.parts.forEach((part) => {
            if (part.kind === 'image') {
                summary.imageCount += 1;
                return;
            }
            summary.textChars += normalizeString(part.text).length;
        });

        if (normalizeString(message.reasoning)) {
            summary.reasoningCount += 1;
            summary.textChars += normalizeString(message.reasoning).length;
        }
    });

    const normalizedTranscript = normalizeRenderedTranscript(renderedTranscript);
    summary.messageCount = Math.max(summary.messageCount, normalizedTranscript.messageCount);
    summary.imageCount = Math.max(summary.imageCount, normalizedTranscript.imageCount);

    return summary;
}

function normalizeSettings(settings = {}) {
    return {
        filename: '',
        serverUrl: normalizeServerUrl(settings.serverUrl, DEFAULT_SETTINGS.serverUrl),
        uploadToken: normalizeString(settings.uploadToken, DEFAULT_SETTINGS.uploadToken),
        themeMode: DEFAULT_SETTINGS.themeMode,
        includeReasoning: DEFAULT_SETTINGS.includeReasoning,
        includeDraft: DEFAULT_SETTINGS.includeDraft,
        includeMetadata: DEFAULT_SETTINGS.includeMetadata,
    };
}

function detectRuntimeHost() {
    const protocol = normalizeString(window?.location?.protocol);
    if (protocol === 'chrome-extension:' || protocol === 'moz-extension:') {
        return 'extension';
    }
    return 'web';
}

async function readCurrentTab(api) {
    try {
        return await api.browser?.getCurrentTab?.();
    } catch {
        return null;
    }
}

async function collectLiveSnapshot(api, fallbackSnapshot = null) {
    const locale = normalizeLocaleTag(
        api.i18n?.getLocale?.(),
        fallbackSnapshot?.locale || navigator.language || 'zh-CN'
    );
    const currentChat = api.chat?.getCurrentChat?.() || fallbackSnapshot?.chat || null;
    const rawMessages = api.chat?.getMessages?.();
    const messages = Array.isArray(rawMessages)
        ? rawMessages.map((message, index) => normalizeMessage(message, index, locale)).filter(Boolean)
        : (Array.isArray(fallbackSnapshot?.messages) ? fallbackSnapshot.messages : []);
    const draft = normalizeDraftSnapshot(api);
    const theme = cloneValue(api.shell?.getThemeSnapshot?.(), fallbackSnapshot?.theme) || fallbackSnapshot?.theme || {
        themePreference: 'system',
        isDark: false,
        classes: [],
    };
    let renderedTranscript = normalizeRenderedTranscript(fallbackSnapshot?.renderedTranscript);

    try {
        renderedTranscript = normalizeRenderedTranscript(
            await Promise.resolve(api.chat?.getRenderedTranscript?.())
        );
    } catch {
        renderedTranscript = normalizeRenderedTranscript(fallbackSnapshot?.renderedTranscript);
    }

    return {
        collectedAt: new Date().toISOString(),
        locale,
        runtimeHost: detectRuntimeHost(),
        chat: currentChat
            ? {
                id: normalizeString(currentChat.id, 'current-chat'),
                title: normalizeString(currentChat.title, t(locale, 'plugin_title')),
                createdAt: normalizeString(currentChat.createdAt),
                updatedAt: normalizeString(currentChat.updatedAt),
            }
            : {
                id: 'current-chat',
                title: t(locale, 'plugin_title'),
                createdAt: '',
                updatedAt: '',
            },
        tab: normalizeTab(fallbackSnapshot?.tab),
        theme: {
            themePreference: normalizeString(theme.themePreference, 'system'),
            isDark: !!theme.isDark,
            classes: Array.isArray(theme.classes) ? [...theme.classes] : [],
        },
        draft,
        renderedTranscript,
        messages,
        summary: buildSummary(messages, draft, renderedTranscript),
    };
}

async function collectSnapshot(api) {
    const [tab, liveSnapshot] = await Promise.all([
        readCurrentTab(api),
        collectLiveSnapshot(api),
    ]);

    return {
        ...liveSnapshot,
        tab: normalizeTab(tab),
    };
}

function canShareSnapshot(snapshot = {}) {
    if (Array.isArray(snapshot?.messages) && snapshot.messages.length > 0) {
        return true;
    }

    const renderedTranscript = normalizeRenderedTranscript(snapshot?.renderedTranscript);
    return renderedTranscript.messageCount > 0 || !!renderedTranscript.html;
}

function createHistoryItem(item = {}) {
    const filename = normalizeString(item.filename);
    const chatId = normalizeString(item.chatId);
    const chatTitle = resolveHistoryChatTitle(item.chatTitle, filename);
    const previewText = normalizeHistoryPreviewText(
        item.previewText,
        chatTitle
    );
    const mode = normalizeString(item.mode, 'download');
    const hasLocalExport = Object.prototype.hasOwnProperty.call(item, 'hasLocalExport')
        ? normalizeBoolean(item.hasLocalExport, false)
        : (
            mode === 'download'
            || mode === 'copy'
            || !!normalizeString(item.lastLocalMode)
            || !!normalizeString(item.lastLocalExportAt)
        );
    const createdAt = normalizeString(item.createdAt);
    const lastLocalExportAt = hasLocalExport
        ? normalizeString(
            item.lastLocalExportAt,
            mode === 'download' || mode === 'copy'
                ? createdAt
                : ''
        )
        : '';
    const shareUrl = normalizeString(item.shareUrl);
    const snapshotId = normalizeString(item.snapshotId, extractSnapshotIdFromShareUrl(shareUrl));
    const canonicalId = buildHistoryEntryId({
        chatId,
        chatTitle,
        filename,
        shareUrl,
        snapshotId,
    });
    const lastUploadAt = shareUrl
        ? normalizeString(
            item.lastUploadAt,
            mode === 'upload'
                ? createdAt
                : ''
        )
        : '';
    const updatedAt = pickLatestDateString(
        normalizeString(item.updatedAt),
        createdAt,
        lastLocalExportAt,
        lastUploadAt
    );

    return {
        id: normalizeString(canonicalId, item.id),
        chatId,
        chatTitle,
        previewText,
        createdAt: normalizeString(createdAt, updatedAt),
        updatedAt: normalizeString(updatedAt, createdAt),
        mode,
        filename,
        shareUrl,
        snapshotId,
        deleteToken: normalizeString(item.deleteToken),
        messageCount: Number(item.messageCount || 0),
        bytes: Number(item.bytes || 0),
        themeMode: normalizeThemeMode(item.themeMode, 'current'),
        exportDigest: normalizeString(item.exportDigest),
        hasLocalExport,
        lastLocalMode: hasLocalExport
            ? normalizeString(
                item.lastLocalMode,
                mode === 'download' || mode === 'copy'
                    ? mode
                    : ''
            )
            : '',
        lastLocalExportAt,
        lastUploadAt,
    };
}

function isPersistedHistoryEntryUsable(item = {}) {
    return !!normalizeString(item?.shareUrl) || !!item?.hasLocalExport;
}

function normalizeHistory(history = []) {
    if (!Array.isArray(history)) {
        return [];
    }

    const mergedHistory = new Map();
    history
        .map((item) => createHistoryItem(item))
        .filter((item) => item.id && isPersistedHistoryEntryUsable(item))
        .forEach((item) => {
            const existing = mergedHistory.get(item.id);
            mergedHistory.set(
                item.id,
                existing
                    ? mergeHistoryItems(existing, item)
                    : item
            );
        });

    return Array.from(mergedHistory.values())
        .sort((left, right) => getHistorySortValue(right) - getHistorySortValue(left))
        .slice(0, MAX_HISTORY_ITEMS);
}

function resolveHistoryChatTitle(chatTitle = '', filename = '') {
    const normalizedTitle = normalizeString(chatTitle);
    if (normalizedTitle) {
        return normalizedTitle;
    }

    const normalizedFilename = normalizeString(filename)
        .replace(/\.html?$/i, '')
        .replace(/-\d{12}$/, '')
        .trim();
    return normalizedFilename || t(navigator.language, 'plugin_title');
}

function buildHistoryConversationKey({ chatId = '', chatTitle = '', filename = '' } = {}) {
    const normalizedChatId = normalizeString(chatId);
    if (normalizedChatId) {
        return `chat:${normalizedChatId}`;
    }

    const normalizedTitle = resolveHistoryChatTitle(chatTitle, filename)
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
    return normalizedTitle
        ? `title:${normalizedTitle}`
        : '';
}

function buildHistoryEntryId({
    chatId = '',
    chatTitle = '',
    filename = '',
    shareUrl = '',
    snapshotId = '',
} = {}) {
    const normalizedSnapshotId = normalizeString(snapshotId, extractSnapshotIdFromShareUrl(shareUrl));
    if (normalizedSnapshotId) {
        return `remote:${normalizedSnapshotId}`;
    }

    const normalizedShareUrl = normalizeString(shareUrl);
    if (normalizedShareUrl) {
        return `remote-url:${normalizedShareUrl}`;
    }

    return buildHistoryConversationKey({
        chatId,
        chatTitle,
        filename,
    });
}

function getHistorySortValue(entry = {}) {
    return Math.max(
        getDateValue(entry.updatedAt),
        getDateValue(entry.lastLocalExportAt),
        getDateValue(entry.lastUploadAt),
        getDateValue(entry.createdAt)
    );
}

function pickHistoryTitle(primary = '', fallback = '') {
    const normalizedPrimary = normalizeString(primary);
    if (normalizedPrimary && normalizedPrimary !== t(navigator.language, 'plugin_title')) {
        return normalizedPrimary;
    }

    const normalizedFallback = normalizeString(fallback);
    if (normalizedFallback) {
        return normalizedFallback;
    }

    return normalizedPrimary || t(navigator.language, 'plugin_title');
}

function pickHistoryPreviewText(primary = '', fallback = '', titleFallback = '') {
    const normalizedPrimary = normalizeHistoryPreviewText(primary);
    if (normalizedPrimary && normalizedPrimary !== t(navigator.language, 'plugin_title')) {
        return normalizedPrimary;
    }

    const normalizedFallback = normalizeHistoryPreviewText(fallback);
    if (normalizedFallback && normalizedFallback !== t(navigator.language, 'plugin_title')) {
        return normalizedFallback;
    }

    return normalizeHistoryPreviewText(titleFallback, t(navigator.language, 'plugin_title'));
}

function mergeHistoryItems(existing = {}, incoming = {}) {
    const normalizedExisting = createHistoryItem(existing);
    const normalizedIncoming = createHistoryItem(incoming);
    const incomingWins = getHistorySortValue(normalizedIncoming) >= getHistorySortValue(normalizedExisting);
    const incomingLocalWins = getDateValue(normalizedIncoming.lastLocalExportAt) >= getDateValue(normalizedExisting.lastLocalExportAt);
    const incomingUploadWins = getDateValue(normalizedIncoming.lastUploadAt) >= getDateValue(normalizedExisting.lastUploadAt);
    const mergedChatId = normalizeString(normalizedExisting.chatId, normalizedIncoming.chatId)
        ? normalizeString(normalizedIncoming.chatId, normalizedExisting.chatId)
        : '';
    const mergedFilename = incomingWins
        ? normalizeString(normalizedIncoming.filename, normalizedExisting.filename)
        : normalizeString(normalizedExisting.filename, normalizedIncoming.filename);
    const mergedChatTitle = pickHistoryTitle(
        normalizedIncoming.chatTitle,
        normalizedExisting.chatTitle
    );
    const mergedShareUrl = incomingUploadWins
        ? normalizeString(normalizedIncoming.shareUrl, normalizedExisting.shareUrl)
        : normalizeString(normalizedExisting.shareUrl, normalizedIncoming.shareUrl);
    const mergedSnapshotId = incomingUploadWins
        ? normalizeString(normalizedIncoming.snapshotId, normalizedExisting.snapshotId)
        : normalizeString(normalizedExisting.snapshotId, normalizedIncoming.snapshotId);
    const mergedDeleteToken = incomingUploadWins
        ? normalizeString(normalizedIncoming.deleteToken, normalizedExisting.deleteToken)
        : normalizeString(normalizedExisting.deleteToken, normalizedIncoming.deleteToken);

    return createHistoryItem({
        id: normalizeString(
            normalizedIncoming.id,
            normalizedExisting.id,
            buildHistoryEntryId({
                chatId: mergedChatId,
                chatTitle: mergedChatTitle,
                filename: mergedFilename,
                shareUrl: mergedShareUrl,
                snapshotId: mergedSnapshotId,
            })
        ),
        chatId: mergedChatId,
        chatTitle: mergedChatTitle,
        previewText: pickHistoryPreviewText(
            incomingWins ? normalizedIncoming.previewText : normalizedExisting.previewText,
            incomingWins ? normalizedExisting.previewText : normalizedIncoming.previewText,
            mergedChatTitle
        ),
        createdAt: pickEarliestDateString(normalizedExisting.createdAt, normalizedIncoming.createdAt),
        updatedAt: pickLatestDateString(
            normalizedExisting.updatedAt,
            normalizedIncoming.updatedAt,
            normalizedExisting.lastLocalExportAt,
            normalizedIncoming.lastLocalExportAt,
            normalizedExisting.lastUploadAt,
            normalizedIncoming.lastUploadAt,
            normalizedExisting.createdAt,
            normalizedIncoming.createdAt
        ),
        mode: incomingWins ? normalizedIncoming.mode : normalizedExisting.mode,
        filename: mergedFilename,
        shareUrl: mergedShareUrl,
        snapshotId: mergedSnapshotId,
        deleteToken: mergedDeleteToken,
        messageCount: incomingWins
            ? Number(normalizedIncoming.messageCount || normalizedExisting.messageCount || 0)
            : Number(normalizedExisting.messageCount || normalizedIncoming.messageCount || 0),
        bytes: incomingWins
            ? Number(normalizedIncoming.bytes || normalizedExisting.bytes || 0)
            : Number(normalizedExisting.bytes || normalizedIncoming.bytes || 0),
        themeMode: incomingWins
            ? normalizedIncoming.themeMode
            : normalizedExisting.themeMode,
        exportDigest: incomingWins
            ? normalizeString(normalizedIncoming.exportDigest, normalizedExisting.exportDigest)
            : normalizeString(normalizedExisting.exportDigest, normalizedIncoming.exportDigest),
        hasLocalExport: normalizedExisting.hasLocalExport || normalizedIncoming.hasLocalExport,
        lastLocalMode: incomingLocalWins
            ? normalizeString(normalizedIncoming.lastLocalMode, normalizedExisting.lastLocalMode)
            : normalizeString(normalizedExisting.lastLocalMode, normalizedIncoming.lastLocalMode),
        lastLocalExportAt: pickLatestDateString(
            normalizedExisting.lastLocalExportAt,
            normalizedIncoming.lastLocalExportAt
        ),
        lastUploadAt: pickLatestDateString(
            normalizedExisting.lastUploadAt,
            normalizedIncoming.lastUploadAt
        ),
    });
}

function buildHistoryConversationKeyForSnapshot(snapshot = null) {
    return buildHistoryConversationKey({
        chatId: snapshot?.chat?.id,
        chatTitle: snapshot?.chat?.title,
        filename: '',
    });
}

function findReusableRemoteHistoryEntry(history = [], snapshot = null, exportDigest = '') {
    const normalizedDigest = normalizeString(exportDigest);
    const conversationKey = buildHistoryConversationKeyForSnapshot(snapshot);
    if (!normalizedDigest || !conversationKey) {
        return null;
    }

    return normalizeHistory(history).find((entry) => {
        if (!normalizeString(entry.shareUrl)) {
            return false;
        }
        if (normalizeString(entry.exportDigest) !== normalizedDigest) {
            return false;
        }

        return buildHistoryConversationKey({
            chatId: entry?.chatId,
            chatTitle: entry?.chatTitle,
            filename: entry?.filename,
        }) === conversationKey;
    }) || null;
}

function upsertHistoryEntry(history = [], entry = {}) {
    const normalizedHistory = normalizeHistory(history);
    const normalizedEntry = createHistoryItem(entry);
    if (!normalizedEntry.id) {
        return normalizedHistory;
    }

    const existingEntry = normalizedHistory.find((item) => item.id === normalizedEntry.id);
    const remainingEntries = normalizedHistory.filter((item) => item.id !== normalizedEntry.id);
    const mergedEntry = existingEntry
        ? mergeHistoryItems(existingEntry, normalizedEntry)
        : normalizedEntry;
    return normalizeHistory([mergedEntry, ...remainingEntries]);
}

async function computeExportDigest(content = '') {
    const text = String(content ?? '');
    if (!text) {
        return '';
    }

    try {
        if (globalThis.crypto?.subtle && typeof TextEncoder === 'function') {
            const bytes = new TextEncoder().encode(text);
            const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
            const hex = Array.from(new Uint8Array(digest))
                .map((value) => value.toString(16).padStart(2, '0'))
                .join('');
            return `sha256:${hex}`;
        }
    } catch {
        // Fall through to the non-crypto hash.
    }

    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `fnv1a:${(hash >>> 0).toString(16)}:${text.length}`;
}

function resolveExportTheme(settings, snapshot) {
    const themeMode = normalizeThemeMode(settings?.themeMode, 'current');
    if (themeMode === 'current') {
        return snapshot?.theme?.isDark ? 'dark' : 'light';
    }
    return themeMode;
}

function buildSourceLabel(snapshot, locale = 'en-US') {
    const runtimeLabel = snapshot?.runtimeHost === 'extension'
        ? t(locale, 'runtime_extension')
        : t(locale, 'runtime_web');
    const tabTitle = normalizeString(snapshot?.tab?.title);
    if (!tabTitle) {
        return runtimeLabel;
    }
    return `${runtimeLabel} · ${tabTitle}`;
}

function stripHistoryPreviewNode(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll(
        '.reasoning-wrapper, .snapshot-message__header, .delete-btn, button, figure, img, svg, video, audio'
    ).forEach((element) => element.remove());
    return normalizeHistoryPreviewText(clone.textContent || '');
}

function extractHistoryPreviewFromHtml(html = '') {
    const normalizedHtml = String(html ?? '');
    if (!normalizedHtml || typeof DOMParser !== 'function') {
        return '';
    }

    try {
        const documentNode = new DOMParser().parseFromString(normalizedHtml, 'text/html');
        const selectors = [
            '.message.user-message .main-content',
            '.message.user-message',
            'article[data-role="user"] .snapshot-message__body',
            'article[data-role="user"]',
            '[data-role="user"] .main-content',
            '[data-role="user"]',
        ];

        for (const selector of selectors) {
            const node = documentNode.querySelector(selector);
            if (!node) {
                continue;
            }
            const previewText = stripHistoryPreviewNode(node);
            if (previewText && !isGenericPluginTitle(previewText)) {
                return previewText;
            }
        }
    } catch {
        return '';
    }

    return '';
}

async function fetchHistoryPreviewFromRemote(entry = {}) {
    const shareUrl = normalizeString(entry?.shareUrl);
    if (!shareUrl) {
        return '';
    }

    try {
        const response = await fetch(shareUrl, {
            method: 'GET',
            mode: 'cors',
            credentials: 'omit',
        });
        if (!response.ok) {
            return '';
        }
        const html = await response.text();
        return extractHistoryPreviewFromHtml(html);
    } catch {
        return '';
    }
}

function renderMessagePartHtml(part, index = 0, locale = 'en-US') {
    if (part.kind === 'image') {
        return `
            <figure class="snapshot-figure" data-kind="image">
                <img src="${escapeHtml(part.url)}" alt="${escapeHtml(t(locale, 'snapshot_image_alt', { index: index + 1 }))}" loading="lazy" />
            </figure>
        `;
    }

    return `
        <pre class="snapshot-text-block">${escapeHtml(part.text)}</pre>
    `;
}

function renderReasoningHtml(reasoning = '', locale = 'en-US') {
    const text = normalizeString(reasoning);
    if (!text) {
        return '';
    }

    return `
        <details class="snapshot-reasoning" open>
            <summary>${escapeHtml(t(locale, 'reasoning'))}</summary>
            <pre class="snapshot-text-block snapshot-text-block--muted">${escapeHtml(text)}</pre>
        </details>
    `;
}

function renderMessagesHtml(snapshot, settings) {
    const locale = snapshot?.locale || 'en-US';
    if (!Array.isArray(snapshot?.messages) || snapshot.messages.length === 0) {
        return `
            <section class="snapshot-empty">
                <p>${escapeHtml(t(locale, 'no_saved_messages'))}</p>
            </section>
        `;
    }

    return snapshot.messages.map((message, index) => {
        const partsHtml = message.parts.length > 0
            ? message.parts.map((part, partIndex) => renderMessagePartHtml(part, partIndex, locale)).join('\n')
            : `<pre class="snapshot-text-block snapshot-text-block--muted">${escapeHtml(t(locale, 'empty_message'))}</pre>`;
        const reasoningHtml = settings.includeReasoning
            ? renderReasoningHtml(message.reasoning, locale)
            : '';

        return `
            <article class="snapshot-message" data-role="${escapeHtml(message.role)}">
                <header class="snapshot-message__header">
                    <div class="snapshot-message__badge" data-tone="${escapeHtml(message.tone)}">${escapeHtml(message.roleLabel)}</div>
                    <span class="snapshot-message__index">#${index + 1}</span>
                </header>
                <div class="snapshot-message__body">
                    ${partsHtml}
                    ${reasoningHtml}
                </div>
            </article>
        `;
    }).join('\n');
}

function renderMetadataHtml(snapshot, exportTheme) {
    const locale = snapshot?.locale || 'en-US';
    const metadataItems = [
        [t(locale, 'metadata_exported'), formatDateTime(snapshot?.collectedAt, snapshot?.locale)],
        [t(locale, 'metadata_runtime'), snapshot?.runtimeHost === 'extension' ? t(locale, 'exported_runtime_extension') : t(locale, 'exported_runtime_web')],
        [t(locale, 'metadata_theme'), exportTheme === 'dark' ? t(locale, 'theme_dark') : t(locale, 'theme_light')],
    ];

    if (normalizeString(snapshot?.tab?.title)) {
        metadataItems.push([t(locale, 'metadata_source'), buildSourceLabel(snapshot, locale)]);
    }

    if (normalizeString(snapshot?.tab?.url)) {
        metadataItems.push([t(locale, 'metadata_url'), snapshot.tab.url]);
    }

    if (normalizeString(snapshot?.chat?.updatedAt)) {
        metadataItems.push([t(locale, 'metadata_updated'), formatDateTime(snapshot.chat.updatedAt, snapshot?.locale)]);
    }

    return `
        <section class="snapshot-metadata">
            ${metadataItems.map(([label, value]) => `
                <div class="snapshot-metadata__item">
                    <span class="snapshot-metadata__label">${escapeHtml(label)}</span>
                    <span class="snapshot-metadata__value">${escapeHtml(value)}</span>
                </div>
            `).join('\n')}
        </section>
    `;
}

function sanitizeInlineStyleText(styleText = '') {
    return String(styleText ?? '').replace(/<\/style/gi, '<\\/style');
}

function renderFallbackTranscriptHtml(snapshot, settings) {
    const locale = snapshot?.locale || 'en-US';
    if (!Array.isArray(snapshot?.messages) || snapshot.messages.length === 0) {
        return `
            <div class="chat-switch-placeholder">
                <div class="chat-switch-text">${escapeHtml(t(locale, 'no_saved_messages'))}</div>
            </div>
        `;
    }

    return snapshot.messages.map((message) => {
        const messageBodyHtml = message.parts.length > 0
            ? message.parts.map((part) => {
                if (part.kind === 'image') {
                    return `<img src="${escapeHtml(part.url)}" alt="${escapeHtml(message.roleLabel)}" loading="lazy" />`;
                }

                return `
                    <div class="snapshot-fallback-text">${escapeHtml(part.text)}</div>
                `;
            }).join('\n')
            : `<div class="snapshot-fallback-text">${escapeHtml(t(locale, 'empty_message'))}</div>`;
        const reasoningHtml = settings.includeReasoning && normalizeString(message.reasoning)
            ? `
                <div class="reasoning-wrapper">
                    <div class="reasoning-content collapsed">
                        <div class="reasoning-placeholder">${escapeHtml(t(locale, 'deep_thinking'))}</div>
                        <div class="reasoning-text">${escapeHtml(message.reasoning)}</div>
                    </div>
                </div>
            `
            : '';

        return `
            <div class="message ${message.role === 'user' ? 'user-message' : 'ai-message'}">
                ${reasoningHtml}
                <div class="main-content">
                    ${messageBodyHtml}
                </div>
            </div>
        `;
    }).join('\n');
}

function buildTranscriptHtml(snapshot, settings) {
    const renderedTranscript = normalizeRenderedTranscript(snapshot?.renderedTranscript);
    if (!renderedTranscript.html) {
        return renderFallbackTranscriptHtml(snapshot, settings);
    }

    if (settings.includeReasoning) {
        return renderedTranscript.html;
    }

    const host = document.createElement('div');
    host.innerHTML = renderedTranscript.html;
    host.querySelectorAll('.reasoning-wrapper').forEach((node) => node.remove());
    return host.innerHTML;
}

function buildSnapshotDocument(snapshot, settings) {
    const exportTheme = resolveExportTheme(settings, snapshot);
    const locale = snapshot?.locale || 'en-US';
    const title = normalizeString(snapshot?.chat?.title, t(locale, 'plugin_title'));
    const transcriptHtml = buildTranscriptHtml(snapshot, settings);
    const transcriptStyles = sanitizeInlineStyleText(snapshot?.renderedTranscript?.styleText || '');
    const payload = {
        snapshot: {
            collectedAt: snapshot?.collectedAt,
            locale: snapshot?.locale,
            runtimeHost: snapshot?.runtimeHost,
            chat: cloneValue(snapshot?.chat, null),
            tab: settings.includeMetadata ? cloneValue(snapshot?.tab, null) : null,
            theme: cloneValue(snapshot?.theme, null),
            draft: settings.includeDraft ? cloneValue(snapshot?.draft, null) : null,
            messages: cloneValue(snapshot?.messages, []),
            summary: cloneValue(snapshot?.summary, null),
            renderedTranscript: {
                available: !!normalizeString(snapshot?.renderedTranscript?.html),
                messageCount: Number(snapshot?.renderedTranscript?.messageCount || 0),
                imageCount: Number(snapshot?.renderedTranscript?.imageCount || 0),
            },
        },
        settings: {
            ...normalizeSettings(settings),
            resolvedTheme: exportTheme,
        },
    };

    return `<!DOCTYPE html>
<html lang="${escapeHtml(normalizeLocaleTag(snapshot?.locale, 'zh-CN'))}" class="${exportTheme === 'dark' ? 'dark-theme' : 'light-theme'}">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} - Cerebr</title>
    <style>
${transcriptStyles}
        body {
            padding-top: 0;
            padding-bottom: 0;
        }

        #chat-container[data-cerebr-export="1"] {
            padding-top: calc(15px + env(safe-area-inset-top));
            padding-bottom: calc(24px + env(safe-area-inset-bottom));
        }

        #chat-container[data-cerebr-export="1"] .message {
            opacity: 1;
            transform: none;
            animation: none;
        }

        #chat-container[data-cerebr-export="1"] .image-tag {
            cursor: default;
        }

        #chat-container[data-cerebr-export="1"] .image-tag .delete-btn {
            display: none !important;
        }

        #chat-container[data-cerebr-export="1"] .reasoning-content {
            cursor: pointer;
        }

        #chat-container[data-cerebr-export="1"] .snapshot-fallback-text {
            white-space: pre-wrap;
            word-break: break-word;
            line-height: 1.5;
        }
    </style>
</head>
<body>
    <main id="chat-container" data-cerebr-export="1">
        ${transcriptHtml}
    </main>

    <script id="cerebr-snapshot-data" type="application/json">${escapeHtml(JSON.stringify(payload, null, 2))}</script>
    <script>
        (() => {
            const transcriptRoot = document.getElementById('chat-container');
            transcriptRoot?.addEventListener('click', (event) => {
                const eventTarget = event.target instanceof Element ? event.target : null;
                const reasoningContent = eventTarget?.closest('.reasoning-content');
                if (reasoningContent) {
                    reasoningContent.classList.toggle('collapsed');
                }
            });
        })();
    </script>
</body>
</html>`;
}

async function downloadTextFile(text, filename) {
    const blob = new Blob([text], { type: 'text/html;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, 1000);
    return blob.size;
}

async function copyText(text) {
    if (navigator?.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            // Fall back to execCommand when the document is not focused or clipboard APIs are blocked.
        }
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    try {
        if (document.execCommand('copy')) {
            return true;
        }
    } finally {
        textarea.remove();
    }

    throw new Error(t(navigator.language, 'clipboard_unavailable'));
}

function describeClipboardError(error, locale = 'en-US') {
    const message = normalizeString(error?.message || error, t(locale, 'clipboard_unavailable'));
    if (/document is not focused/i.test(message)) {
        return t(locale, 'document_not_focused');
    }
    return message;
}

async function copyTextWithApi(api, text) {
    if (typeof api?.ui?.copyText === 'function') {
        return api.ui.copyText(text);
    }

    return copyText(text);
}

async function readResponseJsonSafe(response) {
    const responseText = await response.text();
    if (!responseText) {
        return {};
    }

    try {
        return JSON.parse(responseText);
    } catch {
        return {
            error: responseText,
        };
    }
}

async function uploadSnapshotToServer({ snapshot, settings, html }) {
    const locale = snapshot?.locale || 'en-US';
    const serverUrl = normalizeServerUrl(settings?.serverUrl);
    if (!serverUrl) {
        throw new Error(t(locale, 'server_url_required'));
    }

    const controller = typeof AbortController === 'function'
        ? new AbortController()
        : null;
    const timeoutId = controller
        ? window.setTimeout(() => controller.abort(), DEFAULT_UPLOAD_TIMEOUT_MS)
        : 0;

    try {
        const response = await fetch(`${serverUrl}/api/snapshots`, {
            method: 'POST',
            mode: 'cors',
            headers: {
                'Content-Type': 'application/json',
                ...(normalizeString(settings?.uploadToken)
                    ? { Authorization: `Bearer ${normalizeString(settings.uploadToken)}` }
                    : {}),
            },
            body: JSON.stringify({
                filename: buildExportFileName(snapshot, settings),
                html,
                snapshot: {
                    collectedAt: snapshot?.collectedAt,
                    locale: snapshot?.locale,
                    runtimeHost: snapshot?.runtimeHost,
                    chat: snapshot?.chat,
                    tab: snapshot?.tab,
                    summary: snapshot?.summary,
                },
            }),
            signal: controller?.signal,
        });

        const payload = await readResponseJsonSafe(response);
        if (!response.ok) {
            throw new Error(normalizeString(payload?.error, t(locale, 'upload_failed_status', { status: response.status })));
        }

        const shareUrl = normalizeReturnedShareUrl(payload?.shareUrl, serverUrl);
        if (!shareUrl) {
            throw new Error(t(locale, 'server_response_missing_share_url'));
        }

        return {
            id: normalizeString(payload?.id),
            shareUrl,
            deleteToken: normalizeString(payload?.deleteToken),
        };
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new Error(t(locale, 'upload_timed_out'));
        }
        throw error;
    } finally {
        if (timeoutId) {
            window.clearTimeout(timeoutId);
        }
    }
}

function openShareUrl(url = '') {
    const shareUrl = normalizeString(url);
    if (!shareUrl) {
        return false;
    }

    window.open(shareUrl, '_blank', 'noopener,noreferrer');
    return true;
}

function normalizeReturnedShareUrl(shareUrl, serverUrl = '') {
    const normalizedShareUrl = normalizeString(shareUrl);
    if (!normalizedShareUrl) {
        return '';
    }

    try {
        const resolvedShareUrl = new URL(normalizedShareUrl);
        const resolvedServerUrl = new URL(normalizeServerUrl(serverUrl));
        if (
            resolvedServerUrl.protocol === 'https:'
            && resolvedShareUrl.protocol === 'http:'
            && resolvedServerUrl.hostname === resolvedShareUrl.hostname
        ) {
            resolvedShareUrl.protocol = 'https:';
            return resolvedShareUrl.toString();
        }
        return resolvedShareUrl.toString();
    } catch {
        return normalizedShareUrl;
    }
}

function extractSnapshotIdFromShareUrl(shareUrl = '') {
    const normalizedShareUrl = normalizeString(shareUrl);
    if (!normalizedShareUrl) {
        return '';
    }

    try {
        const { pathname } = new URL(normalizedShareUrl);
        const match = pathname.match(/^\/s\/([A-Za-z0-9_-]{5,32})$/);
        return normalizeString(match?.[1]);
    } catch {
        return '';
    }
}

function resolveHistoryRemoteLocation(entry = {}) {
    const shareUrl = normalizeString(entry?.shareUrl);
    if (!shareUrl) {
        return null;
    }

    try {
        const parsed = new URL(shareUrl);
        const snapshotId = normalizeString(entry?.snapshotId, extractSnapshotIdFromShareUrl(shareUrl));
        if (!snapshotId) {
            return null;
        }

        return {
            origin: parsed.origin,
            snapshotId,
            deleteUrl: `${parsed.origin}/api/snapshots/${snapshotId}`,
        };
    } catch {
        return null;
    }
}

async function deleteSnapshotFromServer({ entry, settings }) {
    const locale = settings?.locale || 'en-US';
    const remoteLocation = resolveHistoryRemoteLocation(entry);
    if (!remoteLocation) {
        throw new Error(t(locale, 'remote_snapshot_url_unavailable'));
    }

    const deleteToken = normalizeString(entry?.deleteToken);
    const uploadToken = normalizeString(settings?.uploadToken);

    const controller = typeof AbortController === 'function'
        ? new AbortController()
        : null;
    const timeoutId = controller
        ? window.setTimeout(() => controller.abort(), DEFAULT_UPLOAD_TIMEOUT_MS)
        : 0;

    try {
        const response = await fetch(remoteLocation.deleteUrl, {
            method: 'DELETE',
            mode: 'cors',
            headers: {
                ...(deleteToken
                    ? { 'X-Delete-Token': deleteToken }
                    : {}),
                ...(uploadToken
                    ? { Authorization: `Bearer ${uploadToken}` }
                    : {}),
            },
            signal: controller?.signal,
        });
        const payload = await readResponseJsonSafe(response);
        if (response.status === 404) {
            return {
                deleted: false,
                missing: true,
                snapshotId: remoteLocation.snapshotId,
            };
        }
        if (!response.ok) {
            if (response.status === 401 && !deleteToken && !uploadToken) {
                throw new Error(t(locale, 'history_delete_unavailable'));
            }
            throw new Error(normalizeString(payload?.error, t(locale, 'delete_failed_status', { status: response.status })));
        }

        return {
            deleted: true,
            missing: false,
            snapshotId: remoteLocation.snapshotId,
        };
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new Error(t(locale, 'delete_timed_out'));
        }
        throw error;
    } finally {
        if (timeoutId) {
            window.clearTimeout(timeoutId);
        }
    }
}

function matchHistoryEntry(entry = {}, query = '') {
    const normalizedQuery = normalizeHistoryQuery(query).toLowerCase();
    if (!normalizedQuery) {
        return true;
    }

    const haystack = [
        entry.previewText,
        entry.filename,
        entry.chatTitle,
        entry.shareUrl,
        entry.snapshotId,
        formatDateTime(entry.updatedAt || entry.createdAt, 'en-US'),
    ].join('\n').toLowerCase();
    return haystack.includes(normalizedQuery);
}

function buildHistoryPageState(history = [], historyUi = {}, locale = 'en-US') {
    const normalizedUi = normalizeHistoryUiState(historyUi);
    const filteredEntries = history.filter((entry) => matchHistoryEntry(entry, normalizedUi.query));
    const filteredCount = filteredEntries.length;
    const pageCount = Math.max(1, Math.ceil(Math.max(filteredCount, 1) / normalizedUi.pageSize));
    const page = Math.min(normalizedUi.page, pageCount);
    const startIndex = filteredCount === 0
        ? 0
        : (page - 1) * normalizedUi.pageSize;
    const endIndex = Math.min(startIndex + normalizedUi.pageSize, filteredCount);

    return {
        query: normalizedUi.query,
        pageSize: normalizedUi.pageSize,
        page,
        pageCount,
        totalCount: history.length,
        filteredCount,
        rangeStart: filteredCount === 0 ? 0 : startIndex + 1,
        rangeEnd: filteredCount === 0 ? 0 : endIndex,
        items: filteredEntries.slice(startIndex, endIndex),
        hasPrevious: filteredCount > 0 && page > 1,
        hasNext: filteredCount > 0 && page < pageCount,
        pageOptions: Array.from({ length: pageCount }, (_, index) => ({
            value: String(index + 1),
            label: t(locale, 'history_page_option', { page: index + 1, count: pageCount }),
        })),
    };
}

function buildHistoryPaginationItems(historyPage = {}, locale = 'en-US') {
    const pageCount = Math.max(1, Number(historyPage.pageCount || 1));
    const currentPage = Math.min(Math.max(1, Number(historyPage.page || 1)), pageCount);
    const items = [];
    const pushPage = (page) => {
        items.push({
            id: `history-page-${page}`,
            label: String(page),
            title: t(locale, 'history_page_option', { page, count: pageCount }),
            actionId: page === currentPage ? '' : `history-page:${page}`,
            selected: page === currentPage,
            disabled: page === currentPage,
        });
    };
    const pushGap = (id) => {
        items.push({
            id,
            label: '…',
            disabled: true,
        });
    };

    if (pageCount <= 7) {
        for (let page = 1; page <= pageCount; page += 1) {
            pushPage(page);
        }
        return items;
    }

    pushPage(1);

    const windowStart = Math.max(2, currentPage - 1);
    const windowEnd = Math.min(pageCount - 1, currentPage + 1);

    if (windowStart > 2) {
        pushGap('history-page-gap-start');
    }

    for (let page = windowStart; page <= windowEnd; page += 1) {
        pushPage(page);
    }

    if (windowEnd < pageCount - 1) {
        pushGap('history-page-gap-end');
    }

    pushPage(pageCount);
    return items;
}

function buildHistoryListItems(history = [], locale = 'zh-CN') {
    return history.map((entry) => {
        const latestActivityAt = normalizeString(entry.updatedAt, entry.createdAt);
        const normalizedPreviewText = normalizeHistoryPreviewText(entry.previewText);
        const normalizedChatTitle = normalizeString(entry.chatTitle);
        const normalizedChatTitlePreview = normalizeHistoryPreviewText(normalizedChatTitle);
        const title = !isGenericPluginTitle(normalizedPreviewText)
            ? normalizedPreviewText
            : (!isGenericPluginTitle(normalizedChatTitlePreview) ? normalizedChatTitlePreview : '');
        const description = normalizedChatTitlePreview
            && !isGenericPluginTitle(normalizedChatTitlePreview)
            && normalizedChatTitlePreview !== title
            ? normalizedChatTitlePreview
            : '';

        return {
            id: entry.id,
            title,
            description,
            meta: [
                formatDateTime(latestActivityAt, locale),
                entry.bytes > 0 ? formatBytes(entry.bytes) : '',
                entry.messageCount > 0 ? t(locale, 'history_msgs', { count: entry.messageCount }) : '',
            ].filter(Boolean).join(' · '),
            actionId: entry.shareUrl ? `history-open:${entry.id}` : '',
            badges: [],
            actions: [
                ...(entry.shareUrl
                    ? [
                        {
                            id: `history-copy:${entry.id}`,
                            label: t(locale, 'history_copy_link'),
                            variant: 'secondary',
                        },
                        {
                            id: `history-delete:${entry.id}`,
                            label: t(locale, 'history_delete_link'),
                            variant: 'danger',
                            confirm: t(locale, 'history_confirm_delete_link'),
                        },
                    ]
                    : []),
                ...(!entry.shareUrl
                    ? [
                        {
                            id: `history-delete:${entry.id}`,
                            label: t(locale, 'history_delete'),
                            variant: 'danger',
                            confirm: t(locale, 'history_confirm_delete'),
                        },
                    ]
                    : []),
            ],
        };
    });
}

function findHistoryEntry(history = [], entryId = '') {
    const normalizedEntryId = normalizeString(entryId);
    if (!normalizedEntryId) {
        return null;
    }

    return normalizeHistory(history).find((entry) => entry.id === normalizedEntryId) || null;
}

function removeHistoryEntry(history = [], entryId = '') {
    const normalizedEntryId = normalizeString(entryId);
    return normalizeHistory(history).filter((entry) => entry.id !== normalizedEntryId);
}

function syncHistoryUiStateWithHistory(state = {}) {
    state.history = normalizeHistory(state.history);
    const historyPage = buildHistoryPageState(state.history, state.historyUi, state.snapshot?.locale || 'en-US');
    state.historyUi = normalizeHistoryUiState({
        ...state.historyUi,
        query: historyPage.query,
        pageSize: historyPage.pageSize,
        page: historyPage.page,
    });
    return historyPage;
}

function applyHistoryUiChange(state = {}, event = {}) {
    const fieldId = normalizeString(event?.fieldId);
    if (!fieldId) {
        return false;
    }

    if (fieldId === HISTORY_QUERY_FIELD_ID) {
        state.historyUi = normalizeHistoryUiState({
            ...state.historyUi,
            query: event?.value,
            page: 1,
        });
        return true;
    }

    if (fieldId === HISTORY_PAGE_SIZE_FIELD_ID) {
        state.historyUi = normalizeHistoryUiState({
            ...state.historyUi,
            pageSize: event?.value,
            page: 1,
        });
        return true;
    }

    if (fieldId === HISTORY_PAGE_FIELD_ID) {
        state.historyUi = normalizeHistoryUiState({
            ...state.historyUi,
            page: event?.value,
        });
        return true;
    }

    return false;
}

function buildPageModel(state = {}) {
    const fallbackLocale = state.snapshot?.locale || navigator.language || 'zh-CN';
    const snapshot = state.snapshot || {
        locale: normalizeLocaleTag(fallbackLocale, 'zh-CN'),
        runtimeHost: detectRuntimeHost(),
        chat: {
            id: 'current-chat',
            title: t(fallbackLocale, 'plugin_title'),
        },
        theme: {
            isDark: false,
        },
        draft: {
            text: '',
            empty: true,
        },
        messages: [],
        summary: buildSummary([], { empty: true, text: '' }),
    };
    const settings = normalizeSettings(state.settings);
    const history = normalizeHistory(state.history);
    const locale = snapshot.locale || 'zh-CN';
    const historyUi = normalizeHistoryUiState(state.historyUi);
    const historyPage = buildHistoryPageState(history, historyUi, locale);
    const historyItems = buildHistoryListItems(historyPage.items, locale);
    const hasHistory = historyPage.totalCount > 0;
    const serverConfigured = !!normalizeServerUrl(settings.serverUrl);
    const shareAvailable = canShareSnapshot(snapshot);
    const uploadSpinner = UPLOAD_SPINNER_FRAMES[state.uploadSpinnerFrame % UPLOAD_SPINNER_FRAMES.length] || UPLOAD_SPINNER_FRAMES[0];

    return {
        id: PAGE_ID,
        title: t(locale, 'plugin_title'),
        subtitle: state.source === 'menu'
            ? t(locale, 'page_subtitle_menu')
            : t(locale, 'page_subtitle_default'),
        viewStateKey: normalizeString(snapshot.chat?.id, 'current-chat'),
        view: {
            sections: [
                {
                    kind: 'card',
                    title: t(locale, 'export_settings_title'),
                    description: t(locale, 'export_settings_description'),
                    body: [
                        {
                            kind: 'actions',
                            align: 'start',
                            actions: [
                                {
                                    id: 'upload-share',
                                    label: state.uploading ? t(locale, 'upload_button_loading') : t(locale, 'upload_button'),
                                    icon: state.uploading ? uploadSpinner : '',
                                    variant: 'primary',
                                    disabled: !serverConfigured || !shareAvailable || !!state.uploading,
                                },
                            ],
                        },
                        {
                            kind: 'form',
                            columns: 1,
                            fields: [
                                {
                                    id: 'serverUrl',
                                    type: 'text',
                                    label: t(locale, 'server_url_label'),
                                    value: settings.serverUrl,
                                    placeholder: t(locale, 'server_url_placeholder'),
                                    description: t(locale, 'server_url_description'),
                                },
                                {
                                    id: 'uploadToken',
                                    type: 'text',
                                    label: t(locale, 'upload_token_label'),
                                    value: settings.uploadToken,
                                    placeholder: t(locale, 'upload_token_placeholder'),
                                    description: t(locale, 'upload_token_description'),
                                },
                            ],
                        },
                    ],
                },
                {
                    kind: 'card',
                    title: t(locale, 'recent_exports_title'),
                    description: t(locale, 'recent_exports_description'),
                    body: [
                        hasHistory
                            ? {
                                kind: 'form',
                                columns: 1,
                                fields: [
                                    {
                                        id: HISTORY_QUERY_FIELD_ID,
                                        type: 'text',
                                        label: t(locale, 'find_export_label'),
                                        value: historyPage.query,
                                        placeholder: t(locale, 'find_export_placeholder'),
                                        description: t(locale, 'find_export_description', { count: historyPage.totalCount }),
                                        action: {
                                            id: 'history-clear-search',
                                            label: t(locale, 'history_clear_search'),
                                            variant: 'secondary',
                                            disabled: !historyPage.query,
                                        },
                                    },
                                ],
                            }
                            : null,
                        {
                            kind: 'list',
                            items: historyItems,
                            emptyText: hasHistory && historyPage.query
                                ? t(locale, 'history_empty_search')
                                : t(locale, 'history_no_saved'),
                        },
                        hasHistory
                            ? {
                                kind: 'pagination',
                                pageSize: {
                                    fieldId: HISTORY_PAGE_SIZE_FIELD_ID,
                                    label: t(locale, 'pagination_per_page_label'),
                                    value: String(historyPage.pageSize),
                                    options: HISTORY_PAGE_SIZE_OPTIONS.map((pageSize) => ({
                                        value: String(pageSize),
                                        label: t(locale, 'per_page_option', { count: pageSize }),
                                    })),
                                },
                                previousAction: {
                                    id: 'history-prev-page-button',
                                    actionId: 'history-prev-page',
                                    label: '←',
                                    title: t(locale, 'history_previous'),
                                    disabled: !historyPage.hasPrevious,
                                },
                                pages: buildHistoryPaginationItems(historyPage, locale),
                                nextAction: {
                                    id: 'history-next-page-button',
                                    actionId: 'history-next-page',
                                    label: '→',
                                    title: t(locale, 'history_next'),
                                    disabled: !historyPage.hasNext,
                                },
                                jump: {
                                    fieldId: HISTORY_PAGE_FIELD_ID,
                                    label: t(locale, 'pagination_jump_label'),
                                    value: String(historyPage.page),
                                    options: Array.from({ length: historyPage.pageCount }, (_, index) => ({
                                        value: String(index + 1),
                                        label: String(index + 1),
                                    })),
                                    disabled: historyPage.pageCount <= 1,
                                    suffix: `/ ${historyPage.pageCount}`,
                                },
                            }
                            : null,
                    ],
                },
            ],
        },
    };
}

function mergeSettingsFromPageValues(values = {}, previousSettings = {}) {
    return normalizeSettings({
        ...previousSettings,
        filename: normalizeString(values.filename, previousSettings.filename),
        serverUrl: normalizeServerUrl(values.serverUrl, previousSettings.serverUrl),
        uploadToken: normalizeString(values.uploadToken, previousSettings.uploadToken),
        themeMode: normalizeThemeMode(values.themeMode, previousSettings.themeMode),
        includeMetadata: normalizeBoolean(values.includeMetadata, previousSettings.includeMetadata),
        includeReasoning: normalizeBoolean(values.includeReasoning, previousSettings.includeReasoning),
        includeDraft: normalizeBoolean(values.includeDraft, previousSettings.includeDraft),
    });
}

async function persistState(api, state) {
    await api.storage?.set?.({
        [SETTINGS_KEY]: normalizeSettings(state.settings),
        [HISTORY_KEY]: normalizeHistory(state.history),
    }, { area: 'local' });
}

function createHistoryEntry({
    id = '',
    mode,
    filename,
    bytes,
    snapshot,
    themeMode,
    shareUrl = '',
    snapshotId = '',
    deleteToken = '',
    exportDigest = '',
}) {
    const timestamp = new Date().toISOString();
    const isLocalExport = mode === 'download' || mode === 'copy';
    const normalizedShareUrl = normalizeString(shareUrl);
    const normalizedSnapshotId = normalizeString(snapshotId, extractSnapshotIdFromShareUrl(normalizedShareUrl));

    return createHistoryItem({
        id: normalizeString(id, buildHistoryEntryId({
            chatId: snapshot?.chat?.id,
            chatTitle: snapshot?.chat?.title,
            filename,
            shareUrl: normalizedShareUrl,
            snapshotId: normalizedSnapshotId,
        })),
        chatId: normalizeString(snapshot?.chat?.id),
        createdAt: timestamp,
        updatedAt: timestamp,
        mode,
        filename,
        chatTitle: normalizeString(snapshot?.chat?.title, t(snapshot?.locale, 'plugin_title')),
        previewText: buildHistoryPreviewText(
            snapshot,
            normalizeString(snapshot?.chat?.title, t(snapshot?.locale, 'plugin_title'))
        ),
        shareUrl: normalizedShareUrl,
        snapshotId: normalizedSnapshotId,
        deleteToken: normalizeString(deleteToken),
        messageCount: Number(snapshot?.summary?.messageCount || 0),
        bytes: Number(bytes || 0),
        themeMode: normalizeThemeMode(themeMode, 'current'),
        exportDigest: normalizeString(exportDigest),
        hasLocalExport: isLocalExport,
        lastLocalMode: isLocalExport ? mode : '',
        lastLocalExportAt: isLocalExport ? timestamp : '',
        lastUploadAt: mode === 'upload' ? timestamp : '',
    });
}

export default {
    id: PLUGIN_ID,
    displayName: 'Cerebr Snapshot Share',
    async setup(runtimeContext) {
        const api = runtimeContext?.api || runtimeContext || {};
        setRuntimeI18nApi(api.i18n);
        const permissions = runtimeContext?.permissions || null;
        const diagnostics = runtimeContext?.diagnostics || null;
        const getLocale = () => state?.snapshot?.locale || api.i18n?.getLocale?.() || navigator.language || 'zh-CN';

        permissions?.assert?.('chat:current', ['chat:read']);
        permissions?.assert?.('chat:messages', ['chat:read']);
        permissions?.assert?.('shell:menu:items', ['shell:menu']);
        permissions?.assert?.('shell:page:control', ['shell:page']);
        permissions?.assert?.('storage:read:local', ['storage:read']);
        permissions?.assert?.('storage:write:local', ['storage:write']);

        if (diagnostics?.preflight?.ok === false) {
            throw new Error(t(api.i18n?.getLocale?.(), 'plugin_preflight_failed'));
        }

        const storedState = await api.storage?.get?.([SETTINGS_KEY, HISTORY_KEY], { area: 'local' }) || {};
        let state = {
            source: 'menu',
            pageOpen: false,
            uploading: false,
            uploadSpinnerFrame: 0,
            settings: normalizeSettings(storedState[SETTINGS_KEY]),
            history: normalizeHistory(storedState[HISTORY_KEY]),
            historyUi: createDefaultHistoryUiState(),
            snapshot: await collectSnapshot(api),
        };
        syncHistoryUiStateWithHistory(state);
        await persistState(api, state);
        let uploadSpinnerTimer = 0;
        let previewHydrationPromise = null;

        const refreshSnapshot = async () => {
            state.snapshot = await collectSnapshot(api);
            return state.snapshot;
        };

        const syncPage = async () => {
            if (!state.pageOpen) {
                return false;
            }
            await api.shell.updatePage(buildPageModel(state));
            return true;
        };

        const syncMenuItems = () => {
            api.shell.setMenuItems([
                {
                    id: 'snapshot-open',
                    icon: '↗',
                    iconSvg: MENU_ICON_SHARE_SVG,
                    iconPlacement: 'disclosure',
                    label: t(getLocale(), 'menu_label'),
                    title: t(getLocale(), 'menu_title'),
                    order: 70,
                },
            ]);
        };

        const hydrateHistoryPreviews = async () => {
            const pendingEntries = normalizeHistory(state.history).filter((entry) => {
                return !!normalizeString(entry.shareUrl)
                    && (isGenericPluginTitle(entry.previewText) || !normalizeString(entry.previewText));
            });
            if (pendingEntries.length === 0) {
                return false;
            }

            let nextHistory = state.history;
            let changed = false;

            for (const entry of pendingEntries) {
                const previewText = await fetchHistoryPreviewFromRemote(entry);
                if (!previewText || isGenericPluginTitle(previewText)) {
                    continue;
                }

                nextHistory = upsertHistoryEntry(nextHistory, createHistoryItem({
                    ...entry,
                    previewText,
                }));
                changed = true;
            }

            if (!changed) {
                return false;
            }

            state.history = nextHistory;
            syncHistoryUiStateWithHistory(state);
            await persistState(api, state);
            await syncPage();
            return true;
        };

        const ensureHistoryPreviewHydration = () => {
            if (previewHydrationPromise) {
                return previewHydrationPromise;
            }

            previewHydrationPromise = hydrateHistoryPreviews()
                .catch(() => false)
                .finally(() => {
                    previewHydrationPromise = null;
                });
            return previewHydrationPromise;
        };

        const startUploadFeedback = () => {
            if (state.uploading) {
                return;
            }
            state.uploading = true;
            state.uploadSpinnerFrame = 0;
            void syncPage();

            uploadSpinnerTimer = window.setInterval(() => {
                state.uploadSpinnerFrame = (state.uploadSpinnerFrame + 1) % UPLOAD_SPINNER_FRAMES.length;
                void syncPage();
            }, 120);
        };

        const stopUploadFeedback = () => {
            if (uploadSpinnerTimer) {
                window.clearInterval(uploadSpinnerTimer);
                uploadSpinnerTimer = 0;
            }
            if (!state.uploading && state.uploadSpinnerFrame === 0) {
                return;
            }
            state.uploading = false;
            state.uploadSpinnerFrame = 0;
            void syncPage();
        };

        const openPage = async (source = 'menu') => {
            state.source = source;
            await refreshSnapshot();
            await api.shell.openPage(buildPageModel(state));
            void ensureHistoryPreviewHydration();
        };

        const uploadSnapshot = async () => {
            const snapshot = await collectLiveSnapshot(api, state.snapshot);
            state.snapshot = snapshot;
            if (!canShareSnapshot(snapshot)) {
                await syncPage();
                throw new Error(t(getLocale(), 'share_empty_chat_unavailable'));
            }
            const filename = buildExportFileName(snapshot, state.settings);
            const html = buildSnapshotDocument(snapshot, state.settings);
            const bytes = new Blob([html], { type: 'text/html;charset=utf-8' }).size;
            const exportDigest = await computeExportDigest(html);
            const reusableEntry = findReusableRemoteHistoryEntry(state.history, snapshot, exportDigest);

            if (reusableEntry?.shareUrl && reusableEntry.exportDigest && reusableEntry.exportDigest === exportDigest) {
                state.history = upsertHistoryEntry(state.history, createHistoryEntry({
                    id: reusableEntry.id,
                    mode: 'upload',
                    filename,
                    bytes,
                    snapshot,
                    themeMode: resolveExportTheme(state.settings, snapshot),
                    snapshotId: reusableEntry.snapshotId,
                    shareUrl: reusableEntry.shareUrl,
                    deleteToken: reusableEntry.deleteToken,
                    exportDigest,
                }));
                state.historyUi.page = 1;
                syncHistoryUiStateWithHistory(state);
                await persistState(api, state);
                await syncPage();

                try {
                    await copyTextWithApi(api, reusableEntry.shareUrl);
                    api.ui.showToast(t(getLocale(), 'reused_short_link', { url: reusableEntry.shareUrl }));
                } catch (error) {
                    api.ui.showToast(
                        t(getLocale(), 'share_link_unchanged_copy_failed', {
                            reason: describeClipboardError(error, getLocale()),
                        }),
                        { type: 'warning' }
                    );
                }

                return {
                    id: reusableEntry.snapshotId,
                    shareUrl: reusableEntry.shareUrl,
                    deleteToken: reusableEntry.deleteToken,
                    reused: true,
                };
            }

            const uploadResult = await uploadSnapshotToServer({
                snapshot,
                settings: state.settings,
                html,
            });

            state.history = upsertHistoryEntry(state.history, createHistoryEntry({
                mode: 'upload',
                filename,
                bytes,
                snapshot,
                themeMode: resolveExportTheme(state.settings, snapshot),
                snapshotId: uploadResult.id,
                shareUrl: uploadResult.shareUrl,
                deleteToken: uploadResult.deleteToken,
                exportDigest,
            }));
            state.historyUi.page = 1;
            syncHistoryUiStateWithHistory(state);
            await persistState(api, state);
            await syncPage();

            try {
                await copyTextWithApi(api, uploadResult.shareUrl);
                api.ui.showToast(t(getLocale(), 'copied_short_link', { url: uploadResult.shareUrl }));
            } catch (error) {
                api.ui.showToast(
                    t(getLocale(), 'upload_succeeded_copy_failed', {
                        reason: describeClipboardError(error, getLocale()),
                    }),
                    { type: 'warning' }
                );
            }

            return uploadResult;
        };

        const stopMenuActions = api.shell.onMenuAction((event) => {
            if (event?.itemId === 'snapshot-open') {
                void openPage('menu');
            }
        });

        const stopPageEvents = api.shell.onPageEvent((event) => {
            if (event?.type === 'open') {
                state.pageOpen = true;
                void ensureHistoryPreviewHydration();
                return;
            }

            if (event?.type === 'close') {
                state.pageOpen = false;
                return;
            }

            if (event?.type === 'change') {
                if (applyHistoryUiChange(state, event)) {
                    syncHistoryUiStateWithHistory(state);
                    void syncPage();
                    return;
                }
                state.settings = mergeSettingsFromPageValues(event.values, state.settings);
                void persistState(api, state);
                void syncPage();
                return;
            }

            if (event?.type !== 'action') {
                return;
            }

            if (event.actionId === 'upload-share') {
                if (state.uploading) {
                    return;
                }
                startUploadFeedback();
                void uploadSnapshot()
                    .catch((error) => {
                        api.ui.showToast(t(getLocale(), 'upload_failed', {
                            reason: error?.message || String(error),
                        }), { type: 'error' });
                    })
                    .finally(() => {
                        stopUploadFeedback();
                    });
                return;
            }

            if (event.actionId === 'history-prev-page') {
                state.historyUi = normalizeHistoryUiState({
                    ...state.historyUi,
                    page: state.historyUi.page - 1,
                });
                syncHistoryUiStateWithHistory(state);
                void syncPage();
                return;
            }

            if (event.actionId === 'history-next-page') {
                state.historyUi = normalizeHistoryUiState({
                    ...state.historyUi,
                    page: state.historyUi.page + 1,
                });
                syncHistoryUiStateWithHistory(state);
                void syncPage();
                return;
            }

            if (String(event.actionId).startsWith('history-page:')) {
                const targetPage = Number(String(event.actionId).slice('history-page:'.length));
                if (Number.isFinite(targetPage) && targetPage > 0) {
                    state.historyUi = normalizeHistoryUiState({
                        ...state.historyUi,
                        page: targetPage,
                    });
                    syncHistoryUiStateWithHistory(state);
                    void syncPage();
                }
                return;
            }

            if (event.actionId === 'history-clear-search') {
                state.historyUi = normalizeHistoryUiState({
                    ...state.historyUi,
                    query: '',
                    page: 1,
                });
                syncHistoryUiStateWithHistory(state);
                void syncPage();
                return;
            }

            if (String(event.actionId).startsWith('history-copy:')) {
                const historyEntry = findHistoryEntry(state.history, String(event.actionId).slice('history-copy:'.length));
                if (!historyEntry?.shareUrl) {
                    api.ui.showToast(t(getLocale(), 'share_link_unavailable'), { type: 'error' });
                    return;
                }
                void copyTextWithApi(api, historyEntry.shareUrl)
                    .then(() => api.ui.showToast(t(getLocale(), 'copied_short_link', { url: historyEntry.shareUrl })))
                    .catch((error) => {
                        api.ui.showToast(t(getLocale(), 'copy_failed', {
                            reason: describeClipboardError(error, getLocale()),
                        }), { type: 'error' });
                    });
                return;
            }

            if (String(event.actionId).startsWith('history-open:')) {
                const historyEntry = findHistoryEntry(state.history, String(event.actionId).slice('history-open:'.length));
                if (!historyEntry?.shareUrl) {
                    api.ui.showToast(t(getLocale(), 'share_link_unavailable'), { type: 'error' });
                    return;
                }
                openShareUrl(historyEntry.shareUrl);
                return;
            }

            if (String(event.actionId).startsWith('history-delete:')) {
                const historyEntry = findHistoryEntry(state.history, String(event.actionId).slice('history-delete:'.length));
                if (!historyEntry) {
                    api.ui.showToast(t(getLocale(), 'history_entry_not_found'), { type: 'error' });
                    return;
                }

                void (async () => {
                    const hasRemoteLink = !!normalizeString(historyEntry.shareUrl);
                    let deleteResult = null;

                    if (hasRemoteLink) {
                        deleteResult = await deleteSnapshotFromServer({
                            entry: historyEntry,
                            settings: {
                                ...state.settings,
                                locale: getLocale(),
                            },
                        });
                    }

                    state.history = removeHistoryEntry(state.history, historyEntry.id);
                    syncHistoryUiStateWithHistory(state);
                    await persistState(api, state);
                    await syncPage();

                    if (deleteResult?.deleted) {
                        api.ui.showToast(t(getLocale(), 'deleted_local_and_remote', {
                            id: deleteResult.snapshotId,
                        }));
                        return;
                    }

                    if (deleteResult?.missing) {
                        api.ui.showToast(t(getLocale(), 'remote_missing_local_deleted'), {
                            type: 'warning',
                        });
                        return;
                    }

                    api.ui.showToast(t(getLocale(), 'deleted_history_record'));
                })().catch((error) => {
                    api.ui.showToast(t(getLocale(), 'delete_failed', {
                        reason: error?.message || String(error),
                    }), { type: 'error' });
                });
            }
        });

        const stopThemeObserver = api.shell.observeTheme(() => {
            if (state.settings.themeMode !== 'current') {
                return;
            }
            void refreshSnapshot().then(() => syncPage()).catch(() => {});
        });
        const stopLocaleObserver = api.i18n?.onLocaleChanged?.(() => {
            syncMenuItems();
            void refreshSnapshot().then(() => syncPage()).catch(() => {});
        });

        syncMenuItems();

        return () => {
            stopUploadFeedback();
            stopMenuActions?.();
            stopPageEvents?.();
            stopThemeObserver?.();
            stopLocaleObserver?.();
            setRuntimeI18nApi(null);
            api.shell.clearMenuItems();
            void api.shell.closePage('plugin-stop');
        };
    },
};
