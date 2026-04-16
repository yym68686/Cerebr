import { getAppVersion } from '../../utils/app-version.js';
import { isExtensionEnvironment } from '../../utils/storage-adapter.js';
import { getBuiltinPluginManifests } from '../shared/plugin-catalog.js';
import {
    getPluginRecord,
    installBuiltinPlugin,
    installMarketplacePlugin,
    isPluginEnabled,
    isPluginInstalled,
    readPluginState,
    reconcileRegistryPluginState,
    setPluginEnabled,
    uninstallPlugin,
} from '../shared/plugin-store.js';
import { readInstalledPluginPackage, removeInstalledPluginPackage, writeInstalledPluginPackage } from '../shared/plugin-package-store.js';
import { fetchPluginManifestFromUrl, fetchPluginRegistrySource, DEFAULT_PLUGIN_REGISTRY_SOURCES } from './plugin-registry-client.js';
import { isVersionNewer, satisfiesVersionRange } from './version-utils.js';

function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function mergeBuiltinCatalogEntry(manifest) {
    return {
        ...manifest,
        registryId: 'builtin',
        sourceType: 'builtin',
        sourceId: 'builtin',
        install: {
            mode: normalizeString(manifest.installMode, 'builtin'),
            packageUrl: '',
        },
        displayName: '',
        description: '',
    };
}

function getPluginDisplayName(entry) {
    return normalizeString(entry.displayName);
}

function getPluginDescription(entry) {
    return normalizeString(entry.description);
}

function isRuntimeSupported(entry) {
    if (normalizeString(entry?.scope) === 'background') {
        return isExtensionEnvironment;
    }
    if (!entry?.requiresExtension) return true;
    return isExtensionEnvironment;
}

function toInstalledViewModel(entry, state, appVersion) {
    const defaultInstalled = entry.kind === 'builtin' ? entry.defaultInstalled !== false : false;
    const installed = isPluginInstalled(state, entry.id, defaultInstalled);
    if (!installed) return null;

    const record = getPluginRecord(state, entry.id) || {};
    const availabilityStatus = normalizeString(record.availability?.status || entry.availability?.status, 'active');
    const availabilityReason = normalizeString(record.availability?.reason || entry.availability?.reason);
    const compatibilityRange = normalizeString(record.compatibility?.versionRange || entry.compatibility?.versionRange);
    const compatible = satisfiesVersionRange(appVersion, compatibilityRange);
    const installedVersion = normalizeString(record.installedVersion || entry.latestVersion);
    const latestVersion = normalizeString(record.latestVersion || entry.latestVersion);

    return {
        id: entry.id,
        kind: entry.kind,
        scope: entry.scope,
        sourceType: entry.sourceType,
        registryId: normalizeString(entry.registryId),
        displayName: getPluginDisplayName(entry),
        description: getPluginDescription(entry),
        nameKey: entry.nameKey || '',
        descriptionKey: entry.descriptionKey || '',
        permissions: record.permissions?.length ? record.permissions : (entry.permissions || []),
        availabilityStatus,
        availabilityReason,
        compatible,
        compatibilityRange,
        enabled: isPluginEnabled(state, entry.id, entry.defaultEnabled !== false),
        installedVersion,
        latestVersion,
        updateAvailable: !!installedVersion && !!latestVersion && isVersionNewer(latestVersion, installedVersion),
        installMode: normalizeString(record.installMode || entry.install?.mode || entry.installMode),
        requiresExtension: !!entry.requiresExtension,
        runtimeSupported: isRuntimeSupported(entry),
        homepage: normalizeString(record.homepage || entry.homepage),
        canUninstall: entry.kind !== 'builtin' || entry.defaultInstalled === false,
    };
}

function toMarketplaceViewModel(entry, state, appVersion) {
    const defaultInstalled = entry.kind === 'builtin' ? entry.defaultInstalled !== false : false;
    const installed = isPluginInstalled(state, entry.id, defaultInstalled);
    const record = getPluginRecord(state, entry.id) || {};
    const installedVersion = normalizeString(record.installedVersion);
    const latestVersion = normalizeString(record.latestVersion || entry.latestVersion);
    const compatibilityRange = normalizeString(entry.compatibility?.versionRange);
    const compatibilityOk = satisfiesVersionRange(appVersion, compatibilityRange);
    const availabilityStatus = normalizeString(record.availability?.status || entry.availability?.status, 'active');
    const availabilityReason = normalizeString(record.availability?.reason || entry.availability?.reason);
    return {
        id: entry.id,
        kind: entry.kind,
        scope: entry.scope,
        sourceType: entry.sourceType,
        registryId: normalizeString(entry.registryId),
        displayName: getPluginDisplayName(entry),
        description: getPluginDescription(entry),
        nameKey: entry.nameKey || '',
        descriptionKey: entry.descriptionKey || '',
        permissions: entry.permissions || [],
        availabilityStatus,
        availabilityReason,
        compatibilityRange,
        compatible: compatibilityOk,
        installed,
        enabled: isPluginEnabled(state, entry.id, entry.defaultEnabled !== false),
        installedVersion,
        latestVersion,
        updateAvailable: installed && !!installedVersion && !!latestVersion && isVersionNewer(latestVersion, installedVersion),
        installMode: normalizeString(entry.install?.mode || entry.installMode),
        requiresExtension: !!entry.requiresExtension,
        runtimeSupported: isRuntimeSupported(entry),
        homepage: normalizeString(entry.homepage),
        packageUrl: normalizeString(entry.install?.packageUrl),
        devModeOnly: false,
        canUninstall: entry.kind !== 'builtin' || entry.defaultInstalled === false,
    };
}

function shouldShowMarketplaceItem(item) {
    if (!item) return false;
    if (item.availabilityStatus === 'disabled') return false;
    if (!item.compatible) return false;
    if (!item.runtimeSupported) return false;
    return true;
}

async function fetchAllRegistryEntries() {
    const sources = [];
    const entries = [];
    let allSourcesOk = true;

    for (const source of DEFAULT_PLUGIN_REGISTRY_SOURCES) {
        try {
            const registry = await fetchPluginRegistrySource(source);
            sources.push({
                id: registry.registryId,
                displayName: registry.displayName,
                generatedAt: registry.generatedAt,
                ok: true,
            });
            entries.push(...registry.plugins);
        } catch (error) {
            sources.push({
                id: source.id,
                displayName: source.displayName,
                generatedAt: '',
                ok: false,
                error: error?.message || String(error),
            });
            allSourcesOk = false;
        }
    }

    return { sources, entries, allSourcesOk };
}

async function buildInstalledOnlyEntries(state, knownEntriesById) {
    const installedPluginIds = Object.entries(state?.plugins || {})
        .filter(([, record]) => record?.installed)
        .map(([pluginId]) => pluginId)
        .filter((pluginId) => !knownEntriesById.has(pluginId));

    const entries = await Promise.all(
        installedPluginIds.map(async (pluginId) => {
            const record = getPluginRecord(state, pluginId) || {};
            const pluginPackage = await readInstalledPluginPackage(pluginId);

            return {
                id: pluginId,
                registryId: normalizeString(record.sourceId),
                sourceId: normalizeString(record.sourceId),
                sourceType: normalizeString(record.sourceType, 'registry'),
                kind: normalizeString(record.kind || pluginPackage?.kind),
                scope: normalizeString(record.scope || pluginPackage?.scope),
                displayName: normalizeString(record.displayName || pluginPackage?.displayName),
                description: normalizeString(record.description || pluginPackage?.description),
                latestVersion: normalizeString(record.latestVersion || pluginPackage?.version),
                requiresExtension: typeof record.requiresExtension === 'boolean'
                    ? record.requiresExtension
                    : !!pluginPackage?.requiresExtension,
                permissions: record.permissions?.length ? record.permissions : (pluginPackage?.permissions || []),
                compatibility: {
                    versionRange: normalizeString(
                        record.compatibility?.versionRange || pluginPackage?.compatibility?.versionRange
                    ),
                },
                availability: {
                    status: normalizeString(record.availability?.status, 'active'),
                    reason: normalizeString(record.availability?.reason),
                },
                install: {
                    mode: normalizeString(record.installMode, pluginPackage ? 'package' : ''),
                    packageUrl: '',
                },
                publisher: normalizeString(pluginPackage?.publisher),
                homepage: normalizeString(record.homepage || pluginPackage?.homepage),
                nameKey: '',
                descriptionKey: '',
            };
        })
    );

    return entries.filter((entry) => entry.id && entry.kind && entry.scope);
}

export async function getPluginMarketplaceModel() {
    const appVersion = await getAppVersion();
    const [state, registryResult] = await Promise.all([
        readPluginState(),
        fetchAllRegistryEntries(),
    ]);

    const shouldReconcileRegistryState = registryResult.sources.length > 0 && registryResult.allSourcesOk;
    if (shouldReconcileRegistryState) {
        await reconcileRegistryPluginState(registryResult.entries);
    }
    const effectiveState = shouldReconcileRegistryState ? await readPluginState() : state;

    const builtinEntries = getBuiltinPluginManifests().map(mergeBuiltinCatalogEntry);
    const mergedEntriesById = new Map(
        builtinEntries.map((entry) => [entry.id, entry])
    );

    registryResult.entries.forEach((entry) => {
        if (!entry || entry.kind === 'builtin') return;
        mergedEntriesById.set(entry.id, entry);
    });

    const installedOnlyEntries = await buildInstalledOnlyEntries(effectiveState, mergedEntriesById);
    installedOnlyEntries.forEach((entry) => {
        mergedEntriesById.set(entry.id, entry);
    });
    const mergedEntries = Array.from(mergedEntriesById.values());

    return {
        appVersion,
        sources: registryResult.sources,
        installedItems: mergedEntries
            .map((entry) => toInstalledViewModel(entry, effectiveState, appVersion))
            .filter(Boolean),
        marketplaceItems: mergedEntries
            .map((entry) => toMarketplaceViewModel(entry, effectiveState, appVersion))
            .filter(shouldShowMarketplaceItem),
    };
}

export async function installMarketplaceItem(item) {
    if (!item?.id) {
        throw new Error('installMarketplaceItem requires a plugin item');
    }
    if (item.availabilityStatus === 'disabled') {
        throw new Error(item.availabilityReason || 'This plugin has been disabled by the registry');
    }
    if (!item.compatible) {
        throw new Error(`Plugin "${item.id}" is not compatible with this Cerebr version`);
    }
    if (item.requiresExtension && !item.runtimeSupported) {
        throw new Error('This plugin is only available in the browser extension');
    }

    if (item.kind === 'builtin') {
        return installBuiltinPlugin({
            id: item.id,
            kind: item.kind,
            scope: item.scope,
            installMode: item.installMode,
            latestVersion: item.latestVersion,
            permissions: item.permissions,
            compatibility: { versionRange: item.compatibilityRange },
            availability: {
                status: item.availabilityStatus,
                reason: item.availabilityReason,
            },
        });
    }

    if (!item.packageUrl) {
        throw new Error(`Plugin "${item.id}" is missing packageUrl`);
    }

    const pluginManifest = await fetchPluginManifestFromUrl(item.packageUrl);
    await writeInstalledPluginPackage(item.id, pluginManifest);
    await installMarketplacePlugin(pluginManifest, {
        id: item.id,
        kind: item.kind,
        scope: item.scope,
        registryId: item.registryId,
        sourceType: item.sourceType,
        latestVersion: item.latestVersion,
        permissions: item.permissions,
        compatibility: { versionRange: item.compatibilityRange },
        availability: {
            status: item.availabilityStatus,
            reason: item.availabilityReason,
        },
        install: {
            mode: item.installMode,
        },
        homepage: item.homepage,
        displayName: item.displayName,
        description: item.description,
    });

    return pluginManifest;
}

export async function updateMarketplaceItem(item) {
    return installMarketplaceItem(item);
}

export async function uninstallMarketplaceItem(item) {
    if (!item?.id) {
        throw new Error('uninstallMarketplaceItem requires a plugin item');
    }

    if (item.kind !== 'builtin') {
        await removeInstalledPluginPackage(item.id);
    }
    return uninstallPlugin(item.id);
}

export async function toggleInstalledPlugin(item, enabled) {
    if (!item?.id) {
        throw new Error('toggleInstalledPlugin requires a plugin item');
    }
    return setPluginEnabled(item.id, enabled);
}

export async function getInstalledPromptFragments() {
    const state = await readPluginState();
    const appVersion = await getAppVersion();
    const fragments = [];

    for (const [pluginId, record] of Object.entries(state.plugins || {})) {
        if (!record?.installed || record.kind !== 'declarative') continue;
        if (!isPluginEnabled(state, pluginId, true)) continue;
        if (normalizeString(record.availability?.status, 'active') === 'disabled') continue;

        const pluginPackage = await readInstalledPluginPackage(pluginId);
        if (!pluginPackage?.declarative || pluginPackage.declarative.type !== 'prompt_fragment') {
            continue;
        }

        const compatibilityRange = normalizeString(
            pluginPackage.compatibility?.versionRange || record.compatibility?.versionRange
        );
        if (compatibilityRange && !satisfiesVersionRange(appVersion, compatibilityRange)) {
            continue;
        }

        fragments.push({
            pluginId,
            placement: pluginPackage.declarative.placement,
            content: pluginPackage.declarative.content,
        });
    }

    return fragments;
}
