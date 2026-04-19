import { getInstalledScriptPlugins } from '../dev/local-plugin-service.js';
import {
    readDeveloperModePreference,
    subscribeDeveloperModePreference,
} from '../dev/developer-mode.js';
import { subscribePluginSettings } from '../shared/plugin-store.js';
import { normalizeString } from '../core/runtime-utils.js';
import {
    buildPageUserScriptRegistration,
    getPageUserScriptRegistrationId,
} from './page-user-script-compiler.js';
import {
    getPageUserScriptCompatibilityIssues,
    isUserScriptCompatiblePagePlugin,
} from './page-user-script-support.js';

const MSG_READY = 'PAGE_USER_SCRIPT_READY';
const MSG_ERROR = 'PAGE_USER_SCRIPT_ERROR';
const MSG_RPC = 'PAGE_USER_SCRIPT_RPC';
const MSG_RPC_RESPONSE = 'PAGE_USER_SCRIPT_RPC_RESPONSE';
const MSG_EVENT = 'PAGE_USER_SCRIPT_EVENT';
const MSG_HOOK_REQUEST = 'PAGE_USER_SCRIPT_HOOK_REQUEST';
const MSG_HOOK_RESPONSE = 'PAGE_USER_SCRIPT_HOOK_RESPONSE';

const MSG_STATUS_QUERY = 'PAGE_USER_SCRIPT_PLUGIN_STATUS_QUERY';
const MSG_HOOK_INVOKE = 'PAGE_USER_SCRIPT_PLUGIN_HOOK_REQUEST';
const MSG_HOST_EVENT = 'PAGE_USER_SCRIPT_PLUGIN_HOST_EVENT';
const MANAGED_REGISTRATION_PREFIX = getPageUserScriptRegistrationId('');

function normalizeIssue(issue = {}) {
    return {
        code: normalizeString(issue?.code),
        message: normalizeString(issue?.message),
    };
}

function createIssue(code, message) {
    return normalizeIssue({ code, message });
}

function createSerializableError(error) {
    return {
        message: error?.message || String(error),
        stack: error?.stack ? String(error.stack) : '',
    };
}

function createPluginDiagnostic(descriptor = {}, overrides = {}) {
    const manifest = descriptor?.manifest && typeof descriptor.manifest === 'object'
        ? descriptor.manifest
        : {};
    const pluginId = normalizeString(descriptor?.id || manifest?.id);
    const preflightErrors = Array.isArray(overrides?.preflightErrors)
        ? overrides.preflightErrors.map((issue) => normalizeIssue(issue))
        : [];
    const preflightWarnings = Array.isArray(overrides?.preflightWarnings)
        ? overrides.preflightWarnings.map((issue) => normalizeIssue(issue))
        : [];

    return {
        id: pluginId,
        host: 'page',
        kind: normalizeString(manifest?.kind, 'script'),
        scope: normalizeString(manifest?.scope, 'page'),
        displayName: normalizeString(manifest?.displayName, pluginId),
        active: overrides?.state === 'active',
        state: normalizeString(overrides?.state, 'registered'),
        activationEvents: Array.isArray(manifest?.activationEvents)
            ? [...manifest.activationEvents]
            : [],
        hookNames: Array.isArray(overrides?.hookNames)
            ? [...overrides.hookNames]
            : [],
        contributionSummary: {
            executionSurface: 1,
        },
        failures: Number.isFinite(Number(overrides?.failures))
            ? Number(overrides.failures)
            : 0,
        lastActivationEvent: normalizeString(overrides?.lastActivationEvent),
        lastActivatedAt: Number.isFinite(Number(overrides?.lastActivatedAt))
            ? Number(overrides.lastActivatedAt)
            : 0,
        lastStoppedAt: Number.isFinite(Number(overrides?.lastStoppedAt))
            ? Number(overrides.lastStoppedAt)
            : 0,
        lastError: overrides?.lastError
            ? createSerializableError(overrides.lastError)
            : null,
        executionSurface: 'user_script',
        preflight: {
            ok: preflightErrors.length === 0,
            errors: preflightErrors,
            warnings: preflightWarnings,
        },
    };
}

function createUnavailableDiagnostic(descriptor = {}, error, code = 'userscripts-api-unavailable') {
    return createPluginDiagnostic(descriptor, {
        state: 'unavailable',
        lastError: typeof error === 'string'
            ? { message: error, stack: '' }
            : error,
        preflightErrors: [
            createIssue(
                code,
                typeof error === 'string'
                    ? error
                    : (error?.message || String(error))
            ),
        ],
    });
}

function createErrorDiagnostic(descriptor = {}, error, { failures = 1 } = {}) {
    return createPluginDiagnostic(descriptor, {
        state: 'error',
        failures,
        lastError: error,
    });
}

function normalizePortKey(pluginId, tabId, frameId = 0) {
    return `${normalizeString(pluginId)}:${Number.isFinite(Number(tabId)) ? Number(tabId) : -1}:${Number.isFinite(Number(frameId)) ? Number(frameId) : 0}`;
}

async function sendMessageToTabWithRetry(tabId, message, {
    retries = 8,
    retryDelayMs = 120,
    frameId = null,
    documentId = '',
} = {}) {
    let lastError = null;
    const sendOptions = {};
    if (Number.isFinite(Number(frameId))) {
        sendOptions.frameId = Number(frameId);
    }
    if (normalizeString(documentId)) {
        sendOptions.documentId = normalizeString(documentId);
    }

    for (let attempt = 0; attempt < retries; attempt += 1) {
        try {
            if (Object.keys(sendOptions).length > 0) {
                return await chrome.tabs.sendMessage(tabId, message, sendOptions);
            }
            return await chrome.tabs.sendMessage(tabId, message);
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
    }

    throw lastError || new Error(`Failed to send message to tab ${tabId}`);
}

export function createPageUserScriptService({
    logger = console,
} = {}) {
    const descriptorsByPluginId = new Map();
    const diagnosticsByPluginId = new Map();
    const registrationIds = new Set();
    const portsByKey = new Map();
    const pendingHookRequests = new Map();
    const portWaiters = new Map();
    let unsubscribePluginSettings = null;
    let unsubscribeDeveloperMode = null;
    let developerModeEnabled = false;
    let started = false;
    let syncPromise = Promise.resolve();
    let worldReady = false;

    const resolvePortWaiters = (pluginId, tabId, portMeta = null) => {
        const waitKey = normalizePortKey(pluginId, tabId);
        const waiters = portWaiters.get(waitKey);
        if (!waiters || waiters.length === 0) {
            return;
        }

        portWaiters.delete(waitKey);
        waiters.forEach((waiter) => {
            try {
                waiter.resolve(portMeta);
            } catch {
                // ignore
            }
        });
    };

    const rejectPortWaiters = (pluginId, tabId, error) => {
        const waitKey = normalizePortKey(pluginId, tabId);
        const waiters = portWaiters.get(waitKey);
        if (!waiters || waiters.length === 0) {
            return;
        }

        portWaiters.delete(waitKey);
        waiters.forEach((waiter) => {
            try {
                waiter.reject(error);
            } catch {
                // ignore
            }
        });
    };

    const waitForReadyPort = (pluginId, tabId, timeoutMs = 1500) => {
        const existing = getReadyPort(pluginId, tabId);
        if (existing) {
            return Promise.resolve(existing);
        }

        return new Promise((resolve, reject) => {
            const waitKey = normalizePortKey(pluginId, tabId);
            const bucket = portWaiters.get(waitKey) || [];
            const timeoutId = setTimeout(() => {
                const currentBucket = portWaiters.get(waitKey) || [];
                portWaiters.set(
                    waitKey,
                    currentBucket.filter((entry) => entry !== waiter)
                );
                reject(new Error(`Page user script "${pluginId}" is not ready in tab ${tabId}`));
            }, timeoutMs);
            const waiter = {
                resolve(value) {
                    clearTimeout(timeoutId);
                    resolve(value);
                },
                reject(error) {
                    clearTimeout(timeoutId);
                    reject(error);
                },
            };
            bucket.push(waiter);
            portWaiters.set(waitKey, bucket);
        });
    };

    const listManagedRegistrationIds = async () => {
        if (!chrome?.userScripts?.getScripts) {
            return [];
        }

        try {
            const existingScripts = await chrome.userScripts.getScripts();
            return (Array.isArray(existingScripts) ? existingScripts : [])
                .map((entry) => normalizeString(entry?.id))
                .filter((id) => id.startsWith(MANAGED_REGISTRATION_PREFIX));
        } catch {
            return [];
        }
    };

    const unregisterManagedScripts = async () => {
        if (!chrome?.userScripts?.unregister) {
            registrationIds.clear();
            return;
        }

        const ids = new Set(Array.from(registrationIds));
        const managedIds = await listManagedRegistrationIds();
        managedIds.forEach((id) => ids.add(id));
        registrationIds.clear();
        if (ids.size === 0) {
            return;
        }
        await chrome.userScripts.unregister({ ids: Array.from(ids) });
    };

    const updateDiagnostic = (pluginId, descriptor, nextDiagnostic) => {
        descriptorsByPluginId.set(pluginId, descriptor);
        diagnosticsByPluginId.set(pluginId, nextDiagnostic);
        return nextDiagnostic;
    };

    const getReadyPort = (pluginId, tabId = null) => {
        const normalizedPluginId = normalizeString(pluginId);
        if (!normalizedPluginId) {
            return null;
        }

        for (const portMeta of portsByKey.values()) {
            if (portMeta.pluginId !== normalizedPluginId || portMeta.ready !== true) {
                continue;
            }
            if (tabId !== null && portMeta.tabId !== Number(tabId)) {
                continue;
            }
            return portMeta;
        }

        return null;
    };

    const getUserScriptsAvailability = async () => {
        if (!chrome?.userScripts?.register || !chrome?.userScripts?.getScripts) {
            return {
                ok: false,
                code: 'userscripts-api-unavailable',
                error: 'chrome.userScripts is unavailable in this browser/runtime',
            };
        }

        try {
            if (typeof chrome.userScripts.configureWorld === 'function' && !worldReady) {
                await chrome.userScripts.configureWorld({
                    messaging: true,
                    csp: "script-src 'self' 'unsafe-eval' data: blob:; object-src 'self'",
                });
                worldReady = true;
            }
            await chrome.userScripts.getScripts();
            return {
                ok: true,
                code: '',
                error: '',
            };
        } catch (error) {
            const message = error?.message || String(error);
            const code = /allow user scripts|userscripts? disabled|permission/i.test(message)
                ? 'userscripts-toggle-disabled'
                : 'userscripts-api-unavailable';
            return {
                ok: false,
                code,
                error: message,
            };
        }
    };

    const sync = async () => {
        const availability = await getUserScriptsAvailability();
        const pagePlugins = (await getInstalledScriptPlugins({ scope: 'page' }))
            .filter((descriptor) => {
                return developerModeEnabled || normalizeString(descriptor?.sourceType) !== 'developer';
            });
        const desiredPluginIds = new Set(pagePlugins.map((descriptor) => normalizeString(descriptor?.id)).filter(Boolean));

        Array.from(descriptorsByPluginId.keys()).forEach((pluginId) => {
            if (desiredPluginIds.has(pluginId)) {
                return;
            }

            descriptorsByPluginId.delete(pluginId);
            diagnosticsByPluginId.delete(pluginId);
            Array.from(portsByKey.entries()).forEach(([key, portMeta]) => {
                if (portMeta?.pluginId !== pluginId) {
                    return;
                }

                portsByKey.delete(key);
                try {
                    portMeta?.port?.disconnect?.();
                } catch {
                    // ignore
                }
            });
        });

        if (!availability.ok) {
            await unregisterManagedScripts();
            pagePlugins.forEach((descriptor) => {
                updateDiagnostic(
                    descriptor.id,
                    descriptor,
                    createUnavailableDiagnostic(descriptor, availability.error, availability.code)
                );
            });
            return;
        }

        const eligibleDescriptors = [];
        const unavailableDescriptors = [];
        pagePlugins.forEach((descriptor) => {
            const compatibilityIssues = getPageUserScriptCompatibilityIssues(descriptor.manifest);
            if (!descriptor.enabled || !descriptor.compatible || !descriptor.runtimeSupported) {
                unavailableDescriptors.push({
                    descriptor,
                    diagnostic: createPluginDiagnostic(descriptor, {
                        state: 'disabled',
                        preflightWarnings: compatibilityIssues,
                    }),
                });
                return;
            }
            if (!isUserScriptCompatiblePagePlugin(descriptor.manifest)) {
                unavailableDescriptors.push({
                    descriptor,
                    diagnostic: createPluginDiagnostic(descriptor, {
                        state: 'unavailable',
                        preflightErrors: compatibilityIssues,
                    }),
                });
                return;
            }
            eligibleDescriptors.push(descriptor);
        });

        unavailableDescriptors.forEach(({ descriptor, diagnostic }) => {
            updateDiagnostic(descriptor.id, descriptor, diagnostic);
        });

        const registrations = [];
        const nextRegistrationIds = new Set();
        for (const descriptor of eligibleDescriptors) {
            try {
                const registration = await buildPageUserScriptRegistration(descriptor);
                registrations.push(registration);
                nextRegistrationIds.add(registration.id);
                const existingActivePort = getReadyPort(descriptor.id);
                updateDiagnostic(
                    descriptor.id,
                    descriptor,
                    createPluginDiagnostic(descriptor, {
                        state: existingActivePort ? 'active' : 'registered',
                        lastActivatedAt: existingActivePort?.connectedAt || 0,
                    })
                );
            } catch (error) {
                updateDiagnostic(
                    descriptor.id,
                    descriptor,
                    createErrorDiagnostic(descriptor, error)
                );
            }
        }

        await unregisterManagedScripts();

        if (registrations.length > 0) {
            const registered = await chrome.userScripts.register(registrations);
            (registered || registrations).forEach((entry) => {
                nextRegistrationIds.add(entry.id);
            });
        }

        registrationIds.clear();
        nextRegistrationIds.forEach((id) => registrationIds.add(id));
    };

    const scheduleSync = () => {
        syncPromise = syncPromise
            .then(() => sync())
            .catch((error) => {
                logger?.error?.('[Cerebr] Failed to sync page user scripts', error);
            });
        return syncPromise;
    };

    const resolvePortMeta = (port) => {
        const pluginId = normalizeString(
            String(port?.name || '').replace(/^cerebr\.page\.user-script:/, '')
        );
        const tabId = Number.isFinite(Number(port?.sender?.tab?.id))
            ? Number(port.sender.tab.id)
            : null;
        const frameId = Number.isFinite(Number(port?.sender?.frameId))
            ? Number(port.sender.frameId)
            : 0;
        const documentId = normalizeString(port?.sender?.documentId);

        if (!pluginId || tabId === null) {
            return null;
        }

        return {
            key: normalizePortKey(pluginId, tabId, frameId),
            pluginId,
            tabId,
            frameId,
            documentId,
            connectedAt: Date.now(),
            ready: false,
            port,
        };
    };

    const respondToPort = (portMeta, payload) => {
        try {
            portMeta?.port?.postMessage?.(payload);
        } catch (error) {
            logger?.warn?.('[Cerebr] Failed to respond to page user script port', error);
        }
    };

    const routeRpcToContent = async (portMeta, message) => {
        const descriptor = descriptorsByPluginId.get(portMeta.pluginId);
        if (!descriptor) {
            throw new Error(`Unknown page user script plugin "${portMeta.pluginId}"`);
        }

        const response = await sendMessageToTabWithRetry(portMeta.tabId, {
            type: 'PAGE_USER_SCRIPT_PLUGIN_HOST_RPC',
            pluginId: portMeta.pluginId,
            manifest: descriptor.manifest || null,
            method: normalizeString(message?.method),
            args: Array.isArray(message?.args) ? message.args : [],
        }, {
            frameId: portMeta.frameId,
            documentId: portMeta.documentId,
        });

        if (response?.success === false) {
            throw new Error(response?.error || 'Page user script host RPC failed');
        }

        return response?.value;
    };

    const handlePortMessage = (portMeta, message) => {
        const messageType = normalizeString(message?.type);

        if (messageType === MSG_READY) {
            portMeta.ready = true;
            portMeta.connectedAt = Date.now();
            const descriptor = descriptorsByPluginId.get(portMeta.pluginId);
            if (descriptor) {
                updateDiagnostic(
                    portMeta.pluginId,
                    descriptor,
                    createPluginDiagnostic(descriptor, {
                        state: 'active',
                        lastActivatedAt: portMeta.connectedAt,
                    })
                );
            }
            resolvePortWaiters(portMeta.pluginId, portMeta.tabId, portMeta);
            return;
        }

        if (messageType === MSG_ERROR) {
            const descriptor = descriptorsByPluginId.get(portMeta.pluginId);
            if (descriptor) {
                updateDiagnostic(
                    portMeta.pluginId,
                    descriptor,
                    createErrorDiagnostic(descriptor, message?.error || new Error('User script runtime error'))
                );
            }
            return;
        }

        if (messageType === MSG_RPC) {
            void Promise.resolve()
                .then(() => routeRpcToContent(portMeta, message))
                .then((value) => {
                    respondToPort(portMeta, {
                        type: MSG_RPC_RESPONSE,
                        requestId: normalizeString(message?.requestId),
                        ok: true,
                        value,
                    });
                })
                .catch((error) => {
                    respondToPort(portMeta, {
                        type: MSG_RPC_RESPONSE,
                        requestId: normalizeString(message?.requestId),
                        ok: false,
                        error: createSerializableError(error),
                    });
                });
            return;
        }

        if (messageType === MSG_HOOK_RESPONSE) {
            const requestId = normalizeString(message?.requestId);
            const pending = pendingHookRequests.get(requestId);
            if (!pending) {
                return;
            }

            pendingHookRequests.delete(requestId);
            if (message?.ok === false) {
                pending.reject(new Error(normalizeString(message?.error?.message, 'Page user script hook failed')));
                return;
            }

            pending.resolve(message?.value);
        }
    };

    const handlePortDisconnect = (portMeta) => {
        portsByKey.delete(portMeta.key);
        rejectPortWaiters(portMeta.pluginId, portMeta.tabId, new Error('Page user script disconnected'));

        const descriptor = descriptorsByPluginId.get(portMeta.pluginId);
        if (descriptor) {
            updateDiagnostic(
                portMeta.pluginId,
                descriptor,
                createPluginDiagnostic(descriptor, {
                    state: 'registered',
                    lastStoppedAt: Date.now(),
                })
            );
        }
    };

    const attachPort = (port) => {
        const portMeta = resolvePortMeta(port);
        if (!portMeta) {
            return;
        }

        portsByKey.set(portMeta.key, portMeta);
        port.onMessage.addListener((message) => {
            handlePortMessage(portMeta, message);
        });
        port.onDisconnect.addListener(() => {
            handlePortDisconnect(portMeta);
        });
    };

    const invokeHook = async ({ pluginId = '', hookName = '', args = [], sender = null } = {}) => {
        const normalizedPluginId = normalizeString(pluginId);
        const descriptor = descriptorsByPluginId.get(normalizedPluginId);
        if (!descriptor) {
            return {
                success: false,
                error: `Unknown page user script plugin "${normalizedPluginId}"`,
            };
        }

        const tabId = Number.isFinite(Number(sender?.tab?.id))
            ? Number(sender.tab.id)
            : null;
        if (tabId === null) {
            return {
                success: false,
                error: 'No active tab available for page user script hook delivery',
            };
        }

        const portMeta = await waitForReadyPort(normalizedPluginId, tabId);
        const requestId = `${normalizedPluginId}:${hookName}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        const result = await new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                pendingHookRequests.delete(requestId);
                reject(new Error(`Timed out while waiting for page user script hook "${hookName}"`));
            }, 1200);

            pendingHookRequests.set(requestId, {
                resolve(value) {
                    clearTimeout(timeoutId);
                    resolve(value);
                },
                reject(error) {
                    clearTimeout(timeoutId);
                    reject(error);
                },
            });

            respondToPort(portMeta, {
                type: MSG_HOOK_REQUEST,
                requestId,
                hookName: normalizeString(hookName),
                args: Array.isArray(args) ? args : [],
            });
        });

        return {
            success: true,
            value: result,
        };
    };

    const handleRuntimeMessage = async (message, sender) => {
        const type = normalizeString(message?.type);
        if (type === MSG_STATUS_QUERY) {
            const pluginId = normalizeString(message?.pluginId);
            const diagnostic = diagnosticsByPluginId.get(pluginId);
            return {
                success: !!diagnostic && diagnostic.state !== 'unavailable' && diagnostic.state !== 'error',
                diagnostic: diagnostic || null,
                error: diagnostic?.lastError?.message
                    || diagnostic?.preflight?.errors?.[0]?.message
                    || '',
            };
        }

        if (type === MSG_HOOK_INVOKE) {
            return invokeHook({
                pluginId: message?.pluginId,
                hookName: message?.hookName,
                args: message?.args,
                sender,
            });
        }

        if (type === MSG_HOST_EVENT) {
            const pluginId = normalizeString(message?.pluginId);
            const senderTabId = Number.isFinite(Number(sender?.tab?.id))
                ? Number(sender.tab.id)
                : null;
            const senderFrameId = Number.isFinite(Number(sender?.frameId))
                ? Number(sender.frameId)
                : null;
            const tabId = Number.isFinite(Number(message?.tabId))
                ? Number(message.tabId)
                : senderTabId;
            const frameId = Number.isFinite(Number(message?.frameId))
                ? Number(message.frameId)
                : senderFrameId;
            const portMeta = tabId === null
                ? null
                : (() => {
                    if (frameId === null) {
                        return getReadyPort(pluginId, tabId);
                    }

                    const key = normalizePortKey(pluginId, tabId, frameId);
                    return portsByKey.get(key) || getReadyPort(pluginId, tabId);
                })();
            if (!portMeta) {
                return {
                    success: false,
                    error: `No active page user script runtime for "${pluginId}"`,
                };
            }

            respondToPort(portMeta, {
                type: MSG_EVENT,
                event: normalizeString(message?.event),
                value: message?.value && typeof message.value === 'object'
                    ? { ...message.value }
                    : message?.value,
            });
            return {
                success: true,
            };
        }

        return null;
    };

    return {
        async start() {
            if (started) {
                return;
            }
            started = true;
            developerModeEnabled = await readDeveloperModePreference();
            await scheduleSync();
            unsubscribePluginSettings = subscribePluginSettings(() => {
                void scheduleSync();
            });
            unsubscribeDeveloperMode = subscribeDeveloperModePreference((enabled) => {
                developerModeEnabled = !!enabled;
                void scheduleSync();
            });
        },
        async stop() {
            if (!started) {
                return;
            }
            started = false;
            unsubscribePluginSettings?.();
            unsubscribePluginSettings = null;
            unsubscribeDeveloperMode?.();
            unsubscribeDeveloperMode = null;
            await unregisterManagedScripts();
            portsByKey.clear();
            descriptorsByPluginId.clear();
            diagnosticsByPluginId.clear();
            pendingHookRequests.clear();
        },
        attachPort,
        async handleRuntimeMessage(message, sender) {
            return handleRuntimeMessage(message, sender);
        },
        getDiagnostics({ tabId = null } = {}) {
            return Array.from(diagnosticsByPluginId.values()).map((diagnostic) => {
                if (tabId === null) {
                    return { ...diagnostic };
                }

                const portMeta = getReadyPort(diagnostic.id, tabId);
                if (!portMeta && diagnostic.state === 'active') {
                    return {
                        ...diagnostic,
                        active: false,
                        state: 'registered',
                    };
                }

                if (!portMeta) {
                    return { ...diagnostic };
                }

                return {
                    ...diagnostic,
                    active: true,
                    state: 'active',
                    lastActivatedAt: portMeta.connectedAt,
                };
            });
        },
    };
}
