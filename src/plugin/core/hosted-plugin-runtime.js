import { createDeclarativePluginEntry } from '../shared/declarative-plugin-entry.js';
import { getInstalledDeclarativePluginDescriptors } from '../shared/declarative-plugin-service.js';
import { createScriptPluginCacheKey, loadScriptPluginModule } from '../dev/script-plugin-loader.js';
import { readDeveloperModePreference, subscribeDeveloperModePreference } from '../dev/developer-mode.js';
import { getInstalledScriptPlugins } from '../dev/local-plugin-service.js';
import { createPluginKernel } from '../kernel/plugin-kernel.js';
import {
    isPluginEnabled,
    isPluginInstalled,
    readPluginSettings,
    subscribePluginSettings,
} from '../shared/plugin-store.js';
import { formatPluginPreflightIssues, runPluginPreflight } from './plugin-preflight.js';
import { createPluginRuntimeContext } from './plugin-runtime-context.js';
import { normalizeString, normalizeStringArray } from './runtime-utils.js';

const SHELL_PLUGIN_API_REGISTRY_KEY = '__CEREBR_SHELL_PLUGIN_API_REGISTRY__';
const SHELL_GUEST_HOST_API_FACTORY_KEY = '__CEREBR_SHELL_GUEST_HOST_API_FACTORY__';

function normalizePluginEntry(input) {
    if (input?.plugin && typeof input.plugin === 'object') {
        return {
            plugin: input.plugin,
            manifest: input.manifest && typeof input.manifest === 'object'
                ? { ...input.manifest }
                : null,
            runtime: input.runtime && typeof input.runtime === 'object'
                ? { ...input.runtime }
                : null,
        };
    }

    return {
        plugin: input,
        manifest: null,
        runtime: null,
    };
}

export function createHostedPluginRuntime({
    host,
    builtinEntries = [],
    declarativeScopes = [],
    createApi,
    createPluginContext,
    logger = console,
    onPluginStopped = null,
} = {}) {
    const normalizedHost = normalizeString(host);
    const shellPluginApiRegistry = normalizedHost === 'shell'
        ? (() => {
            const existingRegistry = globalThis?.[SHELL_PLUGIN_API_REGISTRY_KEY];
            if (existingRegistry && typeof existingRegistry === 'object') {
                return existingRegistry;
            }

            const createdRegistry = {};
            if (typeof globalThis === 'object' && globalThis) {
                globalThis[SHELL_PLUGIN_API_REGISTRY_KEY] = createdRegistry;
            }
            return createdRegistry;
        })()
        : null;
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

    const pluginKernel = createPluginKernel({
        host: normalizedHost,
        createApi,
        createPluginContext,
        logger,
        onPluginStopped,
    });
    const getRegisteredPluginIds = () => new Set(
        pluginKernel.getPlugins().map((plugin) => plugin?.id).filter(Boolean)
    );
    const updateShellPluginApiRegistry = (pluginId, pluginApi = null) => {
        if (!shellPluginApiRegistry || !pluginId) {
            return;
        }

        if (pluginApi && typeof pluginApi === 'object') {
            shellPluginApiRegistry[pluginId] = pluginApi;
            return;
        }

        delete shellPluginApiRegistry[pluginId];
    };
    const resolveRuntimeArtifacts = (entry = {}, runtimeOverrides = {}) => {
        const runtimeEntry = {
            ...entry,
            runtime: {
                ...(entry?.runtime && typeof entry.runtime === 'object'
                    ? entry.runtime
                    : {}),
                ...(runtimeOverrides && typeof runtimeOverrides === 'object'
                    ? runtimeOverrides
                    : {}),
            },
        };
        const requestedPluginContext = typeof createPluginContext === 'function'
            ? createPluginContext(runtimeEntry)
            : null;
        let pluginApi = runtimeEntry?.runtime?.pluginApi && typeof runtimeEntry.runtime.pluginApi === 'object'
            ? runtimeEntry.runtime.pluginApi
            : (
                requestedPluginContext?.api
                && typeof requestedPluginContext.api === 'object'
                    ? requestedPluginContext.api
                    : (
                        typeof createApi === 'function'
                            ? createApi(runtimeEntry)
                            : null
                    )
            );

        if (
            normalizedHost === 'shell'
            && (!pluginApi || Object.keys(pluginApi).length === 0)
        ) {
            const createGuestHostApi = globalThis?.[SHELL_GUEST_HOST_API_FACTORY_KEY];
            if (typeof createGuestHostApi === 'function') {
                pluginApi = createGuestHostApi(runtimeEntry);
            }
        }

        const preflight = runPluginPreflight(runtimeEntry, {
            host: normalizedHost,
            api: pluginApi,
            moduleUrlStrategy: runtimeEntry?.runtime?.moduleUrlStrategy,
            requireSetup: false,
        });
        const pluginContext = createPluginRuntimeContext(runtimeEntry, {
            api: pluginApi,
            context: requestedPluginContext?.context || requestedPluginContext || pluginApi,
            host: normalizedHost,
            preflight,
            diagnostics: requestedPluginContext?.diagnostics,
        });

        return {
            pluginApi: pluginContext.api,
            pluginContext,
            preflight,
        };
    };

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
            await pluginKernel.unregister(pluginId);
            registeredPluginIds.delete(pluginId);
            activePluginIds.delete(pluginId);
        }

        updateShellPluginApiRegistry(pluginId, null);
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
                    await pluginKernel.unregister(pluginId);
                    registeredPluginIds.delete(pluginId);
                    activePluginIds.delete(pluginId);
                }
                continue;
            }

            if (!activePluginIds.has(pluginId)) {
                await pluginKernel.register(entry);
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
                    await pluginKernel.register(entry);
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
            let runtimePluginApiKeys = [];

            if (!shouldEnable) {
                await unregisterDynamicPlugin(descriptor.id, registeredPluginIds, activePluginIds);
                continue;
            }

            try {
                const runtimeEntry = {
                    plugin: {
                        id: descriptor.id,
                    },
                    manifest: descriptor.manifest || null,
                };
                const moduleUrlStrategy = descriptor?.runtime?.moduleUrlStrategy;
                const {
                    pluginApi,
                    pluginContext,
                    preflight,
                } = resolveRuntimeArtifacts(runtimeEntry, {
                    ...(descriptor.runtime && typeof descriptor.runtime === 'object'
                        ? descriptor.runtime
                        : {}),
                    moduleUrlStrategy,
                });
                if (preflight.ok === false) {
                    logger?.error?.(
                        `[Cerebr] Refused to load ${normalizedHost} script plugin "${descriptor.id}" `
                        + `because preflight failed: ${formatPluginPreflightIssues(preflight.errors)}`
                    );
                    await unregisterDynamicPlugin(descriptor.id, registeredPluginIds, activePluginIds);
                    continue;
                }
                const runtimeDescriptor = {
                    ...descriptor,
                    runtime: {
                        ...(descriptor.runtime && typeof descriptor.runtime === 'object'
                            ? descriptor.runtime
                            : {}),
                        createApi,
                        createPluginContext,
                        moduleUrlStrategy,
                        pluginApi,
                        pluginContext,
                        preflight,
                    },
                };
                runtimePluginApiKeys = Object.keys(
                    runtimeDescriptor?.runtime?.pluginApi
                    && typeof runtimeDescriptor.runtime.pluginApi === 'object'
                        ? runtimeDescriptor.runtime.pluginApi
                        : {}
                );
                if (normalizedHost === 'shell' && runtimePluginApiKeys.length === 0) {
                    logger?.warn?.(
                        `[Cerebr] Shell runtime created an empty plugin API `
                        + `(pluginId=${descriptor.id}, scope=${normalizeString(descriptor?.manifest?.scope) || 'unknown'}, `
                        + `guestFactory=${typeof globalThis?.[SHELL_GUEST_HOST_API_FACTORY_KEY] === 'function' ? 'yes' : 'no'})`
                    );
                }
                updateShellPluginApiRegistry(
                    descriptor.id,
                    runtimeDescriptor?.runtime?.pluginContext?.api || runtimeDescriptor?.runtime?.pluginApi
                );
                const { plugin, signature } = await resolveScriptPlugin(runtimeDescriptor);
                const entry = {
                    plugin,
                    manifest: descriptor.manifest || null,
                    runtime: runtimeDescriptor.runtime || null,
                };
                const finalPreflight = runPluginPreflight(entry, {
                    host: normalizedHost,
                    api: runtimeDescriptor?.runtime?.pluginApi,
                    moduleUrlStrategy,
                });
                if (finalPreflight.ok === false) {
                    logger?.error?.(
                        `[Cerebr] Refused to load ${normalizedHost} script plugin "${descriptor.id}" `
                        + `because preflight failed: ${formatPluginPreflightIssues(finalPreflight.errors)}`
                    );
                    await unregisterDynamicPlugin(descriptor.id, registeredPluginIds, activePluginIds);
                    continue;
                }
                runtimeDescriptor.runtime.preflight = finalPreflight;
                runtimeDescriptor.runtime.pluginContext = createPluginRuntimeContext(entry, {
                    api: runtimeDescriptor?.runtime?.pluginApi,
                    context: runtimeDescriptor?.runtime?.pluginContext?.context
                        || runtimeDescriptor?.runtime?.pluginContext
                        || runtimeDescriptor?.runtime?.pluginApi,
                    host: normalizedHost,
                    preflight: finalPreflight,
                    diagnostics: runtimeDescriptor?.runtime?.pluginContext?.diagnostics,
                });

                if (dynamicEntrySignatures.get(descriptor.id) !== signature || !registeredPluginIds.has(descriptor.id)) {
                    await pluginKernel.register(entry);
                    dynamicEntrySignatures.set(descriptor.id, signature);
                    registeredPluginIds.add(descriptor.id);
                    activePluginIds.add(descriptor.id);
                }
            } catch (error) {
                logger?.error?.(
                    `[Cerebr] Failed to load ${normalizedHost} script plugin "${descriptor.id}" `
                    + `(runtimePluginApiKeys=${runtimePluginApiKeys.join(',') || 'none'})`,
                    error
                );
                await unregisterDynamicPlugin(descriptor.id, registeredPluginIds, activePluginIds);
            }
        }

        return desiredPluginIds;
    };

    const applyPluginSettings = async (settings) => {
        const activePluginIds = new Set(pluginKernel.getActivePluginIds());
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

        await pluginKernel.start();
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
        if (shellPluginApiRegistry) {
            Object.keys(shellPluginApiRegistry).forEach((pluginId) => {
                delete shellPluginApiRegistry[pluginId];
            });
        }
        scriptPluginCache.clear();
        dynamicEntrySignatures.clear();
        await pluginKernel.stop();
    };

    return {
        host: normalizedHost,
        pluginKernel,
        pluginManager: pluginKernel,
        syncPlugins,
        start,
        stop,
        isStarted() {
            return started;
        },
    };
}
