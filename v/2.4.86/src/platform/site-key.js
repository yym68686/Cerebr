export const SITE_KEY_PLUS = 2;

function isIPv4(hostname) {
    if (typeof hostname !== 'string') return false;
    const parts = hostname.split('.');
    if (parts.length !== 4) return false;
    return parts.every((part) => {
        if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return false;
        const value = Number(part);
        return value >= 0 && value <= 255;
    });
}

function isIPv6(hostname) {
    if (typeof hostname !== 'string') return false;
    return hostname.includes(':');
}

const MULTI_PART_PUBLIC_SUFFIXES = new Set([
    'co.uk',
    'org.uk',
    'ac.uk',
    'gov.uk',
    'net.uk',
    'com.au',
    'net.au',
    'org.au',
    'edu.au',
    'gov.au',
    'co.jp',
    'ne.jp',
    'or.jp',
    'ac.jp',
    'go.jp',
    'com.cn',
    'net.cn',
    'org.cn',
    'gov.cn',
    'com.hk',
    'com.tw',
    'com.sg'
]);

export function getSiteKeyFromHostname(hostname, plus = SITE_KEY_PLUS) {
    if (!hostname || typeof hostname !== 'string') return null;
    const normalized = hostname.trim().replace(/\.$/, '').toLowerCase();
    if (!normalized) return null;
    if (normalized === 'localhost' || normalized.endsWith('.localhost')) return normalized;
    if (isIPv4(normalized) || isIPv6(normalized)) return normalized;

    const parts = normalized.split('.').filter(Boolean);
    if (parts.length <= 2) return normalized;

    let suffixLen = 1;
    const last2 = parts.slice(-2).join('.');
    const last3 = parts.slice(-3).join('.');
    if (MULTI_PART_PUBLIC_SUFFIXES.has(last2)) suffixLen = 2;
    else if (MULTI_PART_PUBLIC_SUFFIXES.has(last3)) suffixLen = 3;

    const plusNumber = Math.max(1, Number(plus) || SITE_KEY_PLUS);
    const requiredLen = suffixLen + plusNumber;
    if (parts.length <= requiredLen) return normalized;
    return parts.slice(-requiredLen).join('.');
}

export function getSiteKeyFromLocation(locationLike) {
    try {
        if (!locationLike || typeof locationLike !== 'object') return null;
        if (locationLike.protocol === 'file:') return 'file';
        return getSiteKeyFromHostname(locationLike.hostname, SITE_KEY_PLUS);
    } catch {
        return null;
    }
}

export function canonicalizePositionKey(key) {
    const normalized = String(key || '').trim().toLowerCase();
    if (!normalized) return null;
    if (normalized === 'twitter.com') return 'x.com';
    return normalized;
}

export function pruneSiteOverridesInPlace(overrides, maxEntries = 100) {
    try {
        const entries = Object.entries(overrides || {});
        if (entries.length <= maxEntries) return;

        entries
            .sort((a, b) => (Number(b[1]?.updatedAt) || 0) - (Number(a[1]?.updatedAt) || 0))
            .slice(maxEntries)
            .forEach(([key]) => {
                delete overrides[key];
            });
    } catch {
        // ignore
    }
}
