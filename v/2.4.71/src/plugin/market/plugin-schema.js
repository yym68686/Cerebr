const SUPPORTED_PLUGIN_KINDS = new Set(['builtin', 'declarative', 'script']);
const SUPPORTED_PLUGIN_SCOPES = new Set(['page', 'shell', 'prompt']);
const SUPPORTED_DECLARATIVE_TYPES = new Set(['prompt_fragment']);
const SUPPORTED_PROMPT_FRAGMENT_PLACEMENTS = new Set(['system.prepend', 'system.append']);
const SUPPORTED_AVAILABILITY_STATUSES = new Set(['active', 'disabled']);
const SUPPORTED_SCRIPT_SCOPES = new Set(['page', 'shell']);

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

function normalizeAvailability(value) {
    const status = normalizeString(value?.status, 'active');
    return {
        status: SUPPORTED_AVAILABILITY_STATUSES.has(status) ? status : 'active',
        reason: normalizeString(value?.reason),
    };
}

function normalizeCompatibility(value) {
    if (!value || typeof value !== 'object') {
        return {
            versionRange: '',
        };
    }

    return {
        versionRange: normalizeString(value.versionRange),
    };
}

export function validatePluginManifest(manifest, sourceUrl = '') {
    if (!manifest || typeof manifest !== 'object') {
        throw new Error('Invalid plugin manifest payload');
    }

    const schemaVersion = Number(manifest.schemaVersion);
    if (schemaVersion !== 1) {
        throw new Error(`Unsupported plugin manifest schema version: ${manifest.schemaVersion}`);
    }

    const id = normalizeString(manifest.id);
    const version = normalizeString(manifest.version);
    const kind = normalizeString(manifest.kind);
    const scope = normalizeString(manifest.scope);
    const displayName = normalizeString(manifest.displayName);
    const description = normalizeString(manifest.description);

    if (!id) throw new Error('Plugin manifest requires id');
    if (!version) throw new Error(`Plugin "${id}" requires version`);
    if (!SUPPORTED_PLUGIN_KINDS.has(kind)) throw new Error(`Plugin "${id}" has unsupported kind "${kind}"`);
    if (!SUPPORTED_PLUGIN_SCOPES.has(scope)) throw new Error(`Plugin "${id}" has unsupported scope "${scope}"`);
    if (!displayName) throw new Error(`Plugin "${id}" requires displayName`);
    if (!description) throw new Error(`Plugin "${id}" requires description`);

    const normalized = {
        schemaVersion,
        id,
        version,
        kind,
        scope,
        displayName,
        description,
        defaultEnabled: manifest.defaultEnabled !== false,
        requiresExtension: !!manifest.requiresExtension,
        permissions: normalizeStringArray(manifest.permissions),
        compatibility: normalizeCompatibility(manifest.compatibility),
        homepage: normalizeString(manifest.homepage),
        publisher: normalizeString(manifest.publisher),
        declarative: null,
        script: null,
    };

    if (kind === 'declarative') {
        const declarative = manifest.declarative;
        const type = normalizeString(declarative?.type);
        if (!SUPPORTED_DECLARATIVE_TYPES.has(type)) {
            throw new Error(`Plugin "${id}" has unsupported declarative type "${type}"`);
        }

        if (type === 'prompt_fragment') {
            const placement = normalizeString(declarative?.placement, 'system.append');
            const content = normalizeString(declarative?.content);
            if (!SUPPORTED_PROMPT_FRAGMENT_PLACEMENTS.has(placement)) {
                throw new Error(`Plugin "${id}" has unsupported prompt placement "${placement}"`);
            }
            if (!content) {
                throw new Error(`Plugin "${id}" prompt fragment requires content`);
            }

            normalized.declarative = {
                type,
                placement,
                content,
            };
        }
    }

    if (kind === 'script') {
        if (!SUPPORTED_SCRIPT_SCOPES.has(scope)) {
            throw new Error(`Plugin "${id}" script plugins must target "page" or "shell"`);
        }

        const scriptConfig = manifest.script && typeof manifest.script === 'object'
            ? manifest.script
            : {};
        const entry = normalizeString(scriptConfig.entry || scriptConfig.module);
        const exportName = normalizeString(scriptConfig.exportName, 'default');

        if (!entry) {
            throw new Error(`Plugin "${id}" script plugins require script.entry`);
        }

        const resolvedEntry = sourceUrl
            ? new URL(entry, sourceUrl).toString()
            : entry;

        if (sourceUrl) {
            const sourceOrigin = new URL(sourceUrl, window.location.href).origin;
            const entryOrigin = new URL(resolvedEntry, sourceUrl).origin;
            if (sourceOrigin !== entryOrigin) {
                throw new Error(`Plugin "${id}" script.entry must stay on the same origin as plugin.json`);
            }
        }

        normalized.script = {
            entry: resolvedEntry,
            exportName,
        };
    }

    return normalized;
}

function normalizeRegistryPluginEntry(entry, registryId, baseUrl) {
    const id = normalizeString(entry?.id);
    const kind = normalizeString(entry?.kind);
    const scope = normalizeString(entry?.scope);
    const latestVersion = normalizeString(entry?.latestVersion);
    const displayName = normalizeString(entry?.displayName);
    const description = normalizeString(entry?.description);

    if (!id) throw new Error('Registry plugin entry requires id');
    if (!SUPPORTED_PLUGIN_KINDS.has(kind)) throw new Error(`Registry entry "${id}" has unsupported kind "${kind}"`);
    if (!SUPPORTED_PLUGIN_SCOPES.has(scope)) throw new Error(`Registry entry "${id}" has unsupported scope "${scope}"`);
    if (!latestVersion) throw new Error(`Registry entry "${id}" requires latestVersion`);
    if (!displayName) throw new Error(`Registry entry "${id}" requires displayName`);
    if (!description) throw new Error(`Registry entry "${id}" requires description`);

    const install = entry?.install && typeof entry.install === 'object' ? entry.install : {};
    const installMode = normalizeString(install.mode, kind === 'builtin' ? 'builtin' : '');
    const packageUrl = normalizeString(install.packageUrl);

    if (kind === 'declarative' || kind === 'script') {
        if (installMode !== 'package') {
            throw new Error(`Registry entry "${id}" ${kind} plugins must use install.mode "package"`);
        }
        if (!packageUrl) {
            throw new Error(`Registry entry "${id}" ${kind} plugins require install.packageUrl`);
        }
    }

    return {
        id,
        registryId,
        kind,
        scope,
        sourceType: kind === 'builtin' ? 'builtin' : 'registry',
        displayName,
        description,
        latestVersion,
        requiresExtension: !!entry?.requiresExtension,
        permissions: normalizeStringArray(entry.permissions),
        compatibility: normalizeCompatibility(entry.compatibility),
        availability: normalizeAvailability(entry.availability),
        install: {
            mode: installMode,
            packageUrl: packageUrl ? new URL(packageUrl, baseUrl).toString() : '',
        },
        publisher: normalizeString(entry.publisher),
        homepage: normalizeString(entry.homepage),
    };
}

export function validatePluginRegistry(payload, sourceUrl) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid plugin registry payload');
    }

    const schemaVersion = Number(payload.schemaVersion);
    if (schemaVersion !== 1) {
        throw new Error(`Unsupported registry schema version: ${payload.schemaVersion}`);
    }

    const registryId = normalizeString(payload.registryId, 'default');
    const displayName = normalizeString(payload.displayName, registryId);
    const generatedAt = normalizeString(payload.generatedAt);
    const plugins = Array.isArray(payload.plugins) ? payload.plugins : [];
    const baseUrl = sourceUrl || window.location.href;

    return {
        schemaVersion,
        registryId,
        displayName,
        generatedAt,
        plugins: plugins.map((entry) => normalizeRegistryPluginEntry(entry, registryId, baseUrl)),
    };
}
