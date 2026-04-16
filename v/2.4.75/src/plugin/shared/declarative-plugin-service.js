import { getAppVersion } from '../../utils/app-version.js';
import { isExtensionEnvironment } from '../../utils/storage-adapter.js';
import { satisfiesVersionRange } from '../market/version-utils.js';
import { readInstalledPluginPackage } from './plugin-package-store.js';
import { isPluginEnabled, readPluginState } from './plugin-store.js';
import { normalizeString, normalizeStringArray } from '../core/runtime-utils.js';

export function createDeclarativePluginSignature(descriptor = {}) {
    const manifest = descriptor?.manifest || {};
    const record = descriptor?.record || {};

    return [
        normalizeString(manifest.id),
        normalizeString(manifest.version),
        normalizeString(manifest.scope),
        normalizeString(manifest.declarative?.type),
        String(record.updatedAt || record.installedAt || 0),
    ].join('|');
}

function isRuntimeSupported(record = {}) {
    if (!record.requiresExtension) return true;
    return isExtensionEnvironment;
}

export async function getInstalledDeclarativePluginDescriptors({ scopes = [] } = {}) {
    const [state, appVersion] = await Promise.all([
        readPluginState(),
        getAppVersion(),
    ]);
    const scopeSet = new Set(normalizeStringArray(scopes));
    const descriptors = [];

    for (const [pluginId, record] of Object.entries(state.plugins || {})) {
        if (!record?.installed || record.kind !== 'declarative') {
            continue;
        }

        if (scopeSet.size > 0 && !scopeSet.has(normalizeString(record.scope))) {
            continue;
        }

        const manifest = await readInstalledPluginPackage(pluginId);
        if (!manifest?.declarative?.type) {
            continue;
        }

        const compatibilityRange = normalizeString(
            manifest.compatibility?.versionRange || record.compatibility?.versionRange
        );

        const descriptor = {
            id: pluginId,
            kind: 'declarative',
            scope: normalizeString(record.scope || manifest.scope),
            sourceType: normalizeString(record.sourceType, 'registry'),
            displayName: normalizeString(record.displayName || manifest.displayName || pluginId),
            description: normalizeString(record.description || manifest.description),
            permissions: normalizeStringArray(
                record.permissions?.length ? record.permissions : manifest.permissions
            ),
            enabled: isPluginEnabled(state, pluginId, manifest.defaultEnabled !== false),
            installedVersion: normalizeString(record.installedVersion || manifest.version),
            latestVersion: normalizeString(record.latestVersion || manifest.version),
            compatibilityRange,
            compatible: compatibilityRange
                ? satisfiesVersionRange(appVersion, compatibilityRange)
                : true,
            runtimeSupported: isRuntimeSupported(record),
            requiresExtension: !!(record.requiresExtension ?? manifest.requiresExtension),
            record: { ...record },
            manifest,
        };

        descriptor.signature = createDeclarativePluginSignature(descriptor);
        descriptors.push(descriptor);
    }

    return descriptors.sort((left, right) => {
        const leftName = normalizeString(left.displayName || left.id);
        const rightName = normalizeString(right.displayName || right.id);
        return leftName.localeCompare(rightName, undefined, { sensitivity: 'base' });
    });
}
