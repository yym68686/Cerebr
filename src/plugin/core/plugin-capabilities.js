import { normalizeString, normalizeStringArray } from './runtime-utils.js';

const LEGACY_CAPABILITY_ALIASES = Object.freeze({
    'prompt:write': ['prompt:extend'],
    'tabs:active': ['tabs:read'],
    'storage:local': ['storage:read', 'storage:write'],
});

const CAPABILITY_GRAPH = (() => {
    const graph = new Map();

    const connect = (left, right) => {
        if (!left || !right) return;

        if (!graph.has(left)) {
            graph.set(left, new Set());
        }
        if (!graph.has(right)) {
            graph.set(right, new Set());
        }

        graph.get(left).add(right);
        graph.get(right).add(left);
    };

    Object.entries(LEGACY_CAPABILITY_ALIASES).forEach(([legacyCapability, canonicalCapabilities]) => {
        normalizeStringArray(canonicalCapabilities).forEach((canonicalCapability) => {
            connect(normalizeString(legacyCapability), canonicalCapability);
        });
    });

    return graph;
})();

function normalizeCapabilityNamespace(capability = '') {
    const normalized = normalizeString(capability);
    if (!normalized || normalized === '*') {
        return '';
    }

    const separatorIndex = normalized.indexOf(':');
    if (separatorIndex <= 0) {
        return '';
    }

    return normalized.slice(0, separatorIndex);
}

function getNamespaceWildcard(capability = '') {
    const namespace = normalizeCapabilityNamespace(capability);
    return namespace ? `${namespace}:*` : '';
}

function expandCapabilityEquivalents(capability = '') {
    const normalizedCapability = normalizeString(capability);
    if (!normalizedCapability) {
        return [];
    }

    const visited = new Set();
    const queue = [normalizedCapability];

    while (queue.length > 0) {
        const currentCapability = queue.shift();
        if (!currentCapability || visited.has(currentCapability)) {
            continue;
        }

        visited.add(currentCapability);
        const linkedCapabilities = CAPABILITY_GRAPH.get(currentCapability);
        linkedCapabilities?.forEach((linkedCapability) => {
            if (!visited.has(linkedCapability)) {
                queue.push(linkedCapability);
            }
        });
    }

    return [...visited];
}

export function normalizePluginCapabilities(permissions = []) {
    const normalizedCapabilities = [];
    const seenCapabilities = new Set();

    normalizeStringArray(permissions).forEach((permission) => {
        const linkedCapabilities = LEGACY_CAPABILITY_ALIASES[permission];
        const capabilities = linkedCapabilities?.length
            ? normalizeStringArray(linkedCapabilities)
            : [permission];

        capabilities.forEach((capability) => {
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
    const allowedCapabilities = allowedCapabilitiesInput instanceof Set
        ? allowedCapabilitiesInput
        : new Set(normalizePluginCapabilities(allowedCapabilitiesInput));

    if (allowedCapabilities.has('*')) {
        return true;
    }

    const requestedCapabilities = new Set();
    [capability, ...normalizeStringArray(aliases)].forEach((candidateCapability) => {
        expandCapabilityEquivalents(candidateCapability).forEach((equivalentCapability) => {
            requestedCapabilities.add(equivalentCapability);
        });
    });

    return [...requestedCapabilities].some((requestedCapability) => {
        if (allowedCapabilities.has(requestedCapability)) {
            return true;
        }

        const namespaceWildcard = getNamespaceWildcard(requestedCapability);
        return !!namespaceWildcard && allowedCapabilities.has(namespaceWildcard);
    });
}

export function resolvePluginCapabilityVariants(capability = '') {
    return expandCapabilityEquivalents(capability);
}
