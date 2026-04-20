import { normalizeString } from '../core/runtime-utils.js';

const MSG_STATUS_QUERY = 'PAGE_USER_SCRIPT_PLUGIN_STATUS_QUERY';
const MSG_HOOK_INVOKE = 'PAGE_USER_SCRIPT_PLUGIN_HOOK_REQUEST';
const MSG_HOST_EVENT = 'PAGE_USER_SCRIPT_PLUGIN_HOST_EVENT';
const MSG_HOST_RPC = 'PAGE_USER_SCRIPT_PLUGIN_HOST_RPC';
const READY_RETRY_COUNT = 10;
const READY_RETRY_DELAY_MS = 150;
const TRANSIENT_HOOK_ERRORS = [
    'No active page user script runtime',
    'No active tab available for page user script hook delivery',
    'is not ready in tab',
];

const activeHostsByPluginId = new Map();

function sleep(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function cloneSerializableValue(value, fallback = null) {
    if (typeof value === 'undefined') {
        return fallback;
    }

    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return fallback;
    }
}

function buildAnchoredActionConfig(config = {}, onClick = null) {
    const nextConfig = config && typeof config === 'object'
        ? { ...config }
        : {};
    delete nextConfig.__actionId;
    nextConfig.onClick = typeof onClick === 'function'
        ? onClick
        : (() => {});
    return nextConfig;
}

async function sendBackgroundMessage(type, payload = {}) {
    if (!chrome?.runtime?.sendMessage) {
        throw new Error('Extension runtime messaging is unavailable');
    }

    return chrome.runtime.sendMessage({
        type,
        ...payload,
    });
}

function isTransientHookError(message = '') {
    const normalizedMessage = normalizeString(message);
    if (!normalizedMessage) {
        return true;
    }

    return TRANSIENT_HOOK_ERRORS.some((candidate) => normalizedMessage.includes(candidate));
}

export function createUserScriptPagePluginProxy(descriptor = {}) {
    const manifest = descriptor?.manifest && typeof descriptor.manifest === 'object'
        ? descriptor.manifest
        : {};
    const pluginId = normalizeString(manifest.id);
    let host = null;

    const ensureHost = () => {
        if (!host) {
            host = createUserScriptPagePluginHost({
                descriptor,
            });
        }
        return host;
    };

    return Object.freeze({
        id: pluginId,
        async setup(api) {
            const pagePluginHost = ensureHost();
            await pagePluginHost.start(api);
            return () => pagePluginHost.stop();
        },
        async onBridgeMessage(bridgeMessage, hookContext) {
            const pagePluginHost = ensureHost();
            return pagePluginHost.invokeHook('onBridgeMessage', [
                cloneSerializableValue(bridgeMessage, null),
                {
                    bridgeMessage: cloneSerializableValue(bridgeMessage, null),
                    bridgeSource: cloneSerializableValue(hookContext?.bridgeSource, null),
                },
            ]);
        },
        async onPageSnapshot(snapshot, hookContext) {
            const pagePluginHost = ensureHost();
            return pagePluginHost.invokeHook('onPageSnapshot', [
                cloneSerializableValue(snapshot, null),
                {
                    snapshot: cloneSerializableValue(
                        hookContext?.snapshot ?? snapshot,
                        cloneSerializableValue(snapshot, null)
                    ),
                },
            ]);
        },
    });
}

export async function handleUserScriptPagePluginHostRpc(message = {}) {
    if (normalizeString(message?.type) !== MSG_HOST_RPC) {
        return null;
    }

    const pluginId = normalizeString(message?.pluginId);
    const host = activeHostsByPluginId.get(pluginId);
    if (!host) {
        return {
            success: false,
            error: `No active content host for page user script plugin "${pluginId || 'unknown'}"`,
        };
    }

    return host.handleRpcMessage(message);
}

function createUserScriptPagePluginHost({
    descriptor = {},
} = {}) {
    const manifest = descriptor?.manifest && typeof descriptor.manifest === 'object'
        ? descriptor.manifest
        : {};
    const pluginId = normalizeString(manifest.id);
    const anchoredActionHandles = new Map();
    const extractorHandles = new Map();
    let started = false;
    let resourceCounter = 0;
    let api = {};

    function createResourceId(prefix) {
        resourceCounter += 1;
        return `${prefix}:${resourceCounter}`;
    }

    async function waitForRuntimeStatus() {
        let lastResponse = null;

        for (let attempt = 0; attempt < READY_RETRY_COUNT; attempt += 1) {
            lastResponse = await sendBackgroundMessage(MSG_STATUS_QUERY, {
                pluginId,
            }).catch((error) => ({
                success: false,
                error: error?.message || String(error),
            }));

            if (lastResponse?.success) {
                return lastResponse;
            }

            if (lastResponse?.diagnostic) {
                return lastResponse;
            }

            if (attempt < READY_RETRY_COUNT - 1) {
                await sleep(READY_RETRY_DELAY_MS);
            }
        }

        return lastResponse || {
            success: false,
            error: `Page user script "${pluginId}" is unavailable`,
        };
    }

    async function sendHostEvent(eventName, value = null) {
        const response = await sendBackgroundMessage(MSG_HOST_EVENT, {
            pluginId,
            event: normalizeString(eventName),
            value: cloneSerializableValue(value, value),
        });

        if (response?.success === false) {
            throw new Error(response?.error || `Failed to dispatch host event "${eventName}"`);
        }

        return true;
    }

    async function dispatchRpc(method, args = []) {
        switch (method) {
        case 'page.getMessage':
        case 'i18n.getMessage':
            return api.i18n?.getMessage?.(args[0], args[1], args[2]) ?? '';
        case 'i18n.getLocale':
            return api.i18n?.getLocale?.() ?? '';
        case 'page.listExtractors':
            return api.page?.listExtractors?.() ?? [];
        case 'page.registerExtractor': {
            const definition = args[0] && typeof args[0] === 'object'
                ? args[0]
                : null;
            const handle = definition
                ? api.page?.registerExtractor?.(definition)
                : null;
            if (!handle) {
                return null;
            }

            const handleId = createResourceId('extractor');
            extractorHandles.set(handleId, handle);
            return {
                handleId,
                id: normalizeString(handle.id),
            };
        }
        case 'page.disposeExtractor': {
            const handleId = normalizeString(args[0]);
            const handle = extractorHandles.get(handleId);
            handle?.dispose?.();
            extractorHandles.delete(handleId);
            return true;
        }
        case 'ui.showAnchoredAction': {
            const config = args[0] && typeof args[0] === 'object'
                ? args[0]
                : {};
            const actionId = normalizeString(config.__actionId);
            const handle = api.ui?.showAnchoredAction?.(
                buildAnchoredActionConfig(config, () => {
                    void sendHostEvent('ui.anchoredAction.click', {
                        actionId,
                    }).catch(() => {});
                })
            );
            if (!handle) {
                return null;
            }

            const handleId = createResourceId('anchored-action');
            anchoredActionHandles.set(handleId, handle);
            return {
                handleId,
            };
        }
        case 'ui.updateAnchoredAction': {
            const handleId = normalizeString(args[0]);
            const config = args[1] && typeof args[1] === 'object'
                ? args[1]
                : {};
            const actionId = normalizeString(config.__actionId);
            const handle = anchoredActionHandles.get(handleId);
            handle?.update?.(buildAnchoredActionConfig(config, () => {
                void sendHostEvent('ui.anchoredAction.click', {
                    actionId,
                }).catch(() => {});
            }));
            return true;
        }
        case 'ui.disposeAnchoredAction': {
            const handleId = normalizeString(args[0]);
            const handle = anchoredActionHandles.get(handleId);
            handle?.dispose?.();
            anchoredActionHandles.delete(handleId);
            return true;
        }
        case 'bridge.send':
            return api.bridge?.send?.(
                args[0],
                args[1],
                args[2] && typeof args[2] === 'object' ? args[2] : {}
            ) ?? {
                success: false,
                target: normalizeString(args[0]),
                error: 'Bridge target is unavailable',
            };
        case 'shell.isOpen':
            return api.shell?.isOpen?.() ?? false;
        case 'shell.open':
            return api.shell?.open?.() ?? false;
        case 'shell.toggle':
            return api.shell?.toggle?.() ?? false;
        case 'shell.focusInput':
            return api.shell?.focusInput?.() ?? false;
        case 'shell.setDraft':
            return api.shell?.setDraft?.(args[0]) ?? false;
        case 'shell.insertText':
            return api.shell?.insertText?.(
                args[0],
                args[1] && typeof args[1] === 'object' ? args[1] : {}
            ) ?? false;
        case 'shell.importText':
            return api.shell?.importText?.(
                args[0],
                args[1] && typeof args[1] === 'object' ? args[1] : {}
            ) ?? false;
        default:
            throw new Error(`Unsupported page user script host RPC method: ${method}`);
        }
    }

    const host = {
        async start(nextApi = {}) {
            if (started) {
                return;
            }

            api = nextApi && typeof nextApi === 'object'
                ? nextApi
                : {};
            activeHostsByPluginId.set(pluginId, host);
            started = true;

            try {
                const status = await waitForRuntimeStatus();
                if (!status?.success) {
                    throw new Error(
                        normalizeString(
                            status?.error,
                            `Page user script "${pluginId}" is unavailable`
                        )
                    );
                }
            } catch (error) {
                activeHostsByPluginId.delete(pluginId);
                started = false;
                api = {};
                throw error;
            }
        },
        async stop() {
            if (!started) {
                return;
            }

            started = false;
            activeHostsByPluginId.delete(pluginId);
            anchoredActionHandles.forEach((handle) => handle?.dispose?.());
            anchoredActionHandles.clear();
            extractorHandles.forEach((handle) => handle?.dispose?.());
            extractorHandles.clear();
            api = {};
        },
        async invokeHook(hookName, args = []) {
            const response = await sendBackgroundMessage(MSG_HOOK_INVOKE, {
                pluginId,
                hookName: normalizeString(hookName),
                args: cloneSerializableValue(args, []),
            });

            if (response?.success === false) {
                const errorMessage = normalizeString(response?.error);
                if (isTransientHookError(errorMessage)) {
                    return null;
                }
                throw new Error(errorMessage || `Failed to invoke page user script hook "${hookName}"`);
            }

            return response?.value ?? null;
        },
        async handleRpcMessage(message = {}) {
            try {
                const value = await dispatchRpc(
                    normalizeString(message?.method),
                    Array.isArray(message?.args) ? message.args : []
                );
                return {
                    success: true,
                    value,
                };
            } catch (error) {
                return {
                    success: false,
                    error: error?.message || String(error),
                };
            }
        },
    };

    return host;
}
