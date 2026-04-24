import { normalizeString, normalizeStringArray } from './runtime-utils.js';

const LEGACY_CAPABILITY_ALIASES = Object.freeze({
    'prompt:write': ['prompt:fragments'],
    'tabs:active': ['tabs:query:active'],
    'storage:local': ['storage:read:local', 'storage:write:local'],
});

const CAPABILITY_IMPLICATIONS = Object.freeze({
    'prompt:extend': ['prompt:fragments'],
    'page:selection': ['page:selection:read', 'page:selection:clear'],
    'page:read': ['page:snapshot', 'page:extractors', 'page:query'],
    'page:observe': ['page:observe:selectors'],
    'site:read': ['site:query'],
    'site:write': ['site:fill'],
    'chat:read': ['chat:current', 'chat:messages'],
    'chat:write': ['chat:send', 'chat:abort', 'chat:retry', 'chat:cancel', 'chat:regenerate'],
    'ui:mount': ['ui:slots', 'ui:anchored-action'],
    'tabs:read': ['tabs:query', 'tabs:query:active', 'tabs:get'],
    'tabs:write': ['tabs:reload'],
    'storage:read': ['storage:read:local', 'storage:read:sync'],
    'storage:write': ['storage:write:local', 'storage:write:sync'],
    'bridge:send': ['bridge:send:page', 'bridge:send:shell', 'bridge:send:background'],
    'shell:input': [
        'shell:input:read',
        'shell:input:write',
        'shell:input:mount',
        'shell:input:actions',
        'shell:input:slash-commands',
        'shell:input:modal',
        'shell:input:layout',
    ],
    'shell:menu': ['shell:menu:items'],
    'shell:page': ['shell:page:control'],
});

function normalizeDeclaredCapability(capability = '') {
    const normalizedCapability = normalizeString(capability);
    if (!normalizedCapability) {
        return [];
    }

    const aliases = LEGACY_CAPABILITY_ALIASES[normalizedCapability];
    if (aliases?.length) {
        return normalizeStringArray(aliases);
    }

    return [normalizedCapability];
}

function expandAllowedCapability(capability = '') {
    const normalizedCapability = normalizeString(capability);
    if (!normalizedCapability) {
        return [];
    }

    const visited = new Set();
    const queue = [normalizedCapability];

    while (queue.length > 0) {
        const currentCapability = normalizeString(queue.shift());
        if (!currentCapability || visited.has(currentCapability)) {
            continue;
        }

        visited.add(currentCapability);

        const legacyAliases = LEGACY_CAPABILITY_ALIASES[currentCapability];
        normalizeStringArray(legacyAliases).forEach((nextCapability) => {
            if (!visited.has(nextCapability)) {
                queue.push(nextCapability);
            }
        });

        const impliedCapabilities = CAPABILITY_IMPLICATIONS[currentCapability];
        normalizeStringArray(impliedCapabilities).forEach((nextCapability) => {
            if (!visited.has(nextCapability)) {
                queue.push(nextCapability);
            }
        });
    }

    return [...visited];
}

function expandRequestedCapabilities(capability = '', aliases = []) {
    const visited = new Set();
    const queue = [capability, ...normalizeStringArray(aliases)];

    while (queue.length > 0) {
        const currentCapability = normalizeString(queue.shift());
        if (!currentCapability || visited.has(currentCapability)) {
            continue;
        }

        visited.add(currentCapability);

        const legacyAliases = LEGACY_CAPABILITY_ALIASES[currentCapability];
        normalizeStringArray(legacyAliases).forEach((nextCapability) => {
            if (!visited.has(nextCapability)) {
                queue.push(nextCapability);
            }
        });
    }

    return [...visited];
}

function matchesAllowedCapability(allowedCapability = '', requestedCapability = '') {
    const normalizedAllowed = normalizeString(allowedCapability);
    const normalizedRequested = normalizeString(requestedCapability);

    if (!normalizedAllowed || !normalizedRequested) {
        return false;
    }

    if (normalizedAllowed === '*' || normalizedAllowed === normalizedRequested) {
        return true;
    }

    if (normalizedAllowed.endsWith(':*')) {
        return normalizedRequested.startsWith(normalizedAllowed.slice(0, -1));
    }

    return false;
}

function expandAllowedCapabilitiesInput(allowedCapabilitiesInput = []) {
    const normalizedAllowedCapabilities = allowedCapabilitiesInput instanceof Set
        ? [...allowedCapabilitiesInput]
        : normalizePluginCapabilities(allowedCapabilitiesInput);

    const expandedCapabilities = new Set();
    normalizedAllowedCapabilities.forEach((capability) => {
        expandAllowedCapability(capability).forEach((nextCapability) => {
            expandedCapabilities.add(nextCapability);
        });
    });

    return expandedCapabilities;
}

export function normalizePluginCapabilities(permissions = []) {
    const normalizedCapabilities = [];
    const seenCapabilities = new Set();

    normalizeStringArray(permissions).forEach((permission) => {
        normalizeDeclaredCapability(permission).forEach((capability) => {
            if (seenCapabilities.has(capability)) {
                return;
            }

            seenCapabilities.add(capability);
            normalizedCapabilities.push(capability);
        });
    });

    return normalizedCapabilities;
}

export function hasPluginCapability(allowedCapabilitiesInput = [], capability = '', aliases = []) {
    const allowedCapabilities = expandAllowedCapabilitiesInput(allowedCapabilitiesInput);
    if (allowedCapabilities.has('*')) {
        return true;
    }

    return expandRequestedCapabilities(capability, aliases).some((requestedCapability) => {
        return [...allowedCapabilities].some((allowedCapability) => {
            return matchesAllowedCapability(allowedCapability, requestedCapability);
        });
    });
}

export function resolvePluginCapabilityVariants(capability = '') {
    return expandRequestedCapabilities(capability);
}
