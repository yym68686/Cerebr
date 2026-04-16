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
import { readDeveloperModePreference } from './developer-mode.js';
import { readLocalPluginBundleFromDataTransfer } from './local-plugin-bundle.js';
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

function isRuntimeSupported(record = {}) {
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
            mode: bundle ? 'bundle' : 'url',
            ...(bundle ? { bundle } : {}),
        },
    };
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
    if (manifest.scope !== 'page' && manifest.scope !== 'shell') {
        throw new Error(`Script plugin "${manifest.id}" must target "page" or "shell"`);
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

        const compatibilityRange = getCompatibilityRange(record, pluginPackage);
        items.push({
            id: pluginId,
            kind: 'script',
            scope: normalizeString(record.scope || pluginPackage.scope),
            sourceType: normalizeString(record.sourceType, 'developer'),
            displayName: normalizeString(record.displayName || pluginPackage.displayName || pluginId),
            description: normalizeString(record.description || pluginPackage.description),
            permissions: normalizeStringArray(record.permissions?.length ? record.permissions : pluginPackage.permissions),
            enabled: isPluginEnabled(state, pluginId, pluginPackage.defaultEnabled !== false),
            installedVersion: normalizeString(record.installedVersion || pluginPackage.version),
            latestVersion: normalizeString(record.latestVersion || pluginPackage.version),
            compatibilityRange,
            compatible: satisfiesVersionRange(appVersion, compatibilityRange),
            runtimeSupported: isRuntimeSupported(record),
            requiresExtension: !!(record.requiresExtension ?? pluginPackage.requiresExtension),
            sourceLabel: normalizeString(
                record.sourceLabel || pluginPackage.source?.sourceLabel || record.manifestUrl || pluginPackage.source?.manifestUrl
            ),
            manifestUrl: normalizeString(record.manifestUrl || pluginPackage.source?.manifestUrl),
            entryUrl: normalizeString(record.entryUrl || pluginPackage.script?.entry),
            record: { ...record },
            manifest: pluginPackage,
        });
    }

    return items.sort((left, right) => {
        return left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' });
    });
}

export async function installLocalScriptPluginFromSource(sourceInput) {
    await ensureDeveloperModeEnabled();

    const sourceLabel = normalizeLocalPluginSourceLabel(sourceInput);
    const manifestUrl = resolveLocalPluginSourceUrl(sourceInput);
    const manifest = await fetchPluginManifestFromUrl(manifestUrl);

    return installLocalScriptPluginPackage(manifest, {
        manifestUrl,
        sourceLabel,
    });
}

export async function installLocalScriptPluginFromDataTransfer(dataTransfer) {
    const droppedBundle = await readLocalPluginBundleFromDataTransfer(dataTransfer);
    await ensureDeveloperModeEnabled();

    return installLocalScriptPluginPackage(droppedBundle.manifest, {
        sourceLabel: droppedBundle.sourceLabel,
        bundle: droppedBundle.bundle,
    });
}

export async function refreshLocalScriptPlugin(pluginId) {
    await ensureDeveloperModeEnabled();

    const installedPackage = await readInstalledPluginPackage(pluginId);
    const manifestUrl = normalizeString(installedPackage?.source?.manifestUrl);
    const sourceLabel = normalizeString(installedPackage?.source?.sourceLabel, manifestUrl);

    if (!manifestUrl) {
        if (installedPackage?.source?.bundle) {
            throw new Error(`Local script plugin "${pluginId}" was installed from dropped files. Drag the updated plugin into Cerebr again to refresh it`);
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
        sampleManifestPath: '/statics/dev-plugins/explain-selection/plugin.json',
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
