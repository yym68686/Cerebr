import { normalizeString } from './runtime-utils.js';
import {
    hasPluginCapability,
    normalizePluginCapabilities,
} from './plugin-capabilities.js';

export function isBuiltinPluginEntry(entry = {}) {
    return entry?.manifest?.kind === 'builtin' || normalizeString(entry?.plugin?.id).startsWith('builtin.');
}

export function createPermissionController(entry = {}) {
    const allowed = new Set(normalizePluginCapabilities(entry?.manifest?.permissions));

    return {
        has(permission, aliases = []) {
            if (!permission || isBuiltinPluginEntry(entry)) {
                return true;
            }

            return hasPluginCapability(allowed, permission, aliases);
        },
        assert(permission, aliases = []) {
            if (this.has(permission, aliases)) {
                return true;
            }

            throw new Error(`Plugin "${normalizeString(entry?.plugin?.id)}" requires permission "${permission}"`);
        },
    };
}
