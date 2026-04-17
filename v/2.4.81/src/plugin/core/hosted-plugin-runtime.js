import { createDeclarativePluginEntry } from '../shared/declarative-plugin-entry.js';
import { getInstalledDeclarativePluginDescriptors } from '../shared/declarative-plugin-service.js';
import { createScriptPluginCacheKey, loadScriptPluginModule } from '../dev/script-plugin-loader.js';
import { readDeveloperModePreference, subscribeDeveloperModePreference } from '../dev/developer-mode.js';
import { getInstalledScriptPlugins } from '../dev/local-plugin-service.js';
import { createPluginManager } from '../shared/plugin-manager.js';
import {
    isPluginEnabled,
    isPluginInstalled,
    readPluginSettings,
    subscribePluginSettings,
} from '../shared/plugin-store.js';
import { normalizeString, normalizeStringArray } from './runtime-utils.js';

function normalizePluginEntry(input) {
    if (input?.plugin && typeof input.plugin === 'object') {
        return {
            plugin: input.plugin,
            manifest: input.manifest && typeof input.manifest === 'object'
                ? { ...input.manifest }
                : null,
        };
    }

    return {
        plugin: input,
        manifest: null,
    };
}

export function createHostedPluginRuntime({
    host,
    builtinEntries = [],
    declarativeScopes = [],
    createApi,
    logger = console,
    onPluginStopped = null,
} = {}) {
    const normalizedHost = normalizeString(host);
    const builtinEntryMap = new Map(
        (Array.isArray(builtinEntries) ? builtinEntries : [])
            .map((entry) => normalizePluginEntry(entry))
            .filter((entry) => entry?.plugin?.id)
            .map((entry) => [entry.plugin.id, entry])
    );
    const scriptPluginCache = new Map();
    const dynamicEntrySignatures = new Map();
    let unsubscribePluginSettings = null;
    let unsubscribeDeveloperMode = null;
    let pluginSyncPromise = Promise.resolve();
    let developerModeEnabled = false;
    let started = false;

    const pluginManager = createPluginManager({
        plugins: [],
        createApi,
        logger,
        onPluginStopped,
    });
    const getRegisteredPluginIds = () => new Set(
        pluginManager.getPlugins().map((plugin) => plugin?.id).filter(Boolean)
    );

    const resolveScriptPlugin = async (descriptor) => {
        const signature = createScriptPluginCacheKey(descriptor);
        const cached = scriptPluginCache.get(descriptor.id);
        if (cached?.signature === signature && cached.plugin) {
            return {
                plugin: cached.plugin,
                signature,
                changed: false,
            };
        }

        const plugin = await loadScriptPluginModule(descriptor);
        scriptPluginCache.set(descriptor.id, {
            signature,
            plugin,
        });

        return {
            plugin,
            signature,
            changed: true,
        };
    };

    const unregisterDynamicPlugin = async (pluginId, registeredPluginIds, activePluginIds) => {
        if (registeredPluginIds.has(pluginId)) {
            await pluginManager.unregister(pluginId);
            registeredPluginIds.delete(pluginId);
            activePluginIds.delete(pluginId);
        }

        scriptPluginCache.delete(pluginId);
        dynamicEntrySignatures.delete(pluginId);
    };

    const applyBuiltinPluginSettings = async (settings, registeredPluginIds, activePluginIds) => {
        for (const [pluginId, entry] of builtinEntryMap.entries()) {
            const shouldInstall = isPluginInstalled(settings, pluginId, entry.manifest?.defaultInstalled !== false);
            const shouldEnable = shouldInstall &&
                isPluginEnabled(settings, pluginId, entry.manifest?.defaultEnabled !== false);

            if (!shouldEnable) {
                if (registeredPluginIds.has(pluginId)) {
                    await pluginManager.unregister(pluginId);
                    registeredPluginIds.delete(pluginId);
                    activePluginIds.delete(pluginId);
                }
                continue;
            }

            if (!activePluginIds.has(pluginId)) {
                await pluginManager.register(entry);
                registeredPluginIds.add(pluginId);
                activePluginIds.add(pluginId);
            }
        }
    };

    const applyDeclarativePluginSettings = async (settings, registeredPluginIds, activePluginIds) => {
        const desiredPluginIds = new Set();
        const scopes = normalizeStringArray(declarativeScopes);

        if (scopes.length === 0) {
            return desiredPluginIds;
        }

        const installedDeclaratives = await getInstalledDeclarativePluginDescriptors({
            scopes,
        });

        for (const descriptor of installedDeclaratives) {
            desiredPluginIds.add(descriptor.id);
            const shouldEnable = descriptor.compatible &&
                descriptor.runtimeSupported &&
                isPluginEnabled(settings, descriptor.id, descriptor.manifest?.defaultEnabled !== false);

            if (!shouldEnable) {
                await unregisterDynamicPlugin(descriptor.id, registeredPluginIds, activePluginIds);
                continue;
            }

            try {
                const entry = createDeclarativePluginEntry(descriptor, {
                    host: normalizedHost,
                });
                if (!entry) {
                    await unregisterDynamicPlugin(descriptor.id, registeredPluginIds, activePluginIds);
                    continue;
                }

                if (dynamicEntrySignatures.get(descriptor.id) !== descriptor.signature || !registeredPluginIds.has(descriptor.id)) {
                    await pluginManager.register(entry);
                    dynamicEntrySignatures.set(descriptor.id, descriptor.signature);
                    registeredPluginIds.add(descriptor.id);
                    activePluginIds.add(descriptor.id);
                }
            } catch (error) {
                logger?.error?.(`[Cerebr] Failed to load ${normalizedHost} declarative plugin "${descriptor.id}"`, error);
                await unregisterDynamicPlugin(descriptor.id, registeredPluginIds, activePluginIds);
            }
        }

        return desiredPluginIds;
    };

    const applyScriptPluginSettings = async (settings, registeredPluginIds, activePluginIds) => {
        const desiredPluginIds = new Set();
        const installedScriptPlugins = await getInstalledScriptPlugins({ scope: normalizedHost });
        const activeScriptPlugins = installedScriptPlugins.filter((descriptor) => {
            return developerModeEnabled || descriptor.sourceType !== 'developer';
        });

        for (const descriptor of activeScriptPlugins) {
            desiredPluginIds.add(descriptor.id);
            const shouldEnable = descriptor.compatible &&
                descriptor.runtimeSupported &&
                isPluginEnabled(settings, descriptor.id, descriptor.manifest?.defaultEnabled !== false);

            if (!shouldEnable) {
                await unregisterDynamicPlugin(descriptor.id, registeredPluginIds, activePluginIds);
                continue;
            }

            try {
                const { plugin, signature } = await resolveScriptPlugin(descriptor);
                const entry = {
                    plugin,
                    manifest: descriptor.manifest || null,
                };

                if (dynamicEntrySignatures.get(descriptor.id) !== signature || !registeredPluginIds.has(descriptor.id)) {
                    await pluginManager.register(entry);
                    dynamicEntrySignatures.set(descriptor.id, signature);
                    registeredPluginIds.add(descriptor.id);
                    activePluginIds.add(descriptor.id);
                }
            } catch (error) {
                logger?.error?.(`[Cerebr] Failed to load ${normalizedHost} script plugin "${descriptor.id}"`, error);
                await unregisterDynamicPlugin(descriptor.id, registeredPluginIds, activePluginIds);
            }
        }

        return desiredPluginIds;
    };

    const applyPluginSettings = async (settings) => {
        const activePluginIds = new Set(pluginManager.getActivePluginIds());
        const registeredPluginIds = getRegisteredPluginIds();

        await applyBuiltinPluginSettings(settings, registeredPluginIds, activePluginIds);

        const desiredDeclarativePluginIds = await applyDeclarativePluginSettings(
            settings,
            registeredPluginIds,
            activePluginIds
        );
        const desiredScriptPluginIds = await applyScriptPluginSettings(
            settings,
            registeredPluginIds,
            activePluginIds
        );
        const desiredDynamicPluginIds = new Set([
            ...desiredDeclarativePluginIds,
            ...desiredScriptPluginIds,
        ]);

        for (const pluginId of [...dynamicEntrySignatures.keys()]) {
            if (desiredDynamicPluginIds.has(pluginId)) continue;
            await unregisterDynamicPlugin(pluginId, registeredPluginIds, activePluginIds);
        }

        for (const pluginId of [...scriptPluginCache.keys()]) {
            if (desiredScriptPluginIds.has(pluginId)) continue;
            scriptPluginCache.delete(pluginId);
        }
    };

    const syncPlugins = ({ settings = null, developerMode = null } = {}) => {
        pluginSyncPromise = pluginSyncPromise
            .then(async () => {
                if (!started) return;

                developerModeEnabled = typeof developerMode === 'boolean'
                    ? developerMode
                    : await readDeveloperModePreference();
                const effectiveSettings = settings || await readPluginSettings();
                await applyPluginSettings(effectiveSettings);
            })
            .catch((error) => {
                logger?.error?.(`[Cerebr] Failed to sync ${normalizedHost} plugins`, error);
            });

        return pluginSyncPromise;
    };

    const start = async () => {
        if (started) return;
        started = true;

        await pluginManager.start();
        developerModeEnabled = await readDeveloperModePreference();
        await syncPlugins({
            settings: await readPluginSettings(),
            developerMode: developerModeEnabled,
        });
        unsubscribePluginSettings = subscribePluginSettings((settings) => {
            void syncPlugins({ settings });
        });
        unsubscribeDeveloperMode = subscribeDeveloperModePreference((enabled) => {
            void syncPlugins({ developerMode: enabled });
        });
    };

    const stop = async () => {
        if (!started) return;
        started = false;

        unsubscribePluginSettings?.();
        unsubscribePluginSettings = null;
        unsubscribeDeveloperMode?.();
        unsubscribeDeveloperMode = null;
        scriptPluginCache.clear();
        dynamicEntrySignatures.clear();
        await pluginManager.stop();
    };

    return {
        host: normalizedHost,
        pluginManager,
        syncPlugins,
        start,
        stop,
        isStarted() {
            return started;
        },
    };
}
