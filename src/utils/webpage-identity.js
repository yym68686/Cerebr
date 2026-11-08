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
    const key = webpagePreferenceKey(value);
    return key ? key.slice(WEBPAGE_PREFERENCE_PREFIX.length) : null;
}
