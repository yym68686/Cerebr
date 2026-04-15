import { selectionActionPlugin } from '../builtins/page/selection-action-plugin.js';
import { getBuiltinPluginManifestById } from '../shared/plugin-catalog.js';

const BUILTIN_PAGE_PLUGIN_ENTRIES = Object.freeze([
    Object.freeze({
        plugin: selectionActionPlugin,
        manifest: getBuiltinPluginManifestById(selectionActionPlugin.id),
    }),
]);

export function getBuiltinPagePluginEntries() {
    return BUILTIN_PAGE_PLUGIN_ENTRIES.map((entry) => ({
        plugin: entry.plugin,
        manifest: entry.manifest ? { ...entry.manifest } : null,
    }));
}

export function getBuiltinPagePlugins() {
    return [
        selectionActionPlugin,
    ];
}
