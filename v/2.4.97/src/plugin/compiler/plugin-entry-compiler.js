import {
    normalizeString,
    normalizeStringArray,
} from '../core/runtime-utils.js';

const KNOWN_PLUGIN_HOOKS = Object.freeze([
    'onBackgroundReady',
    'onBeforeSend',
    'onBuildPrompt',
    'onRequest',
    'onResponse',
    'onRequestError',
    'onResponseError',
    'onAfterResponse',
    'onBridgeMessage',
    'onActionClicked',
    'onCommand',
    'onInstalled',
    'onTabActivated',
    'onTabUpdated',
    'onTabRemoved',
    'onStreamChunk',
    'onInputChanged',
    'onPageSnapshot',
]);

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

function normalizeActivationEvents(value) {
    return normalizeStringArray(value);
}

function inferHookNames(plugin = null) {
    if (!plugin || typeof plugin !== 'object') {
        return [];
    }

    return KNOWN_PLUGIN_HOOKS.filter((hookName) => typeof plugin[hookName] === 'function');
}

function summarizeObjectCounts(value = {}) {
    return Object.fromEntries(
        Object.entries(value)
            .filter(([, entryValue]) => {
                if (Array.isArray(entryValue)) {
                    return entryValue.length > 0;
                }
                return !!entryValue && typeof entryValue === 'object';
            })
            .map(([entryKey, entryValue]) => [
                entryKey,
                Array.isArray(entryValue)
                    ? entryValue.length
                    : 1,
            ])
    );
}

function summarizeContributions({ manifest = null, hookNames = [] } = {}) {
    if (manifest?.contributions && typeof manifest.contributions === 'object') {
        return summarizeObjectCounts(manifest.contributions);
    }

    if (manifest?.declarative?.type) {
        return {
            [normalizeString(manifest.declarative.type)]: 1,
        };
    }

    if (hookNames.length === 0) {
        return {};
    }

    return {
        hooks: hookNames.length,
    };
}

function resolveDefaultActivationEvents({
    manifest = null,
    hookNames = [],
    defaultActivationEvents = [],
} = {}) {
    const normalizedDefaults = normalizeActivationEvents(defaultActivationEvents);
    if (normalizedDefaults.length > 0) {
        return normalizedDefaults;
    }

    if (manifest?.declarative?.type === 'request_policy') {
        const hookActivationEvents = hookNames.map((hookName) => `hook:${hookName}`);
        return hookActivationEvents.length > 0
            ? hookActivationEvents
            : ['app.startup'];
    }

    return ['app.startup'];
}

function resolveActivationEvents({
    plugin = null,
    manifest = null,
    hookNames = [],
    defaultActivationEvents = [],
} = {}) {
    const explicitActivationEvents = normalizeActivationEvents(
        manifest?.activationEvents?.length
            ? manifest.activationEvents
            : plugin?.activationEvents
    );

    if (explicitActivationEvents.length > 0) {
        return explicitActivationEvents;
    }

    return resolveDefaultActivationEvents({
        manifest,
        hookNames,
        defaultActivationEvents,
    });
}

export function matchesActivationEvent(activationEvents = [], eventName = '') {
    const normalizedEventName = normalizeString(eventName);
    if (!normalizedEventName) {
        return false;
    }

    return normalizeActivationEvents(activationEvents).some((candidateEvent) => {
        if (candidateEvent === '*') {
            return true;
        }

        if (candidateEvent === normalizedEventName) {
            return true;
        }

        if (candidateEvent === 'hook:*' && normalizedEventName.startsWith('hook:')) {
            return true;
        }

        if (candidateEvent.endsWith('.*')) {
            const prefix = candidateEvent.slice(0, -1);
            return normalizedEventName.startsWith(prefix);
        }

        return false;
    });
}

export function compilePluginEntry(input, {
    host = '',
    defaultActivationEvents = [],
} = {}) {
    const normalizedEntry = normalizePluginEntry(input);
    const plugin = normalizedEntry.plugin || null;
    const manifest = normalizedEntry.manifest ? { ...normalizedEntry.manifest } : null;
    const hookNames = inferHookNames(plugin);
    const normalizedHost = normalizeString(
        host,
        normalizeString(manifest?.scope)
    );

    return {
        ...normalizedEntry,
        host: normalizedHost,
        priority: getPluginPriority(normalizedEntry),
        hookNames,
        activationEvents: resolveActivationEvents({
            plugin,
            manifest,
            hookNames,
            defaultActivationEvents,
        }),
        contributionSummary: summarizeContributions({
            manifest,
            hookNames,
        }),
    };
}
