export const PLUGIN_SETTINGS_KEY = 'cerebr_plugin_state_v2';
const LEGACY_PLUGIN_SETTINGS_KEY = 'cerebr_plugin_settings_v1';

function canUseExtensionSyncStorage() {
    return !!(typeof chrome !== 'undefined' && chrome.storage?.sync);
}

function getLocalStorageKey(key) {
    return `sync_${key}`;
}

function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function normalizeStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => normalizeString(item))
        .filter(Boolean);
}

function normalizePluginRecord(entry) {
    const normalized = {};

    if (typeof entry?.enabled === 'boolean') {
        normalized.enabled = entry.enabled;
    }
    if (typeof entry?.installed === 'boolean') {
        normalized.installed = entry.installed;
    }

    normalized.kind = normalizeString(entry?.kind);
    normalized.scope = normalizeString(entry?.scope);
    normalized.installMode = normalizeString(entry?.installMode);
    normalized.sourceType = normalizeString(entry?.sourceType);
    normalized.sourceId = normalizeString(entry?.sourceId);
    normalized.sourceLabel = normalizeString(entry?.sourceLabel);
    normalized.manifestUrl = normalizeString(entry?.manifestUrl);
    normalized.entryUrl = normalizeString(entry?.entryUrl);
    normalized.exportName = normalizeString(entry?.exportName, 'default');
    if (typeof entry?.requiresExtension === 'boolean') {
        normalized.requiresExtension = entry.requiresExtension;
    }
    normalized.displayName = normalizeString(entry?.displayName);
    normalized.description = normalizeString(entry?.description);
    normalized.installedVersion = normalizeString(entry?.installedVersion);
    normalized.latestVersion = normalizeString(entry?.latestVersion);
    normalized.homepage = normalizeString(entry?.homepage);
    normalized.permissions = normalizeStringArray(entry?.permissions);
    normalized.compatibility = {
        versionRange: normalizeString(entry?.compatibility?.versionRange),
    };
    normalized.availability = {
        status: normalizeString(entry?.availability?.status, 'active'),
        reason: normalizeString(entry?.availability?.reason),
    };

    if (typeof entry?.installedAt === 'number' && Number.isFinite(entry.installedAt)) {
        normalized.installedAt = entry.installedAt;
    }
    if (typeof entry?.updatedAt === 'number' && Number.isFinite(entry.updatedAt)) {
        normalized.updatedAt = entry.updatedAt;
    }

    return normalized;
}

function pluginRecordsEqual(left, right) {
    return JSON.stringify(normalizePluginRecord(left)) === JSON.stringify(normalizePluginRecord(right));
}

export function normalizePluginSettings(rawSettings) {
    const plugins = rawSettings?.plugins && typeof rawSettings.plugins === 'object'
        ? rawSettings.plugins
        : {};

    return {
        plugins: Object.fromEntries(
            Object.entries(plugins).map(([pluginId, entry]) => [pluginId, normalizePluginRecord(entry)])
        ),
    };
}

async function readSyncStorageValue(key) {
    if (canUseExtensionSyncStorage()) {
        const result = await chrome.storage.sync.get(key);
        return result?.[key];
    }

    try {
        const raw = localStorage.getItem(getLocalStorageKey(key));
        return raw ? JSON.parse(raw) : undefined;
    } catch (error) {
        console.error(`[Cerebr] Failed to read plugin storage key "${key}"`, error);
        return undefined;
    }
}

async function writeSyncStorageValue(key, value) {
    if (canUseExtensionSyncStorage()) {
        await chrome.storage.sync.set({ [key]: value });
        return;
    }

    localStorage.setItem(getLocalStorageKey(key), JSON.stringify(value));
}

async function migrateLegacyPluginSettings() {
    const legacyValue = await readSyncStorageValue(LEGACY_PLUGIN_SETTINGS_KEY);
    const legacyPlugins = legacyValue?.plugins && typeof legacyValue.plugins === 'object'
        ? legacyValue.plugins
        : {};

    if (Object.keys(legacyPlugins).length === 0) {
        return normalizePluginSettings(undefined);
    }

    const migrated = normalizePluginSettings({
        plugins: Object.fromEntries(
            Object.entries(legacyPlugins).map(([pluginId, record]) => [
                pluginId,
                {
                    enabled: typeof record?.enabled === 'boolean' ? record.enabled : undefined,
                },
            ])
        ),
    });

    await writeSyncStorageValue(PLUGIN_SETTINGS_KEY, migrated);
    return migrated;
}

export async function readPluginState() {
    const value = await readSyncStorageValue(PLUGIN_SETTINGS_KEY);
    if (value && typeof value === 'object') {
        return normalizePluginSettings(value);
    }

    return migrateLegacyPluginSettings();
}

export async function writePluginState(nextState) {
    const normalized = normalizePluginSettings(nextState);
    await writeSyncStorageValue(PLUGIN_SETTINGS_KEY, normalized);
    return normalized;
}

export async function updatePluginRecord(pluginId, updater) {
    if (!pluginId || typeof updater !== 'function') {
        throw new Error('updatePluginRecord requires a plugin id and updater');
    }

    const currentState = await readPluginState();
    const currentRecord = normalizePluginRecord(currentState.plugins?.[pluginId]);
    const nextRecordInput = await updater(currentRecord, currentState);
    if (!nextRecordInput || typeof nextRecordInput !== 'object') {
        return currentState;
    }

    const nextState = {
        ...currentState,
        plugins: {
            ...currentState.plugins,
            [pluginId]: normalizePluginRecord({
                ...currentRecord,
                ...nextRecordInput,
            }),
        },
    };

    return writePluginState(nextState);
}

export function getPluginRecord(state, pluginId) {
    if (!pluginId) return null;
    const normalizedState = normalizePluginSettings(state);
    const record = normalizedState.plugins?.[pluginId];
    return record ? { ...record } : null;
}

export function isPluginEnabled(settingsOrState, pluginId, defaultEnabled = true) {
    const enabled = settingsOrState?.plugins?.[pluginId]?.enabled;
    return typeof enabled === 'boolean' ? enabled : defaultEnabled;
}

export function isPluginInstalled(state, pluginId, defaultInstalled = false) {
    const installed = state?.plugins?.[pluginId]?.installed;
    return typeof installed === 'boolean' ? installed : defaultInstalled;
}

export async function setPluginEnabled(pluginId, enabled) {
    return updatePluginRecord(pluginId, (currentRecord) => ({
        ...currentRecord,
        enabled: !!enabled,
        updatedAt: Date.now(),
    }));
}

export async function upsertPluginMetadata(pluginId, metadata = {}) {
    return updatePluginRecord(pluginId, (currentRecord) => ({
        ...currentRecord,
        ...metadata,
        updatedAt: Date.now(),
    }));
}

export async function installBuiltinPlugin(manifest = {}) {
    const pluginId = normalizeString(manifest.id);
    if (!pluginId) {
        throw new Error('installBuiltinPlugin requires a manifest id');
    }

    return updatePluginRecord(pluginId, (currentRecord) => ({
        ...currentRecord,
        installed: true,
        enabled: typeof currentRecord.enabled === 'boolean'
            ? currentRecord.enabled
            : manifest.defaultEnabled !== false,
        kind: normalizeString(manifest.kind, 'builtin'),
        scope: normalizeString(manifest.scope),
        installMode: normalizeString(manifest.installMode, 'builtin'),
        sourceType: 'builtin',
        sourceId: normalizeString(manifest.sourceId, 'builtin'),
        requiresExtension: !!manifest.requiresExtension,
        displayName: normalizeString(manifest.displayName),
        description: normalizeString(manifest.description),
        installedVersion: normalizeString(manifest.latestVersion),
        latestVersion: normalizeString(manifest.latestVersion),
        homepage: normalizeString(manifest.homepage),
        permissions: normalizeStringArray(manifest.permissions),
        compatibility: {
            versionRange: normalizeString(manifest.compatibility?.versionRange),
        },
        availability: {
            status: normalizeString(manifest.availability?.status, 'active'),
            reason: normalizeString(manifest.availability?.reason),
        },
        installedAt: currentRecord.installedAt || Date.now(),
        updatedAt: Date.now(),
    }));
}

export async function installLocalScriptPlugin(manifest = {}, runtimeSource = {}) {
    const pluginId = normalizeString(manifest.id);
    if (!pluginId) {
        throw new Error('installLocalScriptPlugin requires a manifest id');
    }

    return updatePluginRecord(pluginId, (currentRecord) => ({
        ...currentRecord,
        installed: true,
        enabled: typeof currentRecord.enabled === 'boolean'
            ? currentRecord.enabled
            : manifest.defaultEnabled !== false,
        kind: normalizeString(manifest.kind, 'script'),
        scope: normalizeString(manifest.scope),
        installMode: 'script',
        sourceType: 'developer',
        sourceId: 'local',
        sourceLabel: normalizeString(runtimeSource.sourceLabel),
        manifestUrl: normalizeString(runtimeSource.manifestUrl),
        entryUrl: normalizeString(runtimeSource.entryUrl || manifest.script?.entry),
        exportName: normalizeString(runtimeSource.exportName || manifest.script?.exportName, 'default'),
        requiresExtension: !!manifest.requiresExtension,
        displayName: normalizeString(manifest.displayName),
        description: normalizeString(manifest.description),
        installedVersion: normalizeString(manifest.version),
        latestVersion: normalizeString(manifest.version),
        homepage: normalizeString(manifest.homepage),
        permissions: normalizeStringArray(manifest.permissions),
        compatibility: {
            versionRange: normalizeString(manifest.compatibility?.versionRange),
        },
        availability: {
            status: 'active',
            reason: '',
        },
        installedAt: currentRecord.installedAt || Date.now(),
        updatedAt: Date.now(),
    }));
}

export async function installMarketplacePlugin(manifest = {}, marketEntry = {}) {
    const pluginId = normalizeString(manifest.id || marketEntry.id);
    if (!pluginId) {
        throw new Error('installMarketplacePlugin requires a manifest id');
    }

    return updatePluginRecord(pluginId, (currentRecord) => ({
        ...currentRecord,
        installed: true,
        enabled: typeof currentRecord.enabled === 'boolean'
            ? currentRecord.enabled
            : true,
        kind: normalizeString(manifest.kind || marketEntry.kind),
        scope: normalizeString(manifest.scope || marketEntry.scope),
        installMode: normalizeString(marketEntry.install?.mode, 'package'),
        sourceType: normalizeString(marketEntry.sourceType, 'registry'),
        sourceId: normalizeString(marketEntry.registryId),
        requiresExtension: !!(manifest.requiresExtension ?? marketEntry.requiresExtension),
        displayName: normalizeString(manifest.displayName || marketEntry.displayName),
        description: normalizeString(manifest.description || marketEntry.description),
        installedVersion: normalizeString(manifest.version),
        latestVersion: normalizeString(marketEntry.latestVersion || manifest.version),
        homepage: normalizeString(manifest.homepage || marketEntry.homepage),
        permissions: normalizeStringArray(manifest.permissions?.length ? manifest.permissions : marketEntry.permissions),
        compatibility: {
            versionRange: normalizeString(
                manifest.compatibility?.versionRange || marketEntry.compatibility?.versionRange
            ),
        },
        availability: {
            status: normalizeString(marketEntry.availability?.status, 'active'),
            reason: normalizeString(marketEntry.availability?.reason),
        },
        installedAt: currentRecord.installedAt || Date.now(),
        updatedAt: Date.now(),
    }));
}

export async function uninstallPlugin(pluginId) {
    if (!pluginId) return readPluginState();

    return updatePluginRecord(pluginId, (currentRecord) => ({
        ...currentRecord,
        installed: false,
        enabled: false,
        installedVersion: '',
        updatedAt: Date.now(),
    }));
}

export async function reconcileRegistryPluginState(registryEntries = []) {
    const entriesById = new Map(
        (Array.isArray(registryEntries) ? registryEntries : [])
            .filter((entry) => entry?.id)
            .map((entry) => [entry.id, entry])
    );

    const currentState = await readPluginState();
    let mutated = false;
    const nextPlugins = { ...currentState.plugins };

    Object.entries(currentState.plugins).forEach(([pluginId, currentRecord]) => {
        if (!currentRecord?.installed || currentRecord.sourceType !== 'registry') {
            return;
        }

        const registryEntry = entriesById.get(pluginId);
        if (!registryEntry) {
            const candidateRecord = normalizePluginRecord({
                ...currentRecord,
                availability: {
                    status: 'disabled',
                    reason: 'Removed from registry',
                },
            });
            if (!pluginRecordsEqual(currentRecord, candidateRecord)) {
                nextPlugins[pluginId] = normalizePluginRecord({
                    ...candidateRecord,
                    updatedAt: Date.now(),
                });
                mutated = true;
            }
            return;
        }

        const candidateRecord = normalizePluginRecord({
            ...currentRecord,
            latestVersion: normalizeString(registryEntry.latestVersion),
            requiresExtension: typeof registryEntry.requiresExtension === 'boolean'
                ? registryEntry.requiresExtension
                : currentRecord.requiresExtension,
            permissions: normalizeStringArray(registryEntry.permissions),
            compatibility: {
                versionRange: normalizeString(registryEntry.compatibility?.versionRange),
            },
            availability: {
                status: normalizeString(registryEntry.availability?.status, 'active'),
                reason: normalizeString(registryEntry.availability?.reason),
            },
            homepage: normalizeString(registryEntry.homepage),
        });

        if (!pluginRecordsEqual(currentRecord, candidateRecord)) {
            nextPlugins[pluginId] = normalizePluginRecord({
                ...candidateRecord,
                updatedAt: Date.now(),
            });
            mutated = true;
        }
    });

    if (!mutated) {
        return currentState;
    }

    return writePluginState({
        ...currentState,
        plugins: nextPlugins,
    });
}

export function subscribePluginState(callback) {
    if (typeof callback !== 'function') {
        return () => {};
    }

    if (canUseExtensionSyncStorage()) {
        const handleStorageChange = (changes, areaName) => {
            if (areaName !== 'sync' || !changes?.[PLUGIN_SETTINGS_KEY]) {
                return;
            }

            callback(normalizePluginSettings(changes[PLUGIN_SETTINGS_KEY].newValue));
        };

        chrome.storage.onChanged.addListener(handleStorageChange);
        return () => chrome.storage.onChanged.removeListener(handleStorageChange);
    }

    const storageKey = getLocalStorageKey(PLUGIN_SETTINGS_KEY);
    const handleStorage = (event) => {
        if (event.key !== storageKey) return;

        try {
            callback(normalizePluginSettings(event.newValue ? JSON.parse(event.newValue) : undefined));
        } catch (error) {
            console.error('[Cerebr] Failed to parse plugin settings storage event', error);
        }
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
}

export async function readPluginSettings() {
    return readPluginState();
}

export async function writePluginSettings(nextSettings) {
    return writePluginState(nextSettings);
}

export function subscribePluginSettings(callback) {
    return subscribePluginState(callback);
}
