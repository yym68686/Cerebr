import { createHookRunner } from '../core/hook-runner.js';

function toDisposeHandler(cleanup) {
    if (typeof cleanup === 'function') {
        return cleanup;
    }
    if (cleanup && typeof cleanup.dispose === 'function') {
        return cleanup.dispose.bind(cleanup);
    }
    return null;
}

function normalizePluginEntry(input) {
    if (input?.plugin && typeof input.plugin === 'object') {
        return {
            plugin: input.plugin,
            manifest: input.manifest && typeof input.manifest === 'object'
                ? { ...input.manifest }
                : null,
        };
    }

    return {
        plugin: input,
        manifest: null,
    };
}

function getPluginPriority(entry) {
    const priority = Number(entry?.plugin?.priority ?? entry?.manifest?.priority ?? 0);
    return Number.isFinite(priority) ? priority : 0;
}

function sortPluginEntries(entries = []) {
    return [...entries].sort((left, right) => {
        const priorityDelta = getPluginPriority(right) - getPluginPriority(left);
        if (priorityDelta !== 0) {
            return priorityDelta;
        }

        const leftId = String(left?.plugin?.id || '');
        const rightId = String(right?.plugin?.id || '');
        return leftId.localeCompare(rightId);
    });
}

export function createPluginManager({
    plugins = [],
    api,
    createApi,
    logger = console,
    onPluginStarted = null,
    onPluginStopped = null,
} = {}) {
    const registeredPlugins = Array.isArray(plugins)
        ? plugins.map(normalizePluginEntry).filter((entry) => entry?.plugin?.id)
        : [];
    const activePlugins = new Map();
    let started = false;

    const getRegisteredEntries = () => sortPluginEntries(registeredPlugins);
    const getActiveEntries = () => sortPluginEntries(
        [...activePlugins.values()].map((item) => item.entry)
    );
    const hookRunner = createHookRunner({
        getActiveEntries,
        logger,
    });

    const startPlugin = async (entry) => {
        const plugin = entry?.plugin;
        if (!plugin || typeof plugin.id !== 'string' || typeof plugin.setup !== 'function') {
            logger?.warn?.('[Cerebr] Ignoring invalid plugin definition:', plugin);
            return false;
        }
        if (activePlugins.has(plugin.id)) {
            return true;
        }

        try {
            const scopedApi = typeof createApi === 'function'
                ? createApi(entry)
                : api;
            const cleanup = await plugin.setup(scopedApi);
            activePlugins.set(plugin.id, {
                entry,
                cleanup: toDisposeHandler(cleanup),
                api: scopedApi,
            });
            await onPluginStarted?.(entry);
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
        try {
            await onPluginStopped?.(active.entry);
        } catch (error) {
            logger?.error?.(`[Cerebr] Failed to finalize plugin "${pluginId}"`, error);
        }
        return true;
    };

    const register = async (pluginOrEntry) => {
        const entry = normalizePluginEntry(pluginOrEntry);
        const plugin = entry.plugin;
        if (!plugin || typeof plugin.id !== 'string') {
            throw new Error('Cannot register plugin without a valid id');
        }

        const existingIndex = registeredPlugins.findIndex((item) => item?.plugin?.id === plugin.id);
        if (existingIndex !== -1) {
            registeredPlugins.splice(existingIndex, 1, entry);
            await stopPlugin(plugin.id);
        } else {
            registeredPlugins.push(entry);
        }

        if (started) {
            await startPlugin(entry);
        }

        return () => unregister(plugin.id);
    };

    const unregister = async (pluginId) => {
        const index = registeredPlugins.findIndex((entry) => entry?.plugin?.id === pluginId);
        if (index === -1) return false;

        registeredPlugins.splice(index, 1);
        await stopPlugin(pluginId);
        return true;
    };

    const start = async () => {
        if (started) return;
        started = true;
        for (const entry of getRegisteredEntries()) {
            await startPlugin(entry);
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
        invokeHook: hookRunner.invokeHook,
        runWaterfallHook: hookRunner.runWaterfallHook,
        collectHookResults: hookRunner.collectHookResults,
        getPluginEntries: () => getRegisteredEntries().map((entry) => ({
            plugin: entry.plugin,
            manifest: entry.manifest ? { ...entry.manifest } : null,
        })),
        getPlugins: () => getRegisteredEntries().map((entry) => entry.plugin),
        getActivePluginIds: () => [...activePlugins.keys()],
        isStarted: () => started,
    };
}
