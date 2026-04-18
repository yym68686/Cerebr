import { getAppVersion } from '../../utils/app-version.js';
import { isExtensionEnvironment } from '../../utils/storage-adapter.js';
import { validatePluginManifest } from '../market/plugin-schema.js';
import { satisfiesVersionRange } from '../market/version-utils.js';
import { getBuiltinPluginManifestById } from '../shared/plugin-catalog.js';
import {
    getPluginRecord,
    installLocalScriptPlugin,
    isPluginEnabled,
    readPluginState,
    uninstallPlugin,
} from '../shared/plugin-store.js';
import {
    readInstalledPluginPackage,
    removeInstalledPluginPackage,
    writeInstalledPluginPackage,
} from '../shared/plugin-package-store.js';
import { materializeReviewedScriptPluginPackage } from '../shared/reviewed-script-package.js';
import { readDeveloperModePreference } from './developer-mode.js';
import {
    readLocalPluginBundleFromDataTransfer,
    readLocalPluginBundleFromFileList,
    validateLocalShellPluginBundle,
} from './local-plugin-bundle.js';
import {
    normalizeLocalPluginSourceLabel,
    resolveLocalPluginSourceUrl,
} from './local-plugin-source.js';

function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function normalizeStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => normalizeString(item)).filter(Boolean);
}

const GUEST_PAGE_PERMISSION_SET = new Set([
    'page:selection:read',
    'page:selection:clear',
    'page:snapshot',
    'shell:input:write',
    'ui:anchored-action',
]);

function canUseGuestPageMode(manifest = {}) {
    if (!isExtensionEnvironment || normalizeString(manifest?.scope) !== 'page') {
        return false;
    }

    const activationEvents = normalizeStringArray(manifest?.activationEvents);
    if (activationEvents.some((eventName) => eventName.startsWith('hook:'))) {
        return false;
    }

    const permissions = normalizeStringArray(manifest?.permissions);
    return permissions.every((permission) => {
        return (
            GUEST_PAGE_PERMISSION_SET.has(permission)
            || permission.startsWith('bridge:send:')
        );
    });
}

function resolveLocalBundleSourceMode(manifest = {}, fallbackMode = 'bundle') {
    if (isExtensionEnvironment && normalizeString(manifest?.scope) === 'shell') {
        return 'guest';
    }
    if (canUseGuestPageMode(manifest)) {
        return 'guest';
    }
    return normalizeString(fallbackMode, 'bundle');
}

function isRuntimeSupported(record = {}) {
    if (normalizeString(record?.scope) === 'background') {
        return isExtensionEnvironment;
    }
    if (!record.requiresExtension) return true;
    return isExtensionEnvironment;
}

function getCompatibilityRange(record = {}, manifest = {}) {
    return normalizeString(
        manifest.compatibility?.versionRange || record.compatibility?.versionRange
    );
}

function buildLocalPluginPackage(manifest, sourceMeta = {}) {
    const bundle = sourceMeta.bundle && typeof sourceMeta.bundle === 'object'
        ? {
            manifestPath: normalizeString(sourceMeta.bundle.manifestPath, 'plugin.json'),
            files: sourceMeta.bundle.files && typeof sourceMeta.bundle.files === 'object'
                ? { ...sourceMeta.bundle.files }
                : {},
        }
        : null;

    return {
        ...manifest,
        source: {
            manifestUrl: normalizeString(sourceMeta.manifestUrl),
            sourceLabel: normalizeString(sourceMeta.sourceLabel),
            mode: normalizeString(sourceMeta.mode, bundle ? 'bundle' : 'url'),
            ...(bundle ? { bundle } : {}),
        },
    };
}

function buildLocalPluginSourceMeta(manifestUrl, sourceLabel = '') {
    const normalizedManifestUrl = normalizeString(manifestUrl);

    return {
        manifestUrl: normalizedManifestUrl,
        sourceLabel: normalizeLocalPluginSourceLabel(sourceLabel || normalizedManifestUrl),
    };
}

function buildDroppedBundleFromInstalledPackage(installedPackage, pluginId = '') {
    const bundle = installedPackage?.source?.bundle && typeof installedPackage.source.bundle === 'object'
        ? installedPackage.source.bundle
        : null;
    if (!bundle || !bundle.files || typeof bundle.files !== 'object') {
        return null;
    }

    return {
        manifest: validatePluginManifest(installedPackage),
        sourceLabel: normalizeString(installedPackage?.source?.sourceLabel, pluginId),
        bundle: {
            manifestPath: normalizeString(bundle.manifestPath, 'plugin.json'),
            files: { ...bundle.files },
        },
    };
}

function deriveMarketplaceManifestUrl(record = {}, pluginPackage = {}) {
    const explicitManifestUrl = normalizeString(
        pluginPackage?.source?.manifestUrl || record?.manifestUrl
    );
    if (explicitManifestUrl) {
        return explicitManifestUrl;
    }

    const entryUrl = normalizeString(pluginPackage?.script?.entry || record?.entryUrl);
    if (!entryUrl) {
        return '';
    }

    try {
        return new URL('./plugin.json', entryUrl).toString();
    } catch {
        return '';
    }
}

async function fetchPluginManifestFromUrl(sourceUrl) {
    const response = await fetch(sourceUrl, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`Failed to load local plugin manifest: ${response.status}`);
    }

    let payload = null;
    try {
        payload = await response.json();
    } catch (error) {
        throw new Error(`Failed to parse local plugin manifest: ${error?.message || String(error)}`);
    }

    return validatePluginManifest(payload, sourceUrl);
}

async function ensureDeveloperModeEnabled() {
    const enabled = await readDeveloperModePreference();
    if (!enabled) {
        throw new Error('Developer mode is disabled');
    }
}

async function ensureScriptPluginInstallable(manifest) {
    if (manifest.kind !== 'script') {
        throw new Error(`Local sideload only supports script plugins. Received "${manifest.kind}"`);
    }
    if (manifest.scope !== 'page' && manifest.scope !== 'shell' && manifest.scope !== 'background') {
        throw new Error(`Script plugin "${manifest.id}" must target "page", "shell", or "background"`);
    }
    if (getBuiltinPluginManifestById(manifest.id)) {
        throw new Error(`Plugin id "${manifest.id}" is reserved by a built-in plugin`);
    }

    const state = await readPluginState();
    const existing = getPluginRecord(state, manifest.id);
    if (existing?.installed && existing.sourceType && existing.sourceType !== 'developer') {
        throw new Error(`Plugin id "${manifest.id}" is already used by a non-local plugin`);
    }
}

async function installLocalScriptPluginPackage(manifest, sourceMeta = {}) {
    await ensureScriptPluginInstallable(manifest);

    const pluginPackage = buildLocalPluginPackage(manifest, sourceMeta);
    await writeInstalledPluginPackage(manifest.id, pluginPackage);
    await installLocalScriptPlugin(manifest, {
        manifestUrl: normalizeString(sourceMeta.manifestUrl),
        sourceLabel: normalizeString(sourceMeta.sourceLabel),
        entryUrl: manifest.script?.entry,
        exportName: manifest.script?.exportName,
    });

    return pluginPackage;
}

async function installLocalScriptPluginFromManifestUrl(manifestUrl, sourceLabel = '') {
    const manifest = await fetchPluginManifestFromUrl(manifestUrl);
    return installLocalScriptPluginPackage(manifest, buildLocalPluginSourceMeta(manifestUrl, sourceLabel));
}

async function readLocalScriptPluginItemsInternal() {
    return readInstalledScriptPluginItemsInternal({
        sourceType: 'developer',
    });
}

async function readInstalledScriptPluginItemsInternal({ sourceType = '' } = {}) {
    const [state, appVersion] = await Promise.all([
        readPluginState(),
        getAppVersion(),
    ]);

    const items = [];

    for (const [pluginId, record] of Object.entries(state.plugins || {})) {
        if (!record?.installed || record.kind !== 'script') {
            continue;
        }
        if (sourceType && record.sourceType !== sourceType) {
            continue;
        }

        const pluginPackage = await readInstalledPluginPackage(pluginId);
        if (!pluginPackage?.script?.entry) {
            continue;
        }

        let effectivePluginPackage = pluginPackage;
        if (
            normalizeString(record.sourceType) === 'developer'
            && effectivePluginPackage?.kind === 'script'
            && effectivePluginPackage?.source?.bundle
        ) {
            const nextSourceMode = resolveLocalBundleSourceMode(
                effectivePluginPackage,
                normalizeString(effectivePluginPackage?.source?.mode, 'bundle')
            );
            if (nextSourceMode !== normalizeString(effectivePluginPackage?.source?.mode, 'bundle')) {
                effectivePluginPackage = {
                    ...effectivePluginPackage,
                    source: {
                        ...(effectivePluginPackage?.source && typeof effectivePluginPackage.source === 'object'
                            ? effectivePluginPackage.source
                            : {}),
                        mode: nextSourceMode,
                    },
                };
                await writeInstalledPluginPackage(pluginId, effectivePluginPackage);
            }
        }
        if (
            normalizeString(record.sourceType) === 'registry'
            && effectivePluginPackage?.kind === 'script'
            && !effectivePluginPackage?.source?.bundle
        ) {
            const manifestUrl = deriveMarketplaceManifestUrl(record, effectivePluginPackage);
            if (manifestUrl) {
                try {
                    effectivePluginPackage = await materializeReviewedScriptPluginPackage(
                        effectivePluginPackage,
                        manifestUrl
                    );
                    await writeInstalledPluginPackage(pluginId, effectivePluginPackage);
                } catch (error) {
                    console.warn(
                        `[Cerebr] Failed to migrate reviewed script plugin "${pluginId}" into a bundled package`,
                        error
                    );
                }
            }
        }

        const compatibilityRange = getCompatibilityRange(record, effectivePluginPackage);
        items.push({
            id: pluginId,
            kind: 'script',
            scope: normalizeString(record.scope || effectivePluginPackage.scope),
            sourceType: normalizeString(record.sourceType, 'developer'),
            displayName: normalizeString(record.displayName || effectivePluginPackage.displayName || pluginId),
            description: normalizeString(record.description || effectivePluginPackage.description),
            permissions: normalizeStringArray(record.permissions?.length ? record.permissions : effectivePluginPackage.permissions),
            enabled: isPluginEnabled(state, pluginId, effectivePluginPackage.defaultEnabled !== false),
            installedVersion: normalizeString(record.installedVersion || effectivePluginPackage.version),
            latestVersion: normalizeString(record.latestVersion || effectivePluginPackage.version),
            compatibilityRange,
            compatible: satisfiesVersionRange(appVersion, compatibilityRange),
            runtimeSupported: isRuntimeSupported(record),
            requiresExtension: !!(record.requiresExtension ?? effectivePluginPackage.requiresExtension),
            sourceLabel: normalizeString(
                record.sourceLabel || effectivePluginPackage.source?.sourceLabel || record.manifestUrl || effectivePluginPackage.source?.manifestUrl
            ),
            manifestUrl: normalizeString(record.manifestUrl || effectivePluginPackage.source?.manifestUrl),
            entryUrl: normalizeString(record.entryUrl || effectivePluginPackage.script?.entry),
            canRefresh: !!(
                record.manifestUrl
                || effectivePluginPackage.source?.manifestUrl
                || effectivePluginPackage.source?.bundle
            ),
            record: { ...record },
            manifest: effectivePluginPackage,
        });
    }

    return items.sort((left, right) => {
        return left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' });
    });
}

export async function installLocalScriptPluginFromDataTransfer(dataTransfer) {
    const droppedBundle = await readLocalPluginBundleFromDataTransfer(dataTransfer);
    await ensureDeveloperModeEnabled();

    if (droppedBundle.manifest?.scope === 'shell') {
        validateLocalShellPluginBundle(droppedBundle.manifest, droppedBundle.bundle?.files);
    }

    return installLocalScriptPluginPackage(droppedBundle.manifest, {
        sourceLabel: droppedBundle.sourceLabel,
        mode: resolveLocalBundleSourceMode(droppedBundle.manifest, 'bundle'),
        bundle: droppedBundle.bundle,
    });
}

export async function installLocalScriptPluginFromFileList(fileList) {
    const droppedBundle = await readLocalPluginBundleFromFileList(fileList);
    await ensureDeveloperModeEnabled();

    if (droppedBundle.manifest?.scope === 'shell') {
        validateLocalShellPluginBundle(droppedBundle.manifest, droppedBundle.bundle?.files);
    }

    return installLocalScriptPluginPackage(droppedBundle.manifest, {
        sourceLabel: droppedBundle.sourceLabel,
        mode: resolveLocalBundleSourceMode(droppedBundle.manifest, 'bundle'),
        bundle: droppedBundle.bundle,
    });
}

export async function installLocalScriptPluginFromUrl(source) {
    await ensureDeveloperModeEnabled();

    const manifestUrl = resolveLocalPluginSourceUrl(source);
    const sourceLabel = normalizeLocalPluginSourceLabel(source);
    return installLocalScriptPluginFromManifestUrl(manifestUrl, sourceLabel);
}

export async function refreshLocalScriptPlugin(pluginId) {
    await ensureDeveloperModeEnabled();

    const installedPackage = await readInstalledPluginPackage(pluginId);
    const manifestUrl = normalizeString(installedPackage?.source?.manifestUrl);
    const sourceLabel = normalizeString(installedPackage?.source?.sourceLabel, manifestUrl);

    if (!manifestUrl) {
        const droppedBundle = buildDroppedBundleFromInstalledPackage(installedPackage, pluginId);
        if (droppedBundle) {
            if (droppedBundle.manifest?.scope === 'shell') {
                validateLocalShellPluginBundle(droppedBundle.manifest, droppedBundle.bundle?.files);
            }

            return installLocalScriptPluginPackage(droppedBundle.manifest, {
                sourceLabel: droppedBundle.sourceLabel || pluginId,
                mode: resolveLocalBundleSourceMode(
                    droppedBundle.manifest,
                    normalizeString(installedPackage?.source?.mode, 'bundle')
                ),
                bundle: droppedBundle.bundle,
            });
        }
        throw new Error(`Local script plugin "${pluginId}" is missing its manifest source`);
    }

    const manifest = await fetchPluginManifestFromUrl(manifestUrl);
    if (manifest.id !== pluginId) {
        throw new Error(`Plugin manifest id mismatch: expected "${pluginId}", received "${manifest.id}"`);
    }

    const pluginPackage = buildLocalPluginPackage(manifest, {
        manifestUrl,
        sourceLabel,
    });

    await writeInstalledPluginPackage(pluginId, pluginPackage);
    await installLocalScriptPlugin(manifest, {
        manifestUrl,
        sourceLabel,
        entryUrl: manifest.script?.entry,
        exportName: manifest.script?.exportName,
    });

    return pluginPackage;
}

export async function uninstallLocalScriptPlugin(pluginId) {
    if (!pluginId) {
        throw new Error('uninstallLocalScriptPlugin requires a plugin id');
    }

    await removeInstalledPluginPackage(pluginId);
    return uninstallPlugin(pluginId);
}

export async function getDeveloperPluginModel() {
    const items = await readLocalScriptPluginItemsInternal();

    return {
        items: items.map(({ record, manifest, ...item }) => ({
            ...item,
        })),
    };
}

export async function getInstalledLocalScriptPlugins({ scope = '' } = {}) {
    const items = await readInstalledScriptPluginItemsInternal({ sourceType: 'developer' });
    return items.filter((item) => {
        if (!scope) return true;
        return item.scope === scope;
    });
}

export async function getInstalledScriptPlugins({ scope = '' } = {}) {
    const items = await readInstalledScriptPluginItemsInternal();
    return items.filter((item) => {
        if (!scope) return true;
        return item.scope === scope;
    });
}
