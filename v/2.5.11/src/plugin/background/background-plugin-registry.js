const BUILTIN_BACKGROUND_PLUGIN_ENTRIES = Object.freeze([]);

export function getBuiltinBackgroundPluginEntries() {
    return BUILTIN_BACKGROUND_PLUGIN_ENTRIES.map((entry) => ({
        plugin: entry.plugin,
        manifest: entry.manifest ? { ...entry.manifest } : null,
    }));
}
