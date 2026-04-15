export function definePlugin(plugin) {
    if (!plugin || typeof plugin !== 'object') {
        throw new Error('Plugin definition must be an object');
    }
    if (typeof plugin.id !== 'string' || !plugin.id.trim()) {
        throw new Error('Plugin definition requires a non-empty id');
    }
    if (typeof plugin.setup !== 'function') {
        throw new Error(`Plugin "${plugin.id}" must provide a setup(api) function`);
    }

    return Object.freeze({ ...plugin, id: plugin.id.trim() });
}
