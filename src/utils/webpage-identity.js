const WEBPAGE_PREFERENCE_PREFIX = 'cerebr_webpage_auto_include_v1_';

// Keep query parameters and hash-router paths, but share ordinary page anchors.
export function webpagePreferenceKey(value) {
    try {
        const url = new URL(value);
        if (!['https:', 'http:', 'file:'].includes(url.protocol)) return null;
        if (!/^#!?\//.test(url.hash)) url.hash = '';
        return WEBPAGE_PREFERENCE_PREFIX + encodeURIComponent(url.href);
    } catch {
        return null;
    }
}

export function webpageCacheIdentity(value) {
    const page = typeof value === 'object' && value !== null ? value : null;
    const key = webpagePreferenceKey(page ? page.url : value);
    if (!key) return null;
    const identity = key.slice(WEBPAGE_PREFERENCE_PREFIX.length);
    return page?.sourceId ? JSON.stringify([identity, page.sourceId]) : identity;
}
