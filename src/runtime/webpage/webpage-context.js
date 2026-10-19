import { storageAdapter, browserAdapter } from '../../utils/storage-adapter.js';
import { chatManager } from '../../domain/chat/chat-store.js';
import { t } from '../../utils/i18n.js';
import { getWebpageSwitchesForChat, isNewWebpageConversation } from '../../utils/webpage-switches.js';
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

export function getUniqueTabsByUrl(tabs) {
    const seenUrls = new Set();
    return tabs.filter((tab) => {
        if (!tab.url || seenUrls.has(tab.url)) {
            return false;
        }
        seenUrls.add(tab.url);
        return true;
    });
}

// Use the same ordering and explicit selection in the picker and outgoing request.
// Prefer a selected duplicate so another copy of its URL cannot hide that selection.
export function getWebpageSourceTabs(tabs, switches = {}) {
    return getUniqueTabsByUrl(
        tabs
            .filter((tab) => tab.url && !/^(chrome|chrome-extension|edge|about|moz-extension):/.test(tab.url))
            .sort(
                (a, b) =>
                    Number(!!switches[b.id]) - Number(!!switches[a.id]) ||
                    (b.lastAccessed || 0) - (a.lastAccessed || 0)
            )
    ).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
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

export async function getEnabledTabsContent() {
    const browserSession=desktopBrowserStore.getSnapshot().session;
    const requireSameBrowser=()=>{if(globalThis.cerebrDesktop&&(!browserSession||browserSession!==desktopBrowserStore.getSnapshot().session))throw new Error('Browser extension disconnected during page extraction');};
    const chat = chatManager.getCurrentChat();
    const activeChatId = chat?.id || null;
    const initialize = isNewWebpageConversation(chat);
    const [allTabs, currentTab] = await Promise.all([
        browserAdapter.getAllTabs(),
        browserAdapter.getCurrentTab(),
    ]);
    requireSameBrowser();
    const switches = await getWebpageSwitchesForChat(activeChatId, {
        currentTab: allTabs.find((tab) => tab.id === currentTab?.id) || currentTab,
        initialize,
    });
    let combinedContent = null;

    const finalTabs = getWebpageSourceTabs(allTabs, switches);

    const currentTabId = currentTab?.id;
    const enabledTabs = finalTabs.filter((tab) => switches[tab.id] === true);
    const pageEntries = await mapWithConcurrency(enabledTabs, 4, async (tab) => {
        try {
            requireSameBrowser();
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
                content,
                isCurrent: tab.id === currentTabId,
            };
        } catch (e) {
            console.warn(`Could not get content from tab ${tab.id} (${tab.url}): ${e}`);
            return null;
        }
    });

    const failedTabs = enabledTabs.filter((tab, index) => !pageEntries[index]);
    requireSameBrowser();
    if (failedTabs.length) {
        throw createChatError(
            'WEBPAGE_CONTEXT_INCOMPLETE',
            t('webpage_context_incomplete', [failedTabs.map((tab) => tab.title || tab.url).join('、')]),
            { failedTabs: failedTabs.map(({ id, title, url }) => ({ id, title, url })) }
        );
    }
    const pages = pageEntries.filter(Boolean);
    if (pages.length > 0) {
        combinedContent = { pages };
    }
    return combinedContent;
}
