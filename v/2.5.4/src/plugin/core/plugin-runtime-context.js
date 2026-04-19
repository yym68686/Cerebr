import { createPermissionController } from './plugin-permissions.js';
import { normalizeString } from './runtime-utils.js';

const RESERVED_CONTEXT_KEYS = new Set([
    'api',
    'capabilities',
    'context',
    'diagnostics',
    'env',
    'meta',
    'permissions',
    'plugin',
    'runtime',
    'services',
]);

function normalizeObject(value) {
    return value && typeof value === 'object'
        ? { ...value }
        : {};
}

function deriveServiceApi(api = {}, context = {}) {
    const normalizedApi = normalizeObject(api);
    if (Object.keys(normalizedApi).length > 0) {
        return normalizedApi;
    }

    const fallbackApi = {};
    Object.entries(normalizeObject(context)).forEach(([key, value]) => {
        if (RESERVED_CONTEXT_KEYS.has(key)) {
            return;
        }
        if (value && (typeof value === 'object' || typeof value === 'function')) {
            fallbackApi[key] = value;
        }
    });

    return fallbackApi;
}

function normalizePluginMeta(entry = {}, baseMeta = {}) {
    const manifest = entry?.manifest && typeof entry.manifest === 'object'
        ? entry.manifest
        : {};

    return {
        ...normalizeObject(baseMeta),
        id: normalizeString(baseMeta?.id, normalizeString(entry?.plugin?.id)),
        displayName: normalizeString(
            baseMeta?.displayName,
            normalizeString(manifest?.displayName, normalizeString(entry?.plugin?.id))
        ),
        version: normalizeString(baseMeta?.version, normalizeString(manifest?.version)),
        kind: normalizeString(baseMeta?.kind, normalizeString(manifest?.kind)),
        scope: normalizeString(baseMeta?.scope, normalizeString(manifest?.scope)),
        sourceType: normalizeString(
            baseMeta?.sourceType,
            normalizeString(entry?.record?.sourceType || entry?.sourceType || entry?.manifest?.sourceType)
        ),
        installMode: normalizeString(
            baseMeta?.installMode,
            normalizeString(entry?.record?.installMode || entry?.installMode || manifest?.installMode)
        ),
    };
}

function normalizeRuntimeMeta(baseRuntime = {}, host = '') {
    const runtime = normalizeObject(baseRuntime);
    const normalizedHost = normalizeString(runtime?.host, normalizeString(host));
    const isExtension = !!runtime?.isExtension;

    return {
        ...runtime,
        host: normalizedHost,
        isExtension,
        isWeb: Object.prototype.hasOwnProperty.call(runtime, 'isWeb')
            ? !!runtime.isWeb
            : !isExtension,
        isServiceWorker: !!runtime?.isServiceWorker,
        isGuest: !!runtime?.isGuest,
    };
}

function normalizeDiagnostics(baseDiagnostics = {}, {
    host = '',
    preflight = null,
    serviceNames = [],
} = {}) {
    return {
        ...normalizeObject(baseDiagnostics),
        host: normalizeString(baseDiagnostics?.host, normalizeString(host)),
        serviceNames: Array.isArray(serviceNames) ? [...serviceNames] : [],
        preflight: preflight && typeof preflight === 'object'
            ? {
                ok: preflight.ok !== false,
                errors: Array.isArray(preflight.errors)
                    ? preflight.errors.map((issue) => ({ ...issue }))
                    : [],
                warnings: Array.isArray(preflight.warnings)
                    ? preflight.warnings.map((issue) => ({ ...issue }))
                    : [],
            }
            : null,
    };
}

export function createPluginRuntimeContext(entry = {}, {
    api = {},
    context = {},
    host = '',
    preflight = null,
    diagnostics = {},
} = {}) {
    const baseContext = normalizeObject(context);
    const pluginMeta = normalizePluginMeta(entry, baseContext?.plugin);
    const runtimeMeta = normalizeRuntimeMeta(baseContext?.runtime, host || entry?.host || pluginMeta.scope);
    const serviceApi = deriveServiceApi(api, baseContext);
    const serviceNames = Object.keys(serviceApi);
    const permissionsController = createPermissionController(entry);
    const permissions = {
        granted: permissionsController.list(),
        has(permission, aliases = []) {
            return permissionsController.has(permission, aliases);
        },
        assert(permission, aliases = []) {
            return permissionsController.assert(permission, aliases);
        },
    };

    delete baseContext.plugin;
    delete baseContext.runtime;

    const contextPayload = {
        ...baseContext,
        plugin: pluginMeta,
        runtime: runtimeMeta,
        permissions,
    };
    const diagnosticsPayload = normalizeDiagnostics(diagnostics, {
        host: runtimeMeta.host,
        preflight,
        serviceNames,
    });
    contextPayload.diagnostics = diagnosticsPayload;

    return {
        ...serviceApi,
        api: serviceApi,
        capabilities: serviceApi,
        services: serviceApi,
        context: contextPayload,
        plugin: pluginMeta,
        meta: pluginMeta,
        runtime: runtimeMeta,
        env: {
            host: runtimeMeta.host,
            isExtension: runtimeMeta.isExtension,
            isWeb: runtimeMeta.isWeb,
            isServiceWorker: runtimeMeta.isServiceWorker,
            isGuest: runtimeMeta.isGuest,
        },
        permissions,
        diagnostics: diagnosticsPayload,
    };
}
