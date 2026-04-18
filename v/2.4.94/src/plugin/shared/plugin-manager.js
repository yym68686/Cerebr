import { createHookRunner } from '../core/hook-runner.js';
import { formatPluginPreflightIssues, runPluginPreflight } from '../core/plugin-preflight.js';
import { createPluginRuntimeContext } from '../core/plugin-runtime-context.js';

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
            runtime: input.runtime && typeof input.runtime === 'object'
                ? { ...input.runtime }
                : null,
        };
    }

    return {
        plugin: input,
        manifest: null,
        runtime: null,
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
    createPluginContext,
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
    const resolveRuntimeContext = (entry) => {
        const precomputedPluginContext = entry?.runtime?.pluginContext && typeof entry.runtime.pluginContext === 'object'
            ? entry.runtime.pluginContext
            : null;
        if (precomputedPluginContext) {
            return precomputedPluginContext;
        }

        if (typeof createPluginContext === 'function') {
            return createPluginContext(entry);
        }

        const precomputedPluginApi = entry?.runtime?.pluginApi && typeof entry.runtime.pluginApi === 'object'
            ? entry.runtime.pluginApi
            : null;
        const scopedApi = precomputedPluginApi || (
            typeof createApi === 'function'
                ? createApi(entry)
                : api
        );

        return createPluginRuntimeContext(entry, {
            api: scopedApi,
            context: scopedApi,
            host: entry?.host,
            preflight: entry?.runtime?.preflight || null,
        });
    };

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
            const runtimeContext = resolveRuntimeContext(entry);
            const preflight = entry?.runtime?.preflight || runPluginPreflight(entry, {
                host: entry?.host,
                api: runtimeContext?.api,
                moduleUrlStrategy: entry?.runtime?.moduleUrlStrategy,
            });
            if (Array.isArray(preflight?.warnings) && preflight.warnings.length > 0) {
                logger?.warn?.(
                    `[Cerebr] Plugin preflight warnings for "${plugin.id}": ${formatPluginPreflightIssues(preflight.warnings)}`
                );
            }
            if (preflight?.ok === false) {
                logger?.error?.(
                    `[Cerebr] Plugin preflight failed for "${plugin.id}": ${formatPluginPreflightIssues(preflight.errors)}`
                );
                return false;
            }

            const cleanup = await plugin.setup(runtimeContext);
            activePlugins.set(plugin.id, {
                entry,
                cleanup: toDisposeHandler(cleanup),
                api: runtimeContext?.api || null,
                context: runtimeContext,
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
