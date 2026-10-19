import { validatePluginManifest, validatePluginRegistry } from './plugin-schema.js';
import { appAssetUrl } from '../../platform/assets.js';
export { DEFAULT_PLUGIN_REGISTRY_SOURCES } from './plugin-registry-sources.js';

function isAbsoluteUrl(url) {
    return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(url || '');
}

async function fetchJson(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
}

export async function fetchPluginRegistrySource(source) {
    const resolvedUrl = isAbsoluteUrl(source?.url || '') ? source.url : appAssetUrl(source?.url || '');

    const payload = await fetchJson(resolvedUrl);
    return validatePluginRegistry(payload, resolvedUrl);
}

export async function fetchPluginManifestFromUrl(url) {
    const resolvedUrl = isAbsoluteUrl(url || '') ? url : appAssetUrl(url || '');
    const payload = await fetchJson(resolvedUrl);
    return validatePluginManifest(payload, resolvedUrl);
}
