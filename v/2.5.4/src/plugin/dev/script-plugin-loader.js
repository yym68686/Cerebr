import {
    getLocalPluginBundleFiles,
    isLocalPluginBundlePackage,
    resolveLocalPluginBundleSpecifier,
} from './local-plugin-bundle.js';
import { createGuestShellPluginProxy } from '../guest/guest-shell-plugin-host.js';
import { isUserScriptCompatiblePagePlugin } from '../page/page-user-script-support.js';
import { createUserScriptPagePluginProxy } from '../page/user-script-page-plugin-host.js';
import { isExtensionEnvironment } from '../../utils/storage-adapter.js';

function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

const STATIC_IMPORT_PATTERN = /(import\s+(?:[^"'()]*?\s+from\s+)?)(['"])([^'"]+)\2/g;
const EXPORT_FROM_PATTERN = /(export\s+(?:[^"'()]*?\s+from\s+))(['"])([^'"]+)\2/g;
const DYNAMIC_IMPORT_PATTERN = /(import\s*\(\s*)(['"])([^'"]+)\2(\s*(?:,\s*[^)]*)?\))/g;
const bundledPluginUrlStates = new Map();
const MODULE_URL_STRATEGY_BLOB = 'blob';
const MODULE_URL_STRATEGY_DATA = 'data';

function getRuntimeBaseUrl() {
    return globalThis.location?.href || 'https://cerebr.local/';
}

function revokeBundledPluginUrls(state) {
    if (!state?.urlByPath) return;
    state.urlByPath.forEach((url) => {
        try {
            URL.revokeObjectURL(url);
        } catch {
            // ignore
        }
    });
}

function ensureBundledPluginUrlState(pluginId, cacheKey, enabled, moduleUrlStrategy = MODULE_URL_STRATEGY_BLOB) {
    const existing = bundledPluginUrlStates.get(pluginId) || null;
    if (existing && (!enabled || existing.cacheKey !== cacheKey || existing.moduleUrlStrategy !== moduleUrlStrategy)) {
        revokeBundledPluginUrls(existing);
        bundledPluginUrlStates.delete(pluginId);
    }

    if (!enabled) {
        return null;
    }

    const current = bundledPluginUrlStates.get(pluginId);
    if (current) return current;

    const created = {
        cacheKey,
        moduleUrlStrategy,
        pendingByPath: new Map(),
        urlByPath: new Map(),
    };
    bundledPluginUrlStates.set(pluginId, created);
    return created;
}

function isJsonModulePath(modulePath, fileRecord = {}) {
    if (String(fileRecord.type || '').includes('json')) return true;
    return /\.json$/i.test(modulePath);
}

function isJavaScriptModulePath(modulePath, fileRecord = {}) {
    if (isJsonModulePath(modulePath, fileRecord)) return false;
    const mimeType = normalizeString(fileRecord.type).toLowerCase();
    if (mimeType.includes('javascript') || mimeType.includes('ecmascript')) {
        return true;
    }
    if (/\.(?:m?js|jsx|ts|tsx)$/i.test(modulePath)) {
        return true;
    }
    return !/\.[a-z0-9]+$/i.test(modulePath);
}

function getModuleMimeType(modulePath, fileRecord = {}) {
    const declaredType = normalizeString(fileRecord.type);
    if (declaredType) return declaredType;
    if (isJsonModulePath(modulePath, fileRecord)) return 'application/json';
    return 'text/javascript';
}

function createDataModuleSourceUrl(source, mimeType) {
    return `data:${mimeType};charset=utf-8,${encodeURIComponent(source)}`;
}

function createModuleSourceUrl(source, mimeType, strategy = MODULE_URL_STRATEGY_BLOB) {
    if (strategy === MODULE_URL_STRATEGY_DATA) {
        return createDataModuleSourceUrl(source, mimeType);
    }

    if (typeof URL?.createObjectURL === 'function' && typeof Blob !== 'undefined') {
        return URL.createObjectURL(new Blob([source], {
            type: mimeType,
        }));
    }

    return createDataModuleSourceUrl(source, mimeType);
}

function getAlternateModuleUrlStrategy(strategy = '') {
    if (strategy === MODULE_URL_STRATEGY_BLOB) {
        return MODULE_URL_STRATEGY_DATA;
    }
    if (strategy === MODULE_URL_STRATEGY_DATA) {
        return MODULE_URL_STRATEGY_BLOB;
    }
    return '';
}

function shouldRetryBundledModuleImport(error) {
    const message = normalizeString(error?.message || error).toLowerCase();
    if (!message) {
        return false;
    }

    return [
        'an unknown error occurred when fetching the script',
        'failed to fetch dynamically imported module',
        'failed to load module script',
        'failed to fetch',
        'blocked by client',
        'err_blocked_by_client',
        'content security policy',
        'violates the following content security policy directive',
        'refused to load the script',
    ].some((pattern) => message.includes(pattern));
}

function createScriptImportError(pluginId, error, strategy = '') {
    const strategyLabel = normalizeString(strategy);
    const message = normalizeString(error?.message || error, 'Unknown import error');
    return new Error(
        `Failed to import script plugin "${pluginId}"${strategyLabel ? ` via ${strategyLabel} URL` : ''}: ${message}`
    );
}

async function replaceAsync(source, pattern, replacer) {
    const matches = [];
    source.replace(pattern, (...args) => {
        matches.push(args);
        return args[0];
    });

    if (matches.length === 0) {
        return source;
    }

    const replacements = await Promise.all(matches.map((args) => replacer(...args)));
    let replacementIndex = 0;
    return source.replace(pattern, () => replacements[replacementIndex++]);
}

async function resolveBundledImportSpecifier(specifier, fromModulePath, bundleFiles, state) {
    const resolved = resolveLocalPluginBundleSpecifier(specifier, fromModulePath);

    if (resolved.kind === 'bundle') {
        const nextModuleUrl = await createBundledModuleUrl(resolved.path, bundleFiles, state);
        return resolved.suffix ? `${nextModuleUrl}${resolved.suffix}` : nextModuleUrl;
    }

    if (resolved.kind === 'origin' || resolved.kind === 'external') {
        return resolved.url;
    }

    if (resolved.kind === 'bare') {
        throw new Error(`Local bundle plugins cannot import bare specifier "${specifier}"`);
    }

    throw new Error(`Unsupported local plugin import "${specifier}"`);
}

async function rewriteBundledModuleSource(source, modulePath, bundleFiles, state) {
    let rewritten = String(source ?? '');

    rewritten = await replaceAsync(rewritten, STATIC_IMPORT_PATTERN, async (match, prefix, quote, specifier) => {
        const resolvedSpecifier = await resolveBundledImportSpecifier(specifier, modulePath, bundleFiles, state);
        return `${prefix}${JSON.stringify(resolvedSpecifier)}`;
    });

    rewritten = await replaceAsync(rewritten, EXPORT_FROM_PATTERN, async (match, prefix, quote, specifier) => {
        const resolvedSpecifier = await resolveBundledImportSpecifier(specifier, modulePath, bundleFiles, state);
        return `${prefix}${JSON.stringify(resolvedSpecifier)}`;
    });

    rewritten = await replaceAsync(rewritten, DYNAMIC_IMPORT_PATTERN, async (match, prefix, quote, specifier, suffix) => {
        const resolvedSpecifier = await resolveBundledImportSpecifier(specifier, modulePath, bundleFiles, state);
        return `${prefix}${JSON.stringify(resolvedSpecifier)}${suffix}`;
    });

    return rewritten;
}

async function createBundledModuleUrl(modulePath, bundleFiles, state) {
    const normalizedPath = normalizeString(modulePath);
    if (!normalizedPath) {
        throw new Error('Cannot resolve an empty local plugin module path');
    }

    const cachedUrl = state?.urlByPath?.get(normalizedPath);
    if (cachedUrl) {
        return cachedUrl;
    }

    const pendingPromise = state?.pendingByPath?.get(normalizedPath);
    if (pendingPromise) {
        return pendingPromise;
    }

    const promise = (async () => {
        const fileRecord = bundleFiles?.[normalizedPath];
        if (!fileRecord) {
            throw new Error(`Local plugin file "${normalizedPath}" is missing from the installed bundle`);
        }

        const moduleSource = isJavaScriptModulePath(normalizedPath, fileRecord)
            ? await rewriteBundledModuleSource(fileRecord.text, normalizedPath, bundleFiles, state)
            : String(fileRecord.text ?? '');

        const objectUrl = createModuleSourceUrl(
            moduleSource,
            getModuleMimeType(normalizedPath, fileRecord),
            state?.moduleUrlStrategy
        );

        state.urlByPath.set(normalizedPath, objectUrl);
        state.pendingByPath.delete(normalizedPath);
        return objectUrl;
    })().catch((error) => {
        state?.pendingByPath?.delete(normalizedPath);
        throw error;
    });

    state.pendingByPath.set(normalizedPath, promise);
    return promise;
}

export function createScriptPluginCacheKey(descriptor = {}) {
    const manifest = descriptor?.manifest || {};
    const record = descriptor?.record || {};

    return [
        normalizeString(manifest.id),
        normalizeString(manifest.version),
        normalizeString(manifest.script?.entry),
        normalizeString(manifest.script?.exportName, 'default'),
        String(record.updatedAt || record.installedAt || 0),
    ].join('|');
}

function resolveModuleUrlStrategy(descriptor = {}) {
    const requestedStrategy = normalizeString(descriptor?.runtime?.moduleUrlStrategy).toLowerCase();
    if (requestedStrategy === MODULE_URL_STRATEGY_DATA) {
        return MODULE_URL_STRATEGY_DATA;
    }
    if (requestedStrategy === MODULE_URL_STRATEGY_BLOB) {
        return MODULE_URL_STRATEGY_BLOB;
    }

    if (isLocalPluginBundlePackage(descriptor?.manifest)) {
        if (!isExtensionEnvironment) {
            return MODULE_URL_STRATEGY_DATA;
        }
    }

    return globalThis.origin === 'null'
        ? MODULE_URL_STRATEGY_DATA
        : MODULE_URL_STRATEGY_BLOB;
}

async function resolveScriptImportUrl({
    pluginId = '',
    entryUrl = '',
    manifest = {},
    cacheKey = '',
    isBundledSource = false,
    moduleUrlStrategy = MODULE_URL_STRATEGY_BLOB,
} = {}) {
    let importUrl = null;

    if (isBundledSource) {
        const bundledUrlState = ensureBundledPluginUrlState(
            pluginId,
            cacheKey,
            true,
            moduleUrlStrategy
        );
        const bundleFiles = getLocalPluginBundleFiles(manifest);
        const manifestPath = normalizeString(manifest?.source?.bundle?.manifestPath, 'plugin.json');
        const resolvedEntry = resolveLocalPluginBundleSpecifier(entryUrl, manifestPath);

        if (resolvedEntry.kind === 'bundle') {
            const bundledEntryUrl = await createBundledModuleUrl(
                resolvedEntry.path,
                bundleFiles,
                bundledUrlState
            );
            importUrl = new URL(
                resolvedEntry.suffix ? `${bundledEntryUrl}${resolvedEntry.suffix}` : bundledEntryUrl
            );
        } else if (resolvedEntry.kind === 'origin' || resolvedEntry.kind === 'external') {
            importUrl = new URL(resolvedEntry.url, getRuntimeBaseUrl());
        } else {
            throw new Error(`Script plugin "${pluginId}" has an unsupported entry "${entryUrl}"`);
        }
    } else {
        importUrl = new URL(entryUrl, getRuntimeBaseUrl());
    }

    if (importUrl.protocol !== 'data:' && importUrl.protocol !== 'blob:') {
        importUrl.searchParams.set('cerebr_plugin_rev', cacheKey);
    }

    return importUrl;
}

export async function loadScriptPluginModule(descriptor = {}) {
    const manifest = descriptor?.manifest || {};
    const record = descriptor?.record || {};
    const pluginId = normalizeString(manifest.id);
    const entryUrl = normalizeString(manifest.script?.entry);
    const exportName = normalizeString(manifest.script?.exportName, 'default');
    const cacheKey = createScriptPluginCacheKey(descriptor);
    const isBundledSource = isLocalPluginBundlePackage(manifest);
    const sourceMode = normalizeString(manifest?.source?.mode, isBundledSource ? 'bundle' : 'url');
    const moduleUrlStrategy = resolveModuleUrlStrategy(descriptor);
    const disableGuestProxy = descriptor?.runtime?.disableGuestProxy === true;
    const shouldUseGuestShellRuntime = isExtensionEnvironment
        && !disableGuestProxy
        && normalizeString(manifest.scope) === 'shell'
        && (
            sourceMode === 'guest'
            || (isBundledSource && normalizeString(record?.sourceType) === 'developer')
        );
    const shouldUseUserScriptPageRuntime = isExtensionEnvironment
        && !disableGuestProxy
        && isBundledSource
        && normalizeString(manifest.scope) === 'page'
        && (
            sourceMode === 'user-script'
            || isUserScriptCompatiblePagePlugin(manifest)
        );

    if (!pluginId) {
        throw new Error('Cannot load a script plugin without manifest.id');
    }
    if (!entryUrl) {
        throw new Error(`Script plugin "${pluginId}" is missing script.entry`);
    }

    if (shouldUseGuestShellRuntime) {
        return createGuestShellPluginProxy(descriptor);
    }
    if (shouldUseUserScriptPageRuntime) {
        return createUserScriptPagePluginProxy(descriptor);
    }

    let moduleNamespace = null;
    let importStrategy = moduleUrlStrategy;

    try {
        const importUrl = await resolveScriptImportUrl({
            pluginId,
            entryUrl,
            manifest,
            cacheKey,
            isBundledSource,
            moduleUrlStrategy: importStrategy,
        });
        moduleNamespace = await import(importUrl.toString());
    } catch (error) {
        const alternateStrategy = getAlternateModuleUrlStrategy(importStrategy);
        if (
            isBundledSource
            && alternateStrategy
            && shouldRetryBundledModuleImport(error)
        ) {
            console.warn(
                `[Cerebr] Retrying bundled script plugin "${pluginId}" with ${alternateStrategy} module URLs`,
                error
            );
            try {
                importStrategy = alternateStrategy;
                const importUrl = await resolveScriptImportUrl({
                    pluginId,
                    entryUrl,
                    manifest,
                    cacheKey,
                    isBundledSource,
                    moduleUrlStrategy: importStrategy,
                });
                moduleNamespace = await import(importUrl.toString());
            } catch (retryError) {
                throw createScriptImportError(pluginId, retryError, importStrategy);
            }
        } else {
            throw createScriptImportError(pluginId, error, importStrategy);
        }
    }

    let plugin = null;

    if (exportName === 'default') {
        plugin = moduleNamespace.default || null;
    } else {
        plugin = moduleNamespace?.[exportName] || null;
    }

    if (!plugin && moduleNamespace?.plugin) {
        plugin = moduleNamespace.plugin;
    }

    if (!plugin || typeof plugin.id !== 'string' || typeof plugin.setup !== 'function') {
        throw new Error(`Script plugin "${pluginId}" did not export a valid plugin object`);
    }
    if (plugin.id !== pluginId) {
        throw new Error(`Script plugin id mismatch: expected "${pluginId}", received "${plugin.id}"`);
    }

    return plugin;
}
