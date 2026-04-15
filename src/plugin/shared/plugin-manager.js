function toDisposeHandler(cleanup) {
    if (typeof cleanup === 'function') {
        return cleanup;
    }
    if (cleanup && typeof cleanup.dispose === 'function') {
        return cleanup.dispose.bind(cleanup);
    }
    return null;
}

export function createPluginManager({
    plugins = [],
    api,
    logger = console,
} = {}) {
    const registeredPlugins = Array.isArray(plugins) ? [...plugins] : [];
    const activePlugins = new Map();
    let started = false;

    const startPlugin = async (plugin) => {
        if (!plugin || typeof plugin.id !== 'string' || typeof plugin.setup !== 'function') {
            logger?.warn?.('[Cerebr] Ignoring invalid plugin definition:', plugin);
            return false;
        }
        if (activePlugins.has(plugin.id)) {
            return true;
        }

        try {
            const cleanup = await plugin.setup(api);
            activePlugins.set(plugin.id, {
                plugin,
                cleanup: toDisposeHandler(cleanup),
            });
            return true;
        } catch (error) {
            logger?.error?.(`[Cerebr] Failed to start plugin "${plugin.id}"`, error);
            return false;
        }
    };

    const stopPlugin = async (pluginId) => {
        const active = activePlugins.get(pluginId);
        if (!active) return false;

        activePlugins.delete(pluginId);
        try {
            await active.cleanup?.();
        } catch (error) {
            logger?.error?.(`[Cerebr] Failed to stop plugin "${pluginId}"`, error);
        }
        return true;
    };

    const register = async (plugin) => {
        if (!plugin || typeof plugin.id !== 'string') {
            throw new Error('Cannot register plugin without a valid id');
        }

        const existingIndex = registeredPlugins.findIndex((item) => item?.id === plugin.id);
        if (existingIndex !== -1) {
            registeredPlugins.splice(existingIndex, 1, plugin);
            await stopPlugin(plugin.id);
        } else {
            registeredPlugins.push(plugin);
        }

        if (started) {
            await startPlugin(plugin);
        }

        return () => unregister(plugin.id);
    };

    const unregister = async (pluginId) => {
        const index = registeredPlugins.findIndex((plugin) => plugin?.id === pluginId);
        if (index === -1) return false;

        registeredPlugins.splice(index, 1);
        await stopPlugin(pluginId);
        return true;
    };

    const start = async () => {
        if (started) return;
        started = true;
        for (const plugin of registeredPlugins) {
            await startPlugin(plugin);
        }
    };

    const stop = async () => {
        if (!started) return;
        started = false;

        const pluginIds = [...activePlugins.keys()].reverse();
        for (const pluginId of pluginIds) {
            await stopPlugin(pluginId);
        }
    };

    return {
        start,
        stop,
        register,
        unregister,
        getPlugins: () => [...registeredPlugins],
        getActivePluginIds: () => [...activePlugins.keys()],
        isStarted: () => started,
    };
}
