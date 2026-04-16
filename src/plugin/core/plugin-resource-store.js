import { normalizeString } from './runtime-utils.js';

export function createPluginResourceStore({
    createState = () => ({}),
    logger = console,
    onCleanup = null,
} = {}) {
    const resources = new Map();

    const ensure = (pluginId) => {
        const normalizedPluginId = normalizeString(pluginId);
        if (!resources.has(normalizedPluginId)) {
            const nextState = createState() || {};
            if (!(nextState.disposers instanceof Set)) {
                nextState.disposers = new Set();
            }
            resources.set(normalizedPluginId, nextState);
        }
        return resources.get(normalizedPluginId);
    };

    const addDisposer = (pluginId, disposer) => {
        if (typeof disposer !== 'function') {
            return () => {};
        }

        const state = ensure(pluginId);
        state.disposers.add(disposer);
        return () => {
            state.disposers.delete(disposer);
        };
    };

    const cleanup = (pluginId) => {
        const normalizedPluginId = normalizeString(pluginId);
        const state = resources.get(normalizedPluginId);

        if (state?.disposers instanceof Set) {
            state.disposers.forEach((dispose) => {
                try {
                    dispose();
                } catch (error) {
                    logger?.error?.(`[Cerebr] Failed to clean up resources for plugin "${normalizedPluginId}"`, error);
                }
            });
            state.disposers.clear();
        }

        try {
            onCleanup?.(normalizedPluginId, state || null);
        } catch (error) {
            logger?.error?.(`[Cerebr] Failed to finalize resource cleanup for plugin "${normalizedPluginId}"`, error);
        }

        resources.delete(normalizedPluginId);
    };

    const cleanupAll = () => {
        for (const pluginId of [...resources.keys()]) {
            cleanup(pluginId);
        }
    };

    return {
        ensure,
        get(pluginId) {
            return resources.get(normalizeString(pluginId)) || null;
        },
        addDisposer,
        cleanup,
        cleanupAll,
        forEach(callback) {
            if (typeof callback !== 'function') return;
            resources.forEach((state, pluginId) => {
                callback(state, pluginId);
            });
        },
    };
}
