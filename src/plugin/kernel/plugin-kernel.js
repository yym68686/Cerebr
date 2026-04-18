import { compilePluginEntry, matchesActivationEvent } from '../compiler/plugin-entry-compiler.js';
import { normalizeString } from '../core/runtime-utils.js';
import { createPluginManager } from '../shared/plugin-manager.js';

function normalizePluginId(pluginId = '') {
    return normalizeString(pluginId);
}

function createStatusSnapshot(entry = {}, currentStatus = null) {
    const pluginId = normalizePluginId(entry?.plugin?.id);
    const preflight = entry?.runtime?.preflight && typeof entry.runtime.preflight === 'object'
        ? {
            ok: entry.runtime.preflight.ok !== false,
            errors: Array.isArray(entry.runtime.preflight.errors)
                ? entry.runtime.preflight.errors.map((issue) => ({ ...issue }))
                : [],
            warnings: Array.isArray(entry.runtime.preflight.warnings)
                ? entry.runtime.preflight.warnings.map((issue) => ({ ...issue }))
                : [],
        }
        : null;

    return {
        id: pluginId,
        host: normalizeString(entry?.host),
        kind: normalizeString(entry?.manifest?.kind),
        scope: normalizeString(entry?.manifest?.scope),
        displayName: normalizeString(
            entry?.manifest?.displayName || entry?.plugin?.displayName,
            pluginId
        ),
        active: !!currentStatus?.active,
        state: normalizeString(currentStatus?.state, 'registered'),
        activationEvents: Array.isArray(entry?.activationEvents)
            ? [...entry.activationEvents]
            : [],
        hookNames: Array.isArray(entry?.hookNames)
            ? [...entry.hookNames]
            : [],
        contributionSummary: entry?.contributionSummary && typeof entry.contributionSummary === 'object'
            ? { ...entry.contributionSummary }
            : {},
        failures: Number.isFinite(Number(currentStatus?.failures))
            ? Number(currentStatus.failures)
            : 0,
        lastActivationEvent: normalizeString(currentStatus?.lastActivationEvent),
        lastActivatedAt: Number.isFinite(Number(currentStatus?.lastActivatedAt))
            ? Number(currentStatus.lastActivatedAt)
            : 0,
        lastStoppedAt: Number.isFinite(Number(currentStatus?.lastStoppedAt))
            ? Number(currentStatus.lastStoppedAt)
            : 0,
        lastError: currentStatus?.lastError
            ? {
                message: normalizeString(currentStatus.lastError.message),
                stack: normalizeString(currentStatus.lastError.stack),
            }
            : null,
        preflight,
    };
}

function toSerializableError(error) {
    if (!error) {
        return null;
    }

    return {
        message: error?.message || String(error),
        stack: error?.stack ? String(error.stack) : '',
    };
}

export function createPluginKernel({
    host = '',
    createApi,
    createPluginContext,
    logger = console,
    onPluginStarted = null,
    onPluginStopped = null,
    compileEntry = compilePluginEntry,
} = {}) {
    const normalizedHost = normalizeString(host);
    const resolvedEntries = new Map();
    const statusById = new Map();
    const stickyEvents = new Set();
    let started = false;

    const pluginManager = createPluginManager({
        plugins: [],
        createApi,
        createPluginContext,
        logger,
        async onPluginStarted(entry) {
            const pluginId = normalizePluginId(entry?.plugin?.id);
            const currentStatus = statusById.get(pluginId) || {};
            statusById.set(pluginId, createStatusSnapshot(entry, {
                ...currentStatus,
                active: true,
                state: 'active',
                lastActivatedAt: Date.now(),
                lastError: null,
            }));
            await onPluginStarted?.(entry);
        },
        async onPluginStopped(entry) {
            const pluginId = normalizePluginId(entry?.plugin?.id);
            const resolvedEntry = resolvedEntries.get(pluginId) || entry;
            const currentStatus = statusById.get(pluginId) || {};
            statusById.set(pluginId, createStatusSnapshot(resolvedEntry, {
                ...currentStatus,
                active: false,
                state: 'registered',
                lastStoppedAt: Date.now(),
            }));
            await onPluginStopped?.(entry);
        },
    });

    const isManaged = (pluginId) => {
        return pluginManager.getPlugins().some((plugin) => normalizePluginId(plugin?.id) === pluginId);
    };

    const isActive = (pluginId) => {
        return pluginManager.getActivePluginIds().includes(pluginId);
    };

    const refreshStatus = (entry, overrides = {}) => {
        const pluginId = normalizePluginId(entry?.plugin?.id);
        const currentStatus = statusById.get(pluginId) || {};
        const nextStatus = createStatusSnapshot(entry, {
            ...currentStatus,
            ...overrides,
        });
        statusById.set(pluginId, nextStatus);
        return nextStatus;
    };

    const activatePlugin = async (pluginId, activationEvent = '') => {
        const resolvedEntry = resolvedEntries.get(pluginId);
        if (!resolvedEntry) {
            return false;
        }

        const currentStatus = statusById.get(pluginId) || {};
        refreshStatus(resolvedEntry, {
            ...currentStatus,
            state: 'activating',
            lastActivationEvent: normalizeString(activationEvent, currentStatus.lastActivationEvent),
        });

        try {
            await pluginManager.register(resolvedEntry);
            if (isActive(pluginId)) {
                refreshStatus(resolvedEntry, {
                    ...statusById.get(pluginId),
                    active: true,
                    state: 'active',
                    lastActivationEvent: normalizeString(activationEvent),
                });
                return true;
            }

            const failureCount = Number(currentStatus.failures || 0) + 1;
            refreshStatus(resolvedEntry, {
                ...currentStatus,
                active: false,
                state: 'error',
                failures: failureCount,
                lastActivationEvent: normalizeString(activationEvent),
                lastError: {
                    message: `Plugin "${pluginId}" failed to activate`,
                    stack: '',
                },
            });
            if (isManaged(pluginId)) {
                await pluginManager.unregister(pluginId);
            }
            return false;
        } catch (error) {
            const failureCount = Number(currentStatus.failures || 0) + 1;
            refreshStatus(resolvedEntry, {
                ...currentStatus,
                active: false,
                state: 'error',
                failures: failureCount,
                lastActivationEvent: normalizeString(activationEvent),
                lastError: toSerializableError(error),
            });
            if (isManaged(pluginId)) {
                await pluginManager.unregister(pluginId);
            }
            logger?.error?.(`[Cerebr] Failed to activate ${normalizedHost || 'plugin'} plugin "${pluginId}"`, error);
            return false;
        }
    };

    const activateMatchingPlugins = async (eventName, { sticky = false } = {}) => {
        const normalizedEventName = normalizeString(eventName);
        if (!normalizedEventName) {
            return [];
        }

        if (sticky) {
            stickyEvents.add(normalizedEventName);
        }

        const matchingPluginIds = [...resolvedEntries.values()]
            .filter((entry) => matchesActivationEvent(entry?.activationEvents, normalizedEventName))
            .map((entry) => normalizePluginId(entry?.plugin?.id));

        const activatedPluginIds = [];
        for (const pluginId of matchingPluginIds) {
            if (isActive(pluginId)) {
                activatedPluginIds.push(pluginId);
                continue;
            }

            const activated = await activatePlugin(pluginId, normalizedEventName);
            if (activated) {
                activatedPluginIds.push(pluginId);
            }
        }

        return activatedPluginIds;
    };

    const ensureHookActivated = async (hookName) => {
        const normalizedHookName = normalizeString(hookName);
        if (!normalizedHookName) {
            return [];
        }

        return activateMatchingPlugins(`hook:${normalizedHookName}`);
    };

    const register = async (pluginOrEntry, options = {}) => {
        const compiledEntry = compileEntry(pluginOrEntry, {
            host: normalizedHost,
            defaultActivationEvents: options.defaultActivationEvents || [],
        });
        const pluginId = normalizePluginId(compiledEntry?.plugin?.id);
        if (!pluginId) {
            throw new Error('Cannot register plugin without a valid id');
        }

        resolvedEntries.set(pluginId, compiledEntry);
        refreshStatus(compiledEntry, {
            active: isActive(pluginId),
            state: isActive(pluginId) ? 'active' : 'registered',
            lastError: null,
        });

        if (started) {
            const shouldActivateImmediately = [...stickyEvents].some((eventName) => {
                return matchesActivationEvent(compiledEntry.activationEvents, eventName);
            });

            if (shouldActivateImmediately) {
                await activatePlugin(pluginId, [...stickyEvents].find((eventName) => {
                    return matchesActivationEvent(compiledEntry.activationEvents, eventName);
                }) || 'app.startup');
            }
        }

        return () => unregister(pluginId);
    };

    const unregister = async (pluginIdInput) => {
        const pluginId = normalizePluginId(pluginIdInput);
        if (!pluginId) {
            return false;
        }

        resolvedEntries.delete(pluginId);
        statusById.delete(pluginId);
        if (isManaged(pluginId)) {
            await pluginManager.unregister(pluginId);
        }
        return true;
    };

    const start = async () => {
        if (started) {
            return;
        }

        started = true;
        await pluginManager.start();
        await activateMatchingPlugins('app.startup', {
            sticky: true,
        });
    };

    const stop = async () => {
        if (!started) {
            return;
        }

        started = false;
        await pluginManager.stop();

        const managedPluginIds = pluginManager.getPlugins()
            .map((plugin) => normalizePluginId(plugin?.id))
            .filter(Boolean);

        for (const pluginId of managedPluginIds) {
            await pluginManager.unregister(pluginId);
        }

        resolvedEntries.forEach((entry) => {
            refreshStatus(entry, {
                ...statusById.get(entry?.plugin?.id),
                active: false,
                state: 'registered',
                lastStoppedAt: Date.now(),
            });
        });
    };

    return {
        register,
        unregister,
        async notifyEvent(eventName, options = {}) {
            return activateMatchingPlugins(eventName, {
                sticky: !!options?.sticky,
            });
        },
        start,
        stop,
        async invokeHook(hookName, args = [], options = {}) {
            await ensureHookActivated(hookName);
            return pluginManager.invokeHook(hookName, args, options);
        },
        async runWaterfallHook(hookName, initialValue, args = [], options = {}) {
            await ensureHookActivated(hookName);
            return pluginManager.runWaterfallHook(hookName, initialValue, args, options);
        },
        async collectHookResults(hookName, args = [], options = {}) {
            await ensureHookActivated(hookName);
            return pluginManager.collectHookResults(hookName, args, options);
        },
        getPluginEntries() {
            return [...resolvedEntries.values()].map((entry) => ({
                plugin: entry.plugin,
                manifest: entry.manifest ? { ...entry.manifest } : null,
                host: entry.host,
                activationEvents: Array.isArray(entry.activationEvents)
                    ? [...entry.activationEvents]
                    : [],
                hookNames: Array.isArray(entry.hookNames)
                    ? [...entry.hookNames]
                    : [],
                contributionSummary: entry.contributionSummary && typeof entry.contributionSummary === 'object'
                    ? { ...entry.contributionSummary }
                    : {},
            }));
        },
        getPlugins() {
            return [...resolvedEntries.values()].map((entry) => entry.plugin);
        },
        getActivePluginIds() {
            return pluginManager.getActivePluginIds();
        },
        getDiagnostics() {
            return [...resolvedEntries.values()]
                .map((entry) => {
                    const pluginId = normalizePluginId(entry?.plugin?.id);
                    return createStatusSnapshot(entry, statusById.get(pluginId));
                })
                .sort((left, right) => left.id.localeCompare(right.id));
        },
        isStarted() {
            return started;
        },
    };
}
