import { normalizeString } from '../core/runtime-utils.js';

const SUPPORTED_PAGE_PERMISSIONS = new Set([
    'page:selection:read',
    'page:selection:clear',
    'page:snapshot',
    'page:observe:selectors',
    'page:extractors',
    'page:query',
    'shell:input:write',
    'site:query',
    'site:fill',
    'site:click',
    'site:observe',
    'ui:anchored-action',
]);

const SUPPORTED_ACTIVATION_EVENTS = new Set([
    'page.ready',
    'hook:onBridgeMessage',
    'hook:onPageSnapshot',
]);

function normalizeStringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.map((item) => normalizeString(item)).filter(Boolean);
}

function createIssue(code, message) {
    return {
        code: normalizeString(code),
        message: normalizeString(message),
    };
}

export function getPageUserScriptCompatibilityIssues(manifest = {}) {
    const issues = [];
    const pluginId = normalizeString(manifest?.id, 'unknown');

    if (normalizeString(manifest?.scope) !== 'page') {
        issues.push(createIssue(
            'userscripts-host-scope-mismatch',
            `Plugin "${pluginId}" must target scope "page" to use the user script runtime`
        ));
        return issues;
    }

    const activationEvents = normalizeStringArray(manifest?.activationEvents);
    activationEvents.forEach((eventName) => {
        if (!SUPPORTED_ACTIVATION_EVENTS.has(eventName)) {
            issues.push(createIssue(
                'userscripts-activation-unsupported',
                `Plugin "${pluginId}" uses unsupported activation event "${eventName}" for the user script runtime`
            ));
        }
    });

    const permissions = normalizeStringArray(manifest?.permissions);
    permissions.forEach((permission) => {
        if (SUPPORTED_PAGE_PERMISSIONS.has(permission)) {
            return;
        }
        if (permission.startsWith('bridge:send:')) {
            return;
        }

        issues.push(createIssue(
            'userscripts-capability-unsupported',
            `Plugin "${pluginId}" requires unsupported permission "${permission}" for the user script runtime`
        ));
    });

    return issues;
}

export function isUserScriptCompatiblePagePlugin(manifest = {}) {
    return getPageUserScriptCompatibilityIssues(manifest).length === 0;
}

