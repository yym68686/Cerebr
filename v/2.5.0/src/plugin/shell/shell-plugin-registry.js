import { geminiRetryPlugin } from '../builtins/shell/gemini-retry-plugin.js';
import { getBuiltinPluginManifestById } from '../shared/plugin-catalog.js';

const BUILTIN_SHELL_PLUGIN_ENTRIES = Object.freeze([
    Object.freeze({
        plugin: geminiRetryPlugin,
        manifest: getBuiltinPluginManifestById(geminiRetryPlugin.id),
    }),
]);

export function getBuiltinShellPluginEntries() {
    return BUILTIN_SHELL_PLUGIN_ENTRIES.map((entry) => ({
        plugin: entry.plugin,
        manifest: entry.manifest ? { ...entry.manifest } : null,
    }));
}
