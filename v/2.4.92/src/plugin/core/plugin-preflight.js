import { isExtensionEnvironment } from '../../utils/storage-adapter.js';
import { normalizeString } from './runtime-utils.js';

function normalizeIssue(issue = {}) {
    return {
        code: normalizeString(issue?.code),
        message: normalizeString(issue?.message),
    };
}

function createIssue(code, message) {
    return normalizeIssue({ code, message });
}

function isBundledPluginPackage(manifest = {}) {
    return !!(
        manifest?.source?.bundle
        && typeof manifest.source.bundle === 'object'
        && manifest.source.bundle.files
        && typeof manifest.source.bundle.files === 'object'
    );
}

export function runPluginPreflight(entry = {}, {
    host = '',
    api = {},
    moduleUrlStrategy = '',
    requireSetup = true,
} = {}) {
    const pluginId = normalizeString(entry?.plugin?.id);
    const manifest = entry?.manifest && typeof entry.manifest === 'object'
        ? entry.manifest
        : {};
    const normalizedHost = normalizeString(host, normalizeString(entry?.host, normalizeString(manifest?.scope)));
    const errors = [];
    const warnings = [];
    const apiKeys = Object.keys(api && typeof api === 'object' ? api : {});
    const manifestScope = normalizeString(manifest?.scope);
    const manifestKind = normalizeString(manifest?.kind);

    if (!pluginId) {
        errors.push(createIssue('missing-plugin-id', 'Plugin entry is missing plugin.id'));
    }

    if (requireSetup && typeof entry?.plugin?.setup !== 'function') {
        errors.push(createIssue('missing-setup', `Plugin "${pluginId || 'unknown'}" does not export a valid setup() function`));
    }

    if ((manifestKind === 'script' || manifestKind === 'builtin') && manifestScope && normalizedHost && manifestScope !== normalizedHost) {
        errors.push(createIssue(
            'host-scope-mismatch',
            `Plugin "${pluginId || 'unknown'}" targets scope "${manifestScope}" but is loading in host "${normalizedHost}"`
        ));
    }

    if (manifestKind === 'script' && !normalizeString(manifest?.script?.entry)) {
        errors.push(createIssue('missing-script-entry', `Script plugin "${pluginId || 'unknown'}" is missing script.entry`));
    }

    if (manifest?.requiresExtension && !isExtensionEnvironment) {
        errors.push(createIssue(
            'extension-required',
            `Plugin "${pluginId || 'unknown'}" requires the extension runtime but is loading in the web host`
        ));
    }

    if (apiKeys.length === 0) {
        errors.push(createIssue(
            'empty-service-api',
            `Plugin "${pluginId || 'unknown'}" resolved an empty host API for "${normalizedHost || manifestScope || 'unknown'}"`
        ));
    }

    if (isBundledPluginPackage(manifest) && !isExtensionEnvironment && normalizeString(moduleUrlStrategy).toLowerCase() === 'blob') {
        warnings.push(createIssue(
            'unstable-web-bundle-url',
            `Plugin "${pluginId || 'unknown'}" is using blob module URLs in the web host; data URLs are the stable strategy`
        ));
    }

    return {
        ok: errors.length === 0,
        errors,
        warnings,
    };
}

export function formatPluginPreflightIssues(issues = []) {
    return (Array.isArray(issues) ? issues : [])
        .map((issue) => normalizeIssue(issue))
        .filter((issue) => issue.code && issue.message)
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join('; ');
}
