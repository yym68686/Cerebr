import { storageAdapter } from '../../utils/storage-adapter.js';

const PLUGIN_PACKAGE_KEY_PREFIX = 'cerebr_plugin_package_v1_';

function getPluginPackageKey(pluginId) {
    return `${PLUGIN_PACKAGE_KEY_PREFIX}${pluginId}`;
}

export async function readInstalledPluginPackage(pluginId) {
    if (!pluginId) return null;
    const storageKey = getPluginPackageKey(pluginId);
    const result = await storageAdapter.get(storageKey);
    return result?.[storageKey] || null;
}

export async function writeInstalledPluginPackage(pluginId, manifest) {
    if (!pluginId || !manifest) return;
    const storageKey = getPluginPackageKey(pluginId);
    await storageAdapter.set({ [storageKey]: manifest });
}

export async function removeInstalledPluginPackage(pluginId) {
    if (!pluginId) return;
    await storageAdapter.remove(getPluginPackageKey(pluginId));
}
