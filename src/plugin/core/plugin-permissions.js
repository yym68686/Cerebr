import { normalizeString, normalizeStringArray } from './runtime-utils.js';

export function isBuiltinPluginEntry(entry = {}) {
    return entry?.manifest?.kind === 'builtin' || normalizeString(entry?.plugin?.id).startsWith('builtin.');
}

export function createPermissionController(entry = {}) {
    const allowed = new Set(normalizeStringArray(entry?.manifest?.permissions));

    return {
        has(permission, aliases = []) {
            if (!permission || isBuiltinPluginEntry(entry)) {
                return true;
            }

            if (allowed.has(permission)) {
                return true;
            }

            return normalizeStringArray(aliases).some((alias) => allowed.has(alias));
        },
        assert(permission, aliases = []) {
            if (this.has(permission, aliases)) {
                return true;
            }

            throw new Error(`Plugin "${normalizeString(entry?.plugin?.id)}" requires permission "${permission}"`);
        },
    };
}
