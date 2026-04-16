import { validatePluginManifest, validatePluginRegistry } from './plugin-schema.js';

export const DEFAULT_PLUGIN_REGISTRY_SOURCES = Object.freeze([
    Object.freeze({
        id: 'official',
        displayName: 'Cerebr Official Registry',
        url: 'statics/plugin-registry.json',
    }),
]);

function getResourceUrl(path) {
    try {
        if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
            return chrome.runtime.getURL(path);
        }
    } catch {
        // ignore
    }

    return new URL(path, window.location.href).toString();
}

async function fetchJson(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
}

export async function fetchPluginRegistrySource(source) {
    const resolvedUrl = /^https?:\/\//i.test(source?.url || '')
        ? source.url
        : getResourceUrl(source?.url || '');

    const payload = await fetchJson(resolvedUrl);
    return validatePluginRegistry(payload, resolvedUrl);
}

export async function fetchPluginManifestFromUrl(url) {
    const resolvedUrl = /^https?:\/\//i.test(url || '')
        ? url
        : getResourceUrl(url || '');
    const payload = await fetchJson(resolvedUrl);
    return validatePluginManifest(payload);
}
