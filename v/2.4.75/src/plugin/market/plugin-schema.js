const SUPPORTED_PLUGIN_KINDS = new Set(['builtin', 'declarative', 'script']);
const SUPPORTED_PLUGIN_SCOPES = new Set(['page', 'shell', 'prompt', 'background']);
const SUPPORTED_DECLARATIVE_TYPES = new Set([
    'prompt_fragment',
    'request_policy',
    'page_extractor',
]);
const SUPPORTED_PROMPT_FRAGMENT_PLACEMENTS = new Set(['system.prepend', 'system.append']);
const SUPPORTED_PAGE_EXTRACTOR_STRATEGIES = new Set(['replace', 'prepend', 'append']);
const SUPPORTED_AVAILABILITY_STATUSES = new Set(['active', 'disabled']);
const SUPPORTED_SCRIPT_SCOPES = new Set(['page', 'shell', 'background']);

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

function getDefaultBaseUrl() {
    return globalThis.location?.href || 'https://cerebr.local/';
}

function normalizePromptFragments(value) {
    const fragments = Array.isArray(value) ? value : [value];

    return fragments
        .map((fragment) => {
            if (typeof fragment === 'string') {
                const content = normalizeString(fragment);
                if (!content) return null;

                return {
                    content,
                    placement: 'system.append',
                    priority: 0,
                };
            }

            if (!fragment || typeof fragment !== 'object') {
                return null;
            }

            const content = normalizeString(fragment.content);
            if (!content) {
                return null;
            }

            const placement = normalizeString(fragment.placement, 'system.append');
            return {
                content,
                placement: SUPPORTED_PROMPT_FRAGMENT_PLACEMENTS.has(placement)
                    ? placement
                    : 'system.append',
                priority: Number.isFinite(Number(fragment.priority))
                    ? Number(fragment.priority)
                    : 0,
            };
        })
        .filter(Boolean);
}

function normalizeRequestPolicy(declarative, id) {
    const promptFragments = normalizePromptFragments(declarative.promptFragments);
    const requestPatch = declarative.requestPatch && typeof declarative.requestPatch === 'object'
        ? declarative.requestPatch
        : {};
    const retry = declarative.retry && typeof declarative.retry === 'object'
        ? declarative.retry
        : {};
    const cancel = declarative.cancel && typeof declarative.cancel === 'object'
        ? declarative.cancel
        : {};

    const normalized = {
        type: 'request_policy',
        applyTo: {
            modes: normalizeStringArray(declarative.applyTo?.modes),
            modelIncludes: normalizeStringArray(declarative.applyTo?.modelIncludes),
            urlIncludes: normalizeStringArray(declarative.applyTo?.urlIncludes),
        },
        promptFragments,
        requestPatch: {
            url: normalizeString(requestPatch.url),
            headers: requestPatch.headers && typeof requestPatch.headers === 'object'
                ? Object.fromEntries(
                    Object.entries(requestPatch.headers)
                        .map(([key, value]) => [normalizeString(key), String(value ?? '')])
                        .filter(([key]) => !!key)
                )
                : {},
            body: requestPatch.body && typeof requestPatch.body === 'object'
                ? { ...requestPatch.body }
                : {},
        },
        retry: {
            onErrorCodes: normalizeStringArray(retry.onErrorCodes),
            maxAttempts: Number.isFinite(Number(retry.maxAttempts)) && Number(retry.maxAttempts) > 0
                ? Math.max(1, Math.floor(Number(retry.maxAttempts)))
                : 20,
            reason: normalizeString(retry.reason),
        },
        cancel: {
            draftMatches: normalizeString(cancel.draftMatches),
            draftIncludes: normalizeStringArray(cancel.draftIncludes),
            reason: normalizeString(cancel.reason),
        },
    };

    const hasPromptFragments = normalized.promptFragments.length > 0;
    const hasRequestPatch = !!(
        normalized.requestPatch.url ||
        Object.keys(normalized.requestPatch.headers).length > 0 ||
        Object.keys(normalized.requestPatch.body).length > 0
    );
    const hasRetry = normalized.retry.onErrorCodes.length > 0;
    const hasCancel = !!(
        normalized.cancel.draftMatches ||
        normalized.cancel.draftIncludes.length > 0
    );

    if (!hasPromptFragments && !hasRequestPatch && !hasRetry && !hasCancel) {
        throw new Error(`Plugin "${id}" request_policy requires at least one rule`);
    }

    return normalized;
}

function normalizePageExtractor(declarative, id) {
    const strategy = normalizeString(declarative.strategy, 'replace');

    return {
        type: 'page_extractor',
        matches: normalizeStringArray(declarative.matches),
        includeSelectors: normalizeStringArray(
            declarative.includeSelectors || declarative.selectors?.include
        ),
        excludeSelectors: normalizeStringArray(
            declarative.excludeSelectors || declarative.selectors?.exclude
        ),
        strategy: SUPPORTED_PAGE_EXTRACTOR_STRATEGIES.has(strategy)
            ? strategy
            : 'replace',
        priority: Number.isFinite(Number(declarative.priority))
            ? Number(declarative.priority)
            : 0,
        maxTextLength: Number.isFinite(Number(declarative.maxTextLength)) && Number(declarative.maxTextLength) > 0
            ? Math.max(1, Math.floor(Number(declarative.maxTextLength)))
            : 20000,
        collapseWhitespace: declarative.collapseWhitespace !== false,
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

    if (scope === 'background' && !normalized.requiresExtension) {
        throw new Error(`Plugin "${id}" background scope requires requiresExtension = true`);
    }

    if (kind === 'declarative') {
        const declarative = manifest.declarative;
        const type = normalizeString(declarative?.type);
        if (!SUPPORTED_DECLARATIVE_TYPES.has(type)) {
            throw new Error(`Plugin "${id}" has unsupported declarative type "${type}"`);
        }

        if (type === 'prompt_fragment') {
            if (scope !== 'prompt' && scope !== 'shell') {
                throw new Error(`Plugin "${id}" prompt fragments must target "prompt" or "shell"`);
            }
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
                priority: Number.isFinite(Number(declarative?.priority))
                    ? Number(declarative.priority)
                    : 0,
            };
        } else if (type === 'request_policy') {
            if (scope !== 'shell') {
                throw new Error(`Plugin "${id}" request_policy must target "shell"`);
            }

            normalized.declarative = normalizeRequestPolicy(declarative, id);
        } else if (type === 'page_extractor') {
            if (scope !== 'page') {
                throw new Error(`Plugin "${id}" page_extractor must target "page"`);
            }

            normalized.declarative = normalizePageExtractor(declarative, id);
        }
    }

    if (kind === 'script') {
        if (!SUPPORTED_SCRIPT_SCOPES.has(scope)) {
            throw new Error(`Plugin "${id}" script plugins must target "page", "shell", or "background"`);
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
            const sourceOrigin = new URL(sourceUrl, getDefaultBaseUrl()).origin;
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

    if (scope === 'background' && !entry?.requiresExtension) {
        throw new Error(`Registry entry "${id}" background scope requires requiresExtension = true`);
    }

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
    const baseUrl = sourceUrl || getDefaultBaseUrl();

    return {
        schemaVersion,
        registryId,
        displayName,
        generatedAt,
        plugins: plugins.map((entry) => normalizeRegistryPluginEntry(entry, registryId, baseUrl)),
    };
}
