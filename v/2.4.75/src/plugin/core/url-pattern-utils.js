import { normalizeString, normalizeStringArray } from './runtime-utils.js';

const urlPatternRegexCache = new Map();

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getWildcardRegex(pattern) {
    const normalizedPattern = normalizeString(pattern);
    if (!normalizedPattern || normalizedPattern === '*' || normalizedPattern === '<all_urls>') {
        return /^.*$/;
    }

    const cached = urlPatternRegexCache.get(normalizedPattern);
    if (cached) {
        return cached;
    }

    const regex = new RegExp(`^${escapeRegExp(normalizedPattern).replace(/\\\*/g, '.*')}$`);
    urlPatternRegexCache.set(normalizedPattern, regex);
    return regex;
}

export function matchesUrlPattern(url, pattern) {
    const normalizedUrl = normalizeString(url);
    const normalizedPattern = normalizeString(pattern);
    if (!normalizedUrl) return false;
    if (!normalizedPattern) return true;

    try {
        return getWildcardRegex(normalizedPattern).test(normalizedUrl);
    } catch {
        return false;
    }
}

export function matchesAnyUrlPattern(url, patterns = []) {
    const normalizedPatterns = normalizeStringArray(patterns);
    if (normalizedPatterns.length === 0) {
        return true;
    }

    return normalizedPatterns.some((pattern) => matchesUrlPattern(url, pattern));
}
