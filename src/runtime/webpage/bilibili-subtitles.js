const API_ROOT = 'https://api.bilibili.com';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHED_VIDEOS = 8;

export function getBilibiliVideoRef(value) {
    try {
        const url = new URL(value);
        if (!/^https?:$/.test(url.protocol) ||
            !(url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com'))) return null;
        const match = url.pathname.match(/^\/video\/(BV[\da-zA-Z]{10})\/?$/);
        if (!match) return null;
        const page = url.searchParams.has('p') ? Number(url.searchParams.get('p')) : 1;
        if (!Number.isSafeInteger(page) || page < 1) return null;
        return { bvid: match[1], page };
    } catch {
        return null;
    }
}

function refKey(ref) {
    return ref ? `${ref.bvid}:p${ref.page}` : null;
}

// Keep the document identity with the text, so a delayed reply or imported
// snapshot cannot supply another video's / another part's subtitles.
export function matchesBilibiliSubtitle(subtitle, url) {
    const ref = getBilibiliVideoRef(url);
    return !!ref && subtitle?.bvid === ref.bvid && subtitle.page === ref.page &&
        Number.isSafeInteger(subtitle.cid) && subtitle.cid > 0 &&
        typeof subtitle.text === 'string' && !!subtitle.text.trim();
}

function subtitleUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
        const url = new URL(value.startsWith('//') ? `https:${value}` : value);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
        url.protocol = 'https:';
        return url.href;
    } catch {
        return null;
    }
}

export function rankBilibiliSubtitles(subtitles, preferredLang = '') {
    const wanted = preferredLang.toLowerCase();
    const priority = (track) => {
        const lang = String(track.lan || '').toLowerCase();
        if (wanted && lang === wanted) return 0;
        if (['zh-cn', 'zh-hans', 'zh'].includes(lang)) return 1;
        if (lang.startsWith('zh')) return 2;
        if (lang.startsWith('ai-zh')) return 3;
        return 4;
    };
    return (Array.isArray(subtitles) ? subtitles : [])
        .filter((track) => subtitleUrl(track?.subtitle_url))
        .map((track) => ({ ...track, subtitle_url: subtitleUrl(track.subtitle_url) }))
        .sort((a, b) => priority(a) - priority(b));
}

function subtitleBodyText(body) {
    // Repeated spoken sentences are meaningful: do not discard equal lines or
    // impose a local character limit on what the model can read.
    return (Array.isArray(body) ? body : [])
        .map((item) => typeof item?.content === 'string' ? item.content.trim() : '')
        .filter(Boolean).join('\n');
}

export function createBilibiliSubtitleExtractor({
    getUrl,
    fetchImpl = (...args) => globalThis.fetch(...args),
    timeoutMs = 6000,
    now = () => Date.now(),
    preferredLang = '',
} = {}) {
    const cache = new Map();
    let pending = null;

    const cancel = () => {
        pending?.controller.abort();
        pending = null;
    };

    const extract = () => {
        const ref = getBilibiliVideoRef(getUrl());
        const key = refKey(ref);
        if (pending && pending.key !== key) cancel();
        if (!ref) return Promise.resolve(null);
        const cached = cache.get(key);
        if (cached && now() - cached.createdAt < CACHE_TTL_MS) return Promise.resolve(cached.data);
        if (pending?.key === key) return pending.promise;

        const controller = new AbortController();
        const { signal } = controller;
        const checkActive = () => {
            if (refKey(getBilibiliVideoRef(getUrl())) !== key) controller.abort();
            signal.throwIfAborted();
        };
        const json = async (url, credentials) => {
            checkActive();
            const response = await fetchImpl(url, { credentials, signal });
            if (!response.ok) throw new Error(`Bilibili subtitle HTTP ${response.status}`);
            const data = await response.json();
            checkActive();
            return data;
        };
        const api = async (path) => {
            const result = await json(`${API_ROOT}${path}`, 'include');
            if (result?.code !== 0) throw new Error('Bilibili subtitle API unavailable');
            return result.data;
        };
        const read = async () => {
            const view = await api(`/x/web-interface/view?bvid=${encodeURIComponent(ref.bvid)}`);
            const page = Array.isArray(view?.pages) ? view.pages.find((item) => item?.page === ref.page) : null;
            // view.cid is only a safe fallback for P1, never for a missing P2+.
            const cid = page?.cid ?? (ref.page === 1 ? view?.cid : null);
            if (!Number.isSafeInteger(cid) || cid < 1) return null;
            for (let attempt = 0; attempt < 2; attempt++) {
                const player = await api(`/x/player/wbi/v2?bvid=${encodeURIComponent(ref.bvid)}&cid=${cid}`);
                const tracks = rankBilibiliSubtitles(player?.subtitle?.subtitles, preferredLang);
                if (!tracks.length) return null;
                for (const track of tracks) {
                    try {
                        // CDN wildcard CORS responses cannot be read with credentials.
                        const payload = await json(track.subtitle_url, 'omit');
                        const text = subtitleBodyText(payload?.body);
                        if (text) return {
                            ...ref, cid, lang: track.lan || null,
                            langLabel: track.lan_doc || null, text,
                        };
                    } catch {
                        checkActive();
                    }
                }
                // Expiring CDN URLs may fail even with a valid track. Refresh
                // the list once, within the same overall request deadline.
            }
            return null;
        };
        const timedOut = new Promise((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }));
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        // Bilibili navigates without reloading the content script. Watch only
        // while fetching, and promptly cancel work for the previous document.
        const navigation = setInterval(() => {
            if (refKey(getBilibiliVideoRef(getUrl())) !== key) controller.abort();
        }, 100);
        const request = { key, controller, promise: null };
        request.promise = Promise.race([read().catch(() => null), timedOut]).then((data) => {
            if (signal.aborted || refKey(getBilibiliVideoRef(getUrl())) !== key) return null;
            if (data) {
                cache.delete(key);
                cache.set(key, { data, createdAt: now() });
                while (cache.size > MAX_CACHED_VIDEOS) cache.delete(cache.keys().next().value);
            }
            return data;
        }).finally(() => {
            clearTimeout(timer);
            clearInterval(navigation);
            if (pending === request) pending = null;
        });
        pending = request;
        return request.promise;
    };
    return { extract, cancel };
}
