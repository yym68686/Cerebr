import { normalizePluginCapabilities } from '../core/plugin-capabilities.js';

const SUPPORTED_PLUGIN_SCHEMA_VERSIONS = new Set([1, 2]);
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
const SUPPORTED_SHELL_EXECUTION_TYPES = new Set([
    'import_text',
    'insert_text',
    'set_draft',
    'show_toast',
    'open_page',
]);

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

function cloneValue(value, fallback = null) {
    if (value == null) {
        return fallback;
    }

    try {
        if (typeof structuredClone === 'function') {
            return structuredClone(value);
        }
        return JSON.parse(JSON.stringify(value));
    } catch {
        return fallback;
    }
}

function normalizeActivationEvents(value) {
    return normalizeStringArray(value);
}

function normalizeAvailability(value) {
    const status = normalizeString(value?.status, 'active');
    return {
        status: SUPPORTED_AVAILABILITY_STATUSES.has(status) ? status : 'active',
        reason: normalizeString(value?.reason),
        reasonKey: normalizeString(value?.reasonKey),
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
            const contentKey = normalizeString(fragment.contentKey);
            if (!content && !contentKey) {
                return null;
            }

            const placement = normalizeString(fragment.placement, 'system.append');
            return {
                content,
                contentKey,
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

function normalizeRequestPolicy(value, id) {
    const declarative = value && typeof value === 'object'
        ? value
        : {};
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
                        .map(([key, nextValue]) => [normalizeString(key), String(nextValue ?? '')])
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

function normalizePageExtractor(value) {
    const declarative = value && typeof value === 'object'
        ? value
        : {};
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

function normalizeSelectionAction(value, id, index = 0) {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const prompt = normalizeString(value.prompt || value.text || value.promptTemplate);
    const label = normalizeString(value.label);
    if (!prompt || !label) {
        throw new Error(`Plugin "${id}" selectionActions[${index}] requires label and prompt`);
    }

    return {
        id: normalizeString(value.id, `${id}.selection-action.${index + 1}`),
        label,
        title: normalizeString(value.title, label),
        icon: normalizeString(value.icon, 'dot'),
        prompt,
        focus: value.focus !== false,
        separator: normalizeString(value.separator, '\n\n'),
        offsetX: Number.isFinite(Number(value.offsetX)) ? Number(value.offsetX) : 0,
        offsetY: Number.isFinite(Number(value.offsetY)) ? Number(value.offsetY) : 0,
        minLength: Number.isFinite(Number(value.minLength)) && Number(value.minLength) > 0
            ? Math.max(1, Math.floor(Number(value.minLength)))
            : 2,
        maxLength: Number.isFinite(Number(value.maxLength)) && Number(value.maxLength) > 0
            ? Math.max(1, Math.floor(Number(value.maxLength)))
            : 4000,
    };
}

function normalizeShellExecute(value, id, locationLabel) {
    const execute = value && typeof value === 'object'
        ? value
        : {};
    const type = normalizeString(execute.type).toLowerCase();
    if (!SUPPORTED_SHELL_EXECUTION_TYPES.has(type)) {
        throw new Error(`Plugin "${id}" ${locationLabel} has unsupported execute.type "${type}"`);
    }

    if (type === 'import_text' || type === 'insert_text' || type === 'set_draft') {
        const text = normalizeString(execute.text || execute.prompt || execute.template);
        if (!text) {
            throw new Error(`Plugin "${id}" ${locationLabel} execute.type "${type}" requires text`);
        }

        return {
            type,
            text,
            focus: execute.focus !== false,
            separator: normalizeString(execute.separator, '\n\n'),
        };
    }

    if (type === 'show_toast') {
        const message = normalizeString(execute.message || execute.text);
        if (!message) {
            throw new Error(`Plugin "${id}" ${locationLabel} execute.type "show_toast" requires message`);
        }

        return {
            type,
            message,
            toastType: normalizeString(execute.toastType || execute.kind || execute.level, 'info'),
            durationMs: Number.isFinite(Number(execute.durationMs)) && Number(execute.durationMs) > 0
                ? Math.max(1, Math.floor(Number(execute.durationMs)))
                : 2400,
        };
    }

    const page = execute.page && typeof execute.page === 'object'
        ? cloneValue(execute.page, {}) || {}
        : null;
    if (!page) {
        throw new Error(`Plugin "${id}" ${locationLabel} execute.type "open_page" requires page`);
    }

    return {
        type,
        page,
    };
}

function normalizeInputAction(value, id, index = 0) {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const contributionId = normalizeString(value.id, `${id}.input-action.${index + 1}`);
    const label = normalizeString(value.label);
    const icon = normalizeString(value.icon);
    if (!contributionId || (!label && !icon)) {
        throw new Error(`Plugin "${id}" inputActions[${index}] requires id and label/icon`);
    }

    return {
        id: contributionId,
        label,
        icon,
        title: normalizeString(value.title, label || icon || contributionId),
        variant: normalizeString(value.variant, icon && !label ? 'ghost' : 'soft'),
        disabled: !!value.disabled,
        background: normalizeString(value.background),
        color: normalizeString(value.color),
        order: Number.isFinite(Number(value.order)) ? Number(value.order) : index,
        execute: normalizeShellExecute(value.execute, id, `inputActions[${index}]`),
    };
}

function normalizeMenuItem(value, id, index = 0) {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const contributionId = normalizeString(value.id, `${id}.menu-item.${index + 1}`);
    const label = normalizeString(value.label);
    if (!contributionId || !label) {
        throw new Error(`Plugin "${id}" menuItems[${index}] requires id and label`);
    }

    return {
        id: contributionId,
        label,
        icon: normalizeString(value.icon),
        title: normalizeString(value.title, label),
        order: Number.isFinite(Number(value.order)) ? Number(value.order) : index,
        disclosure: value.disclosure !== false,
        disabled: !!value.disabled,
        execute: normalizeShellExecute(value.execute, id, `menuItems[${index}]`),
    };
}

function normalizeSlashCommand(value, id, index = 0) {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const name = normalizeString(value.name);
    const prompt = normalizeString(value.prompt || value.text || value.template);
    if (!name || !prompt) {
        throw new Error(`Plugin "${id}" slashCommands[${index}] requires name and prompt`);
    }

    return {
        id: normalizeString(value.id, `${id}.slash-command.${index + 1}`),
        name,
        label: normalizeString(value.label, name),
        description: normalizeString(value.description),
        aliases: normalizeStringArray(value.aliases),
        prompt,
        separator: Object.prototype.hasOwnProperty.call(value, 'separator')
            ? String(value.separator ?? '')
            : '\n\n',
        disabled: !!value.disabled,
        order: Number.isFinite(Number(value.order)) ? Number(value.order) : index,
    };
}

function normalizeContributions(contributions, { id, scope }) {
    const source = contributions && typeof contributions === 'object'
        ? contributions
        : {};

    const normalized = {
        promptFragments: normalizePromptFragments(source.promptFragments),
        requestPolicies: (Array.isArray(source.requestPolicies) ? source.requestPolicies : [])
            .map((policy) => normalizeRequestPolicy(policy, id)),
        pageExtractors: (Array.isArray(source.pageExtractors) ? source.pageExtractors : [])
            .map((extractor) => normalizePageExtractor(extractor)),
        selectionActions: (Array.isArray(source.selectionActions) ? source.selectionActions : [])
            .map((action, index) => normalizeSelectionAction(action, id, index))
            .filter(Boolean),
        inputActions: (Array.isArray(source.inputActions) ? source.inputActions : [])
            .map((action, index) => normalizeInputAction(action, id, index))
            .filter(Boolean),
        menuItems: (Array.isArray(source.menuItems) ? source.menuItems : [])
            .map((item, index) => normalizeMenuItem(item, id, index))
            .filter(Boolean),
        slashCommands: (Array.isArray(source.slashCommands) ? source.slashCommands : [])
            .map((command, index) => normalizeSlashCommand(command, id, index))
            .filter(Boolean),
    };

    if ((normalized.promptFragments.length > 0 || normalized.requestPolicies.length > 0) && scope !== 'shell' && scope !== 'prompt') {
        throw new Error(`Plugin "${id}" prompt contributions must target "shell" or "prompt"`);
    }
    if ((normalized.inputActions.length > 0 || normalized.menuItems.length > 0 || normalized.slashCommands.length > 0 || normalized.requestPolicies.length > 0) && scope !== 'shell') {
        throw new Error(`Plugin "${id}" shell contributions must target "shell"`);
    }
    if ((normalized.pageExtractors.length > 0 || normalized.selectionActions.length > 0) && scope !== 'page') {
        throw new Error(`Plugin "${id}" page contributions must target "page"`);
    }

    const totalContributionCount = Object.values(normalized)
        .reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
    if (totalContributionCount === 0) {
        throw new Error(`Plugin "${id}" contributions require at least one contribution`);
    }

    return normalized;
}

function normalizeLegacyDeclarative(manifest, normalized) {
    const id = normalized.id;
    const scope = normalized.scope;
    const declarative = manifest.declarative;
    const type = normalizeString(declarative?.type);
    if (!SUPPORTED_DECLARATIVE_TYPES.has(type)) {
        throw new Error(`Plugin "${id}" has unsupported declarative type "${type}"`);
    }

    if (type === 'prompt_fragment') {
        if (scope !== 'prompt' && scope !== 'shell') {
            throw new Error(`Plugin "${id}" prompt fragments must target "prompt" or "shell"`);
        }
        const normalizedFragments = normalizePromptFragments(declarative);
        if (normalizedFragments.length === 0) {
            throw new Error(`Plugin "${id}" prompt fragment requires content or contentKey`);
        }

        normalized.declarative = {
            type,
            ...normalizedFragments[0],
        };
        return;
    }

    if (type === 'request_policy') {
        if (scope !== 'shell') {
            throw new Error(`Plugin "${id}" request_policy must target "shell"`);
        }

        normalized.declarative = normalizeRequestPolicy(declarative, id);
        return;
    }

    if (scope !== 'page') {
        throw new Error(`Plugin "${id}" page_extractor must target "page"`);
    }

    normalized.declarative = normalizePageExtractor(declarative);
}

export function validatePluginManifest(manifest, sourceUrl = '') {
    if (!manifest || typeof manifest !== 'object') {
        throw new Error('Invalid plugin manifest payload');
    }

    const schemaVersion = Number(manifest.schemaVersion);
    if (!SUPPORTED_PLUGIN_SCHEMA_VERSIONS.has(schemaVersion)) {
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
        permissions: normalizePluginCapabilities(manifest.permissions),
        nameKey: normalizeString(manifest.nameKey),
        descriptionKey: normalizeString(manifest.descriptionKey),
        compatibility: normalizeCompatibility(manifest.compatibility),
        homepage: normalizeString(manifest.homepage),
        publisher: normalizeString(manifest.publisher),
        activationEvents: normalizeActivationEvents(manifest.activationEvents),
        contributions: null,
        declarative: null,
        script: null,
    };

    if (scope === 'background' && !normalized.requiresExtension) {
        throw new Error(`Plugin "${id}" background scope requires requiresExtension = true`);
    }

    if (kind === 'declarative') {
        if (manifest.contributions) {
            normalized.contributions = normalizeContributions(manifest.contributions, {
                id,
                scope,
            });
        }

        if (manifest.declarative) {
            normalizeLegacyDeclarative(manifest, normalized);
        }

        if (!normalized.contributions && !normalized.declarative) {
            throw new Error(`Plugin "${id}" declarative plugins require declarative or contributions`);
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
        nameKey: normalizeString(entry?.nameKey),
        descriptionKey: normalizeString(entry?.descriptionKey),
        activationEvents: normalizeActivationEvents(entry?.activationEvents),
        contributionTypes: normalizeStringArray(entry?.contributionTypes),
        permissions: normalizePluginCapabilities(entry.permissions),
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
