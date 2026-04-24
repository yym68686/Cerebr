import { createPluginBridgeMessage, isPluginBridgeMessage } from '../bridge/plugin-bridge.js';
import { createHostedPluginRuntime } from '../core/hosted-plugin-runtime.js';
import { createPermissionController } from '../core/plugin-permissions.js';
import {
    createPluginHostLocaleStore,
    createPluginRuntimeI18nApi,
} from '../core/plugin-i18n.js';
import { createPluginRuntimeContext } from '../core/plugin-runtime-context.js';
import { normalizeString } from '../core/runtime-utils.js';
import { getBuiltinBackgroundPluginEntries } from './background-plugin-registry.js';
import { isExtensionEnvironment } from '../../utils/storage-adapter.js';
import { createHostServiceRegistry } from '../services/host-service-registry.js';

function createPluginMeta(entry = {}) {
    return {
        id: normalizeString(entry?.plugin?.id),
        manifest: entry?.manifest ? { ...entry.manifest } : null,
    };
}

function normalizeTabId(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
        return null;
    }
    return Math.floor(numeric);
}

function getStorageAreaName(area = 'local') {
    return normalizeString(area) === 'sync' ? 'sync' : 'local';
}

function resolveStorageArea(area = 'local') {
    const areaName = getStorageAreaName(area);
    return chrome?.storage?.[areaName] || null;
}

function toPlainTab(tab) {
    if (!tab || typeof tab !== 'object') {
        return null;
    }

    return {
        id: normalizeTabId(tab.id),
        windowId: Number.isFinite(Number(tab.windowId)) ? Number(tab.windowId) : null,
        groupId: Number.isFinite(Number(tab.groupId)) ? Number(tab.groupId) : null,
        index: Number.isFinite(Number(tab.index)) ? Number(tab.index) : null,
        active: !!tab.active,
        highlighted: !!tab.highlighted,
        pinned: !!tab.pinned,
        audible: !!tab.audible,
        discarded: !!tab.discarded,
        title: normalizeString(tab.title),
        status: normalizeString(tab.status),
        url: normalizeString(tab.url),
    };
}

function toPlainSender(sender) {
    if (!sender || typeof sender !== 'object') {
        return null;
    }

    return {
        id: normalizeString(sender.id),
        origin: normalizeString(sender.origin),
        url: normalizeString(sender.url),
        documentId: normalizeString(sender.documentId),
        documentLifecycle: normalizeString(sender.documentLifecycle),
        frameId: Number.isFinite(Number(sender.frameId)) ? Number(sender.frameId) : null,
        tab: toPlainTab(sender.tab),
    };
}

async function queryTabs(queryInfo = {}) {
    return chrome?.tabs?.query?.(queryInfo && typeof queryInfo === 'object' ? queryInfo : {}) || [];
}

async function getCurrentTab() {
    const tabs = await queryTabs({
        active: true,
        currentWindow: true,
    });
    return tabs[0] || null;
}

async function getTab(tabId) {
    const normalizedTabId = normalizeTabId(tabId);
    if (normalizedTabId === null) {
        return null;
    }

    try {
        return await chrome.tabs.get(normalizedTabId);
    } catch {
        return null;
    }
}

function isActiveTabQuery(queryInfo = {}) {
    return !!(queryInfo && typeof queryInfo === 'object' && queryInfo.active === true && queryInfo.currentWindow === true);
}

export function createBackgroundPluginRuntime({
    pluginEntries = getBuiltinBackgroundPluginEntries(),
} = {}) {
    let readyHookTriggered = false;
    const localeStore = createPluginHostLocaleStore({
        logger: console,
    });

    async function dispatchLocalBridgeMessage(bridgeMessage, source = null) {
        if (!isPluginBridgeMessage(bridgeMessage, 'background')) {
            return [];
        }

        await ensureStarted();
        return runtimeController.pluginManager.invokeHook('onBridgeMessage', (entry) => [
            bridgeMessage,
            createHookContext(entry, {
                bridgeMessage,
                bridgeSource: source,
            }),
        ], {
            timeoutMs: 320,
        });
    }

    async function dispatchTabBridgeMessage(tabId, bridgeMessage) {
        const normalizedTabId = normalizeTabId(tabId);
        if (normalizedTabId === null || !isPluginBridgeMessage(bridgeMessage)) {
            return {
                success: false,
                tabId: normalizedTabId,
                error: 'Invalid bridge target tab',
            };
        }

        try {
            const response = await chrome.tabs.sendMessage(normalizedTabId, {
                type: 'PLUGIN_BRIDGE_RELAY',
                bridge: bridgeMessage,
            });
            return {
                success: true,
                tabId: normalizedTabId,
                response: response || null,
            };
        } catch (error) {
            return {
                success: false,
                tabId: normalizedTabId,
                error: error?.message || String(error),
            };
        }
    }

    async function broadcastBridgeMessage(bridgeMessage, queryInfo = {}) {
        if (!isPluginBridgeMessage(bridgeMessage)) {
            return {
                success: false,
                results: [],
                error: 'Invalid bridge message',
            };
        }

        const tabs = await queryTabs(queryInfo);
        const results = await Promise.all(
            tabs
                .map((tab) => normalizeTabId(tab?.id))
                .filter((tabId) => tabId !== null)
                .map((tabId) => dispatchTabBridgeMessage(tabId, bridgeMessage))
        );

        return {
            success: results.some((result) => result?.success),
            results,
        };
    }

    function assertStoragePermission(permissions, action, area = 'local') {
        const areaName = getStorageAreaName(area);
        permissions.assert(`storage:${action}:${areaName}`, [
            `storage:${action}`,
            ...(areaName === 'local' ? ['storage:local'] : []),
        ]);
    }

    function createBrowserApi(entry = {}) {
        const permissions = createPermissionController(entry);

        return {
            async getCurrentTab() {
                permissions.assert('tabs:query:active', ['tabs:query', 'tabs:read', 'tabs:active']);
                return getCurrentTab();
            },
            async getTab(tabId) {
                permissions.assert('tabs:get', ['tabs:read']);
                return getTab(tabId);
            },
            async queryTabs(queryInfo = {}) {
                const normalizedQueryInfo = queryInfo && typeof queryInfo === 'object'
                    ? { ...queryInfo }
                    : {};
                if (isActiveTabQuery(normalizedQueryInfo)) {
                    permissions.assert('tabs:query:active', ['tabs:query', 'tabs:read', 'tabs:active']);
                } else {
                    permissions.assert('tabs:query', ['tabs:read']);
                }
                return queryTabs(normalizedQueryInfo);
            },
            async reloadTab(tabId, options = {}) {
                permissions.assert('tabs:reload', ['tabs:write']);
                const normalizedTabId = normalizeTabId(tabId);
                if (normalizedTabId === null) {
                    return false;
                }

                await chrome.tabs.reload(normalizedTabId, options && typeof options === 'object' ? options : {});
                return true;
            },
            async sendMessage(tabId, message) {
                permissions.assert('tabs:message');
                const normalizedTabId = normalizeTabId(tabId);
                if (normalizedTabId === null) {
                    return null;
                }

                return chrome.tabs.sendMessage(normalizedTabId, message);
            },
        };
    }

    function createStorageApi(entry = {}) {
        const permissions = createPermissionController(entry);

        return {
            async get(keys, options = {}) {
                assertStoragePermission(permissions, 'read', options?.area);
                const area = resolveStorageArea(options?.area);
                if (!area) return {};
                return area.get(keys);
            },
            async set(items, options = {}) {
                assertStoragePermission(permissions, 'write', options?.area);
                const area = resolveStorageArea(options?.area);
                if (!area || !items || typeof items !== 'object') return false;
                await area.set(items);
                return true;
            },
            async remove(keys, options = {}) {
                assertStoragePermission(permissions, 'write', options?.area);
                const area = resolveStorageArea(options?.area);
                if (!area) return false;
                await area.remove(keys);
                return true;
            },
        };
    }

    function createBridgeApi(entry = {}) {
        const permissions = createPermissionController(entry);
        const sourcePluginId = normalizeString(entry?.plugin?.id);
        const buildBridgeMessage = (target, command, payload = {}) => createPluginBridgeMessage(
            target,
            command,
            payload,
            {
                sourceHost: 'background',
                sourcePluginId,
            }
        );

        return {
            async send(target, command, payload = {}, options = {}) {
                const normalizedTarget = normalizeString(target);
                if (!normalizedTarget) {
                    return {
                        success: false,
                        target: '',
                        error: 'Bridge target is unavailable',
                    };
                }
                permissions.assert(`bridge:send:${normalizedTarget}`, ['bridge:send']);
                const bridgeMessage = buildBridgeMessage(normalizedTarget, command, payload);

                if (normalizedTarget === 'background') {
                    const results = await dispatchLocalBridgeMessage(bridgeMessage, {
                        host: 'background',
                        pluginId: sourcePluginId,
                    });
                    return {
                        success: true,
                        target: normalizedTarget,
                        results,
                    };
                }

                const normalizedTabId = normalizeTabId(options?.tabId);
                if (normalizedTabId !== null) {
                    return dispatchTabBridgeMessage(normalizedTabId, bridgeMessage);
                }

                if (options?.queryInfo && typeof options.queryInfo === 'object' && Object.keys(options.queryInfo).length > 0) {
                    return broadcastBridgeMessage(bridgeMessage, options.queryInfo);
                }

                const activeTab = await getCurrentTab();
                if (!Number.isFinite(Number(activeTab?.id))) {
                    return {
                        success: false,
                        target: normalizedTarget,
                        error: 'No active tab available for bridge delivery',
                    };
                }

                return dispatchTabBridgeMessage(activeTab.id, bridgeMessage);
            },
            async sendToTab(tabId, target, command, payload = {}) {
                const normalizedTarget = normalizeString(target);
                if (!normalizedTarget) {
                    return {
                        success: false,
                        target: '',
                        error: 'Bridge target is unavailable',
                    };
                }
                permissions.assert(`bridge:send:${normalizedTarget}`, ['bridge:send']);
                return dispatchTabBridgeMessage(
                    tabId,
                    buildBridgeMessage(normalizedTarget, command, payload)
                );
            },
            async broadcast(target, command, payload = {}, queryInfo = {}) {
                const normalizedTarget = normalizeString(target);
                if (!normalizedTarget) {
                    return {
                        success: false,
                        target: '',
                        error: 'Bridge target is unavailable',
                    };
                }
                permissions.assert(`bridge:send:${normalizedTarget}`, ['bridge:send']);
                return broadcastBridgeMessage(
                    buildBridgeMessage(normalizedTarget, command, payload),
                    queryInfo
                );
            },
        };
    }

    function createI18nApi(entry = {}) {
        return createPluginRuntimeI18nApi(entry, {
            getLocale() {
                return localeStore.getLocale();
            },
            onLocaleChanged(callback, options = {}) {
                return localeStore.subscribe(callback, options);
            },
            hostGetMessage(key, substitutions = [], fallback = '') {
                try {
                    return chrome?.i18n?.getMessage?.(key, substitutions) || fallback;
                } catch {
                    return fallback;
                }
            },
        });
    }

    const hostServiceRegistry = createHostServiceRegistry({
        browser: {
            createApi: createBrowserApi,
        },
        storage: {
            createApi: createStorageApi,
        },
        i18n: {
            createApi: createI18nApi,
        },
        bridge: {
            createApi: createBridgeApi,
        },
        background: {
            createApi() {
                return {
                    isServiceWorker: true,
                };
            },
        },
    });

    const createPluginApi = (entry = {}) => hostServiceRegistry.createPluginApi(entry);

    const createHookContext = (entry = {}, baseContext = {}) => {
        const { context } = hostServiceRegistry.createHookContext(entry, baseContext);

        return {
            ...context,
            plugin: createPluginMeta(entry),
            runtime: {
                host: 'background',
                isExtension: isExtensionEnvironment,
                isServiceWorker: true,
            },
        };
    };
    const createPluginContext = (entry = {}) => {
        const api = createPluginApi(entry);

        return createPluginRuntimeContext(entry, {
            api,
            context: {
                plugin: createPluginMeta(entry),
                runtime: {
                    host: 'background',
                    isExtension: isExtensionEnvironment,
                    isServiceWorker: true,
                },
            },
            host: 'background',
        });
    };

    const runtimeController = createHostedPluginRuntime({
        host: 'background',
        builtinEntries: pluginEntries,
        declarativeScopes: [],
        createApi: createPluginApi,
        createPluginContext,
        logger: console,
    });

    async function ensureStarted() {
        await start();
    }

    async function triggerReadyHook() {
        if (readyHookTriggered) {
            return;
        }

        readyHookTriggered = true;
        await runtimeController.pluginManager.invokeHook('onBackgroundReady', (entry) => [
            createHookContext(entry),
        ], {
            timeoutMs: 900,
        });
    }

    async function start() {
        await localeStore.start();
        await runtimeController.start();
        await runtimeController.pluginManager.notifyEvent?.('background.ready', {
            sticky: true,
        });
        await triggerReadyHook();
    }

    async function stop() {
        readyHookTriggered = false;
        await runtimeController.stop();
        localeStore.stop();
    }

    return {
        async start() {
            await start();
        },
        async stop() {
            await stop();
        },
        isStarted() {
            return runtimeController.isStarted();
        },
        getDiagnostics() {
            return runtimeController.pluginManager.getDiagnostics?.() || [];
        },
        async handleBridgeMessage(bridgeMessage, sender = null) {
            return dispatchLocalBridgeMessage(bridgeMessage, {
                host: normalizeString(bridgeMessage?.meta?.sourceHost),
                pluginId: normalizeString(bridgeMessage?.meta?.sourcePluginId),
                sender: toPlainSender(sender),
            });
        },
        async handleActionClicked(tab = null) {
            await ensureStarted();
            return runtimeController.pluginManager.invokeHook('onActionClicked', (entry) => [
                tab,
                createHookContext(entry, {
                    tab,
                }),
            ], {
                timeoutMs: 320,
            });
        },
        async handleCommand(command) {
            await ensureStarted();
            return runtimeController.pluginManager.invokeHook('onCommand', (entry) => [
                normalizeString(command),
                createHookContext(entry, {
                    command: normalizeString(command),
                }),
            ], {
                timeoutMs: 320,
            });
        },
        async handleInstalled(details = {}) {
            await ensureStarted();
            return runtimeController.pluginManager.invokeHook('onInstalled', (entry) => [
                details,
                createHookContext(entry, {
                    details,
                }),
            ], {
                timeoutMs: 900,
            });
        },
        async handleTabActivated(activeInfo = {}) {
            await ensureStarted();
            const tab = await getTab(activeInfo?.tabId);
            return runtimeController.pluginManager.invokeHook('onTabActivated', (entry) => [
                {
                    activeInfo,
                    tab,
                },
                createHookContext(entry, {
                    activeInfo,
                    tab,
                }),
            ], {
                timeoutMs: 320,
            });
        },
        async handleTabRemoved(tabId, removeInfo = {}) {
            await ensureStarted();
            return runtimeController.pluginManager.invokeHook('onTabRemoved', (entry) => [
                {
                    tabId: normalizeTabId(tabId),
                    removeInfo,
                },
                createHookContext(entry, {
                    tabId: normalizeTabId(tabId),
                    removeInfo,
                }),
            ], {
                timeoutMs: 320,
            });
        },
        async handleTabUpdated(tabId, changeInfo = {}, tab = null) {
            await ensureStarted();
            return runtimeController.pluginManager.invokeHook('onTabUpdated', (entry) => [
                {
                    tabId: normalizeTabId(tabId),
                    changeInfo,
                    tab,
                },
                createHookContext(entry, {
                    tabId: normalizeTabId(tabId),
                    changeInfo,
                    tab,
                }),
            ], {
                timeoutMs: 320,
            });
        },
    };
}
