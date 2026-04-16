const DEFAULT_HOOK_TIMEOUT_MS = 1500;

const DEFAULT_HOOK_TIMEOUTS = Object.freeze({
    onBackgroundReady: 900,
    onBeforeSend: 1600,
    onBuildPrompt: 900,
    onRequest: 900,
    onResponseError: 900,
    onAfterResponse: 900,
    onBridgeMessage: 320,
    onActionClicked: 320,
    onCommand: 320,
    onInstalled: 900,
    onTabActivated: 320,
    onTabRemoved: 320,
    onTabUpdated: 320,
    onStreamChunk: 220,
    onInputChanged: 220,
    onPageSnapshot: 320,
    default: DEFAULT_HOOK_TIMEOUT_MS,
});

function normalizeNumber(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0
        ? numeric
        : fallback;
}

function resolveHookTimeout(entry, hookName, overrideTimeoutMs = null) {
    if (overrideTimeoutMs !== null) {
        return normalizeNumber(overrideTimeoutMs, DEFAULT_HOOK_TIMEOUT_MS);
    }

    const pluginTimeouts = entry?.plugin?.hookTimeouts && typeof entry.plugin.hookTimeouts === 'object'
        ? entry.plugin.hookTimeouts
        : {};
    if (Object.prototype.hasOwnProperty.call(pluginTimeouts, hookName)) {
        return normalizeNumber(pluginTimeouts[hookName], DEFAULT_HOOK_TIMEOUTS.default);
    }

    return normalizeNumber(
        DEFAULT_HOOK_TIMEOUTS[hookName],
        DEFAULT_HOOK_TIMEOUTS.default
    );
}

function resolveHookArgs(entry, args) {
    if (typeof args === 'function') {
        const resolved = args(entry);
        return Array.isArray(resolved) ? resolved : [];
    }

    return Array.isArray(args) ? args : [];
}

function withTimeout(promise, timeoutMs, label) {
    if (!timeoutMs) {
        return Promise.resolve(promise);
    }

    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error(`Timed out after ${timeoutMs}ms while running ${label}`));
        }, timeoutMs);

        Promise.resolve(promise)
            .then((value) => {
                clearTimeout(timeoutId);
                resolve(value);
            })
            .catch((error) => {
                clearTimeout(timeoutId);
                reject(error);
            });
    });
}

async function callPluginHook(entry, hookName, args, { logger, timeoutMs = null } = {}) {
    const plugin = entry?.plugin || null;
    const hook = plugin?.[hookName];

    if (typeof hook !== 'function') {
        return {
            called: false,
            value: undefined,
        };
    }

    const pluginId = plugin?.id || 'unknown-plugin';
    const effectiveTimeout = resolveHookTimeout(entry, hookName, timeoutMs);

    try {
        const value = await withTimeout(
            Promise.resolve().then(() => hook(...args)),
            effectiveTimeout,
            `${pluginId}.${hookName}`
        );
        return {
            called: true,
            value,
        };
    } catch (error) {
        logger?.error?.(`[Cerebr] Plugin hook "${pluginId}.${hookName}" failed`, error);
        return {
            called: true,
            value: undefined,
            error,
        };
    }
}

function flattenHookValue(pluginId, value) {
    if (typeof value === 'undefined') return [];
    if (Array.isArray(value)) {
        return value
            .filter((item) => typeof item !== 'undefined')
            .map((item) => ({
                pluginId,
                value: item,
            }));
    }

    return [{
        pluginId,
        value,
    }];
}

export function createHookRunner({
    getActiveEntries,
    logger = console,
} = {}) {
    const resolveEntries = () => {
        const entries = typeof getActiveEntries === 'function'
            ? getActiveEntries()
            : [];
        return Array.isArray(entries) ? entries : [];
    };

    const invokeHook = async (hookName, args = [], options = {}) => {
        const entries = resolveEntries();
        const results = await Promise.all(
            entries.map(async (entry) => {
                const result = await callPluginHook(entry, hookName, resolveHookArgs(entry, args), {
                    logger,
                    timeoutMs: options.timeoutMs ?? null,
                });
                if (!result.called || typeof result.value === 'undefined') {
                    return null;
                }

                return {
                    pluginId: entry?.plugin?.id || '',
                    value: result.value,
                };
            })
        );

        return results.filter(Boolean);
    };

    const runWaterfallHook = async (hookName, initialValue, args = [], options = {}) => {
        let currentValue = initialValue;
        const results = [];

        for (const entry of resolveEntries()) {
            const result = await callPluginHook(
                entry,
                hookName,
                [currentValue, ...resolveHookArgs(entry, args)],
                {
                    logger,
                    timeoutMs: options.timeoutMs ?? null,
                }
            );
            if (!result.called) continue;

            const pluginId = entry?.plugin?.id || '';
            results.push({
                pluginId,
                value: result.value,
            });

            if (typeof result.value !== 'undefined') {
                currentValue = result.value;
            }
        }

        return {
            value: currentValue,
            results,
        };
    };

    const collectHookResults = async (hookName, args = [], options = {}) => {
        const entries = resolveEntries();
        const collected = await Promise.all(
            entries.map(async (entry) => {
                const result = await callPluginHook(entry, hookName, resolveHookArgs(entry, args), {
                    logger,
                    timeoutMs: options.timeoutMs ?? null,
                });
                if (!result.called) {
                    return [];
                }

                const pluginId = entry?.plugin?.id || '';
                return flattenHookValue(pluginId, result.value);
            })
        );

        return collected.flat();
    };

    return {
        invokeHook,
        runWaterfallHook,
        collectHookResults,
    };
}
