const BUILTIN_PLUGIN_MANIFESTS = Object.freeze([
    Object.freeze({
        id: 'builtin.selection-action',
        kind: 'builtin',
        scope: 'page',
        installMode: 'builtin',
        defaultInstalled: false,
        requiresExtension: true,
        defaultEnabled: true,
        latestVersion: '1.0.0',
        nameKey: 'plugin_builtin_selection_name',
        descriptionKey: 'plugin_builtin_selection_description',
        permissions: ['page:selection:read', 'page:selection:clear', 'shell:input:write', 'ui:anchored-action'],
        compatibility: {
            versionRange: '>=2.4.66 <3.0.0',
        },
        availability: {
            status: 'active',
            reason: '',
        },
    }),
    Object.freeze({
        id: 'builtin.gemini-retry',
        kind: 'builtin',
        scope: 'shell',
        installMode: 'builtin',
        defaultInstalled: false,
        requiresExtension: false,
        defaultEnabled: true,
        latestVersion: '1.0.0',
        nameKey: 'plugin_builtin_gemini_retry_name',
        descriptionKey: 'plugin_builtin_gemini_retry_description',
        permissions: ['chat:retry'],
        compatibility: {
            versionRange: '>=2.4.66 <3.0.0',
        },
        availability: {
            status: 'active',
            reason: '',
        },
    }),
]);

export function getBuiltinPluginManifests() {
    return BUILTIN_PLUGIN_MANIFESTS.map((manifest) => ({ ...manifest }));
}

export function getBuiltinPluginManifestById(pluginId) {
    const manifest = BUILTIN_PLUGIN_MANIFESTS.find((item) => item.id === pluginId);
    return manifest ? { ...manifest } : null;
}
