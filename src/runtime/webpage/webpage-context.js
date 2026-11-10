import { storageAdapter, browserAdapter } from '../../utils/storage-adapter.js';
import { chatManager } from '../../domain/chat/chat-store.js';
import { t } from '../../utils/i18n.js';
import {
    getCachedWebpagesForChat,
    getWebpageCacheRevision,
    getWebpageSwitchesForChat,
    isNewWebpageConversation,
    saveCachedWebpagesForChat,
    sameWebpageCacheRevision,
    webpageCacheIdentity,
} from '../../utils/webpage-switches.js';
import { createChatError } from '../chat/chat-errors.js';
import { desktopBrowserStore } from '../../platform/desktop-browser.js';

const YT_TRANSCRIPT_KEY_PREFIX = 'cerebr_youtube_transcript_v1_';

function isYouTubeHost(hostname) {
    if (!hostname) return false;
    const host = String(hostname).toLowerCase();
    return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
}

function getYouTubeVideoIdFromUrl(urlString) {
    try {
        const url = new URL(urlString);
        if (!isYouTubeHost(url.hostname)) return null;

        if (url.pathname === '/watch') return url.searchParams.get('v');
        if (url.hostname === 'youtu.be') {
            const id = url.pathname.replace(/^\/+/, '').split('/')[0];
            return id || null;
        }
        const shortsMatch = url.pathname.match(/^\/shorts\/([^/?#]+)/);
        if (shortsMatch) return shortsMatch[1];
        const embedMatch = url.pathname.match(/^\/embed\/([^/?#]+)/);
        if (embedMatch) return embedMatch[1];
        return null;
    } catch {
        return null;
    }
}

function sanitizeKeyPart(value) {
    return String(value || '')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .slice(0, 80);
}

function makeYouTubeTranscriptKey({ videoId, lang }) {
    const vid = sanitizeKeyPart(videoId);
    const language = sanitizeKeyPart(lang || 'und');
    return `${YT_TRANSCRIPT_KEY_PREFIX}${vid}_${language}`;
}

async function loadYouTubeTranscriptText(key) {
    if (!key) return null;
    const result = await storageAdapter.get(key);
    const payload = result?.[key];
    if (!payload) return null;
    if (typeof payload === 'string') return payload;
    return payload?.text || null;
}

async function saveYouTubeTranscript({ key, videoId, lang, text }) {
    if (!key || !text) return;
    await storageAdapter.set({
        [key]: {
            v: 1,
            videoId,
            lang: lang || null,
            text,
            updatedAt: Date.now(),
        },
    });
}

// Use the same ordering and explicit selection in the picker and outgoing request.
export function getWebpageSourceTabs(tabs) {
    return tabs
        .filter((tab) => tab.url && !/^(chrome|chrome-extension|edge|about|moz-extension):/.test(tab.url))
        .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
}

async function mapWithConcurrency(items, limit, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, limit), items.length);

    await Promise.all(
        Array.from({ length: workerCount }, async () => {
            while (nextIndex < items.length) {
                const index = nextIndex++;
                results[index] = await mapper(items[index], index);
            }
        })
    );

    return results;
}

export async function getEnabledTabsContent(chatId = chatManager.currentChatId, { cachedOnly = false } = {}) {
    const browserSession=desktopBrowserStore.getSnapshot().session;
    const browserSessionIsCurrent = () =>
        !globalThis.cerebrDesktop ||
        (!!browserSession && browserSession === desktopBrowserStore.getSnapshot().session);
    const chat = chatManager.chats?.get(chatId) || chatManager.getCurrentChat();
    const activeChatId = chat?.id || null;
    const initialize = !cachedOnly && isNewWebpageConversation(chat);
    const cachedPages = await getCachedWebpagesForChat(activeChatId);
    // Browsing can refresh a document already used by this conversation, but
    // merely showing a source chip must not turn an unused page into history.
    if (cachedOnly && !cachedPages.length) return null;
    const cachedContext = (current = null) => ({
        pages: cachedPages.map((page) => ({
            ...page,
            isCurrent: !!current && webpageCacheIdentity(current) === webpageCacheIdentity(page),
        })),
    });
    let allTabs, currentTab;
    try {
        [allTabs, currentTab] = await Promise.all([browserAdapter.getAllTabs(), browserAdapter.getCurrentTab()]);
    } catch (error) {
        if (cachedPages.length) return cachedContext();
        throw error;
    }
    if (!browserSessionIsCurrent()) {
        if (cachedPages.length) return cachedContext();
        throw new Error('Browser extension disconnected during page extraction');
    }
    currentTab = allTabs.find((tab) => tab.id === currentTab?.id) || currentTab;
    let switches;
    try {
        switches = await getWebpageSwitchesForChat(activeChatId, {
            currentTab: allTabs.find((tab) => tab.id === currentTab?.id) || currentTab,
            tabs: allTabs,
            initialize,
        });
    } catch (error) {
        if (cachedPages.length) return cachedContext(currentTab);
        throw error;
    }
    const cachedByUrl = new Map(cachedPages.map((page) => [webpageCacheIdentity(page), page]));
    let combinedContent = null;

    const finalTabs = getWebpageSourceTabs(allTabs, switches);

    const currentTabId = currentTab?.id;
    const selectedTabs = finalTabs.filter(
        (tab) => (!cachedOnly && switches[tab.id] === true) || cachedByUrl.has(webpageCacheIdentity(tab))
    );
    const cacheRevisions = new Map(await Promise.all(
        selectedTabs.map(async (tab) => [
            webpageCacheIdentity(tab),
            await getWebpageCacheRevision(activeChatId, tab),
        ])
    ));
    const enabledTabs = selectedTabs.filter((tab) => !cacheRevisions.get(webpageCacheIdentity(tab)).deleted);
    const pageEntries = await mapWithConcurrency(enabledTabs, 4, async (tab) => {
        try {
            if (!browserSessionIsCurrent()) throw new Error('Browser extension disconnected during page extraction');
            const observedAt = Date.now();
            // The background recovers a missing content script and waits for its
            // queued PING. Reloading here used to interrupt SPAs and discard the
            // recovery path after an arbitrary one-second delay.
            const pageData = await browserAdapter.sendMessage({
                type: 'GET_PAGE_CONTENT_FROM_SIDEBAR',
                tabId: tab.id,
                skipWaitContent: true, // 明确要求立即提取
            });

            if (!pageData || (!pageData.content?.trim() && !pageData.youtubeTranscript?.transcript?.trim())) {
                return null;
            }
            if (pageData.url && webpageCacheIdentity(pageData.url) !== webpageCacheIdentity(tab.url)) {
                // Navigation may finish between listing the tab and extracting it.
                // Never overwrite the previous document with a different page's text.
                return null;
            }

            let content = pageData.content || '';

            // YouTube 字幕：优先使用本次提取结果；失败时回退到“当前对话已缓存的字幕”
            const videoId = tab?.url ? getYouTubeVideoIdFromUrl(tab.url) : null;
            const isYouTubeTab = (() => {
                if (!tab?.url) return false;
                try {
                    return isYouTubeHost(new URL(tab.url).hostname);
                } catch {
                    return false;
                }
            })();

            if (videoId && isYouTubeTab) {
                const youtubeTranscript = pageData.youtubeTranscript;
                let transcriptText = youtubeTranscript?.transcript || null;
                const lang = youtubeTranscript?.lang || null;
                const key = transcriptText
                    ? makeYouTubeTranscriptKey({ videoId, lang })
                    : chatManager.getYouTubeTranscriptRef(activeChatId, videoId)?.key || null;

                if (transcriptText && key) {
                    await saveYouTubeTranscript({ key, videoId, lang, text: transcriptText });
                    if (activeChatId) {
                        chatManager.addYouTubeTranscriptRef(activeChatId, { key, videoId, lang });
                    }
                }

                if (!transcriptText && key) {
                    transcriptText = await loadYouTubeTranscriptText(key);
                }

                if (transcriptText) {
                    content = `${content}\n\n${t('youtube_transcript_prefix')}\n${transcriptText}`.trim();
                }
            }

            return {
                title: pageData.title,
                url: tab.url,
                ...(tab.sourceId ? { sourceId: tab.sourceId } : {}),
                content,
                isCurrent: tab.id === currentTabId,
                tabId: tab.id,
                observedAt,
            };
        } catch (e) {
            console.warn(`Could not get content from tab ${tab.id} (${tab.url}): ${e}`);
            return null;
        }
    });

    const refreshedPages = pageEntries.filter(Boolean);
    let pagesToCache = [];
    if (!browserSessionIsCurrent()) {
        if (cachedPages.length) return cachedContext(currentTab);
        throw new Error('Browser extension disconnected during page extraction');
    }
    if (refreshedPages.length) {
        const [latestSwitches, latestCachedPages] = await Promise.all([
            getWebpageSwitchesForChat(activeChatId).catch(() => switches),
            getCachedWebpagesForChat(activeChatId),
        ]);
        const latestCachedUrls = new Set(latestCachedPages.map((page) => webpageCacheIdentity(page)));
        const stillSelected = new Set(
            enabledTabs
                .filter((tab) => latestSwitches[tab.id] === true || latestCachedUrls.has(webpageCacheIdentity(tab)))
                .map((tab) => webpageCacheIdentity(tab))
        );
        pagesToCache = refreshedPages.filter((page) => stillSelected.has(webpageCacheIdentity(page)));
        const revisionsToSave = new Map(
            pagesToCache.map((page) => [webpageCacheIdentity(page), cacheRevisions.get(webpageCacheIdentity(page))])
        );
        if (pagesToCache.length) {
            await saveCachedWebpagesForChat(activeChatId, pagesToCache, revisionsToSave).catch((error) => {
                console.warn(`Could not persist webpage context for chat ${activeChatId}: ${error}`);
            });
        }
    }
    const failedTabs = enabledTabs.filter(
        (tab, index) => !pageEntries[index] && !cachedByUrl.has(webpageCacheIdentity(tab))
    );
    if (!browserSessionIsCurrent()) {
        if (cachedPages.length) return cachedContext(currentTab);
        throw new Error('Browser extension disconnected during page extraction');
    }
    if (failedTabs.length) {
        throw createChatError(
            'WEBPAGE_CONTEXT_INCOMPLETE',
            t('webpage_context_incomplete', [failedTabs.map((tab) => tab.title || tab.url).join('、')]),
            { failedTabs: failedTabs.map(({ id, title, url }) => ({ id, title, url })) }
        );
    }
    const pagesByUrl = new Map(
        (await getCachedWebpagesForChat(activeChatId)).map((page) => [webpageCacheIdentity(page), page])
    );
    for (const page of pagesToCache) {
        const identity = webpageCacheIdentity(page);
        const current = pagesByUrl.get(identity);
        if (
            sameWebpageCacheRevision(cacheRevisions.get(identity), await getWebpageCacheRevision(activeChatId, page)) &&
            Number(page.observedAt) >= (Number(current?.updatedAt) || 0)
        )
            pagesByUrl.set(identity, page);
    }
    const pages = [...pagesByUrl.values()].map((page) => ({
        ...page,
        isCurrent: !!currentTab?.url && webpageCacheIdentity(page) === webpageCacheIdentity(currentTab),
    }));
    if (pages.length > 0) {
        combinedContent = { pages };
    }
    return combinedContent;
}
