import { isExtensionEnvironment } from '../../utils/storage-adapter.js';

function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function getExtensionOrigin() {
    try {
        return new URL(chrome.runtime.getURL('/')).origin;
    } catch {
        return '';
    }
}

function resolveAbsoluteUrl(rawUrl) {
    if (isExtensionEnvironment) {
        return new URL(chrome.runtime.getURL(rawUrl.replace(/^\/+/, ''))).toString();
    }

    return new URL(rawUrl, window.location.href).toString();
}

function assertAllowedOrigin(urlString) {
    const url = new URL(urlString, window.location.href);
    const expectedOrigin = isExtensionEnvironment ? getExtensionOrigin() : window.location.origin;

    if (!expectedOrigin || url.origin !== expectedOrigin) {
        throw new Error('Local sideload only supports plugin files from the current Cerebr origin');
    }

    return url.toString();
}

export function normalizeLocalPluginSourceLabel(value) {
    return normalizeString(value);
}

export function resolveLocalPluginSourceUrl(source) {
    const normalizedSource = normalizeString(source);
    if (!normalizedSource) {
        throw new Error('A local plugin manifest path is required');
    }

    const isAbsolute = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(normalizedSource);
    const resolvedUrl = isAbsolute
        ? new URL(normalizedSource, window.location.href).toString()
        : resolveAbsoluteUrl(normalizedSource);

    return assertAllowedOrigin(resolvedUrl);
}

export function resolveLocalPluginEntryUrl(entry, manifestUrl) {
    const normalizedEntry = normalizeString(entry);
    if (!normalizedEntry) {
        throw new Error('Script plugins require a script.entry path');
    }

    const resolvedUrl = new URL(normalizedEntry, manifestUrl || window.location.href).toString();
    return assertAllowedOrigin(resolvedUrl);
}
