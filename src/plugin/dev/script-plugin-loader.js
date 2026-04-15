function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

export function createScriptPluginCacheKey(descriptor = {}) {
    const manifest = descriptor?.manifest || {};
    const record = descriptor?.record || {};

    return [
        normalizeString(manifest.id),
        normalizeString(manifest.version),
        normalizeString(manifest.script?.entry),
        normalizeString(manifest.script?.exportName, 'default'),
        String(record.updatedAt || record.installedAt || 0),
    ].join('|');
}

export async function loadScriptPluginModule(descriptor = {}) {
    const manifest = descriptor?.manifest || {};
    const pluginId = normalizeString(manifest.id);
    const entryUrl = normalizeString(manifest.script?.entry);
    const exportName = normalizeString(manifest.script?.exportName, 'default');
    const cacheKey = createScriptPluginCacheKey(descriptor);

    if (!pluginId) {
        throw new Error('Cannot load a script plugin without manifest.id');
    }
    if (!entryUrl) {
        throw new Error(`Script plugin "${pluginId}" is missing script.entry`);
    }

    const importUrl = new URL(entryUrl, window.location.href);
    importUrl.searchParams.set('cerebr_plugin_rev', cacheKey);

    const moduleNamespace = await import(importUrl.toString());
    let plugin = null;

    if (exportName === 'default') {
        plugin = moduleNamespace.default || null;
    } else {
        plugin = moduleNamespace?.[exportName] || null;
    }

    if (!plugin && moduleNamespace?.plugin) {
        plugin = moduleNamespace.plugin;
    }

    if (!plugin || typeof plugin.id !== 'string' || typeof plugin.setup !== 'function') {
        throw new Error(`Script plugin "${pluginId}" did not export a valid plugin object`);
    }
    if (plugin.id !== pluginId) {
        throw new Error(`Script plugin id mismatch: expected "${pluginId}", received "${plugin.id}"`);
    }

    return plugin;
}
