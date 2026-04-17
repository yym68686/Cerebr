import { createPluginBridgeMessage, isPluginBridgeMessage } from '../bridge/plugin-bridge.js';
import { createHostedPluginRuntime } from '../core/hosted-plugin-runtime.js';
import { createPermissionController } from '../core/plugin-permissions.js';
import { createPluginResourceStore } from '../core/plugin-resource-store.js';
import {
    materializePromptFragment,
    normalizePromptFragment,
    sortPromptFragments,
} from '../core/prompt-fragment-utils.js';
import {
    normalizePositiveInt,
    normalizeString,
} from '../core/runtime-utils.js';
import {
    browserAdapter,
    isExtensionEnvironment,
} from '../../utils/storage-adapter.js';
import { showToast } from '../../utils/ui.js';
import { createEditorController } from '../../runtime/input/editor-controller.js';
import { createSlotRegistry } from '../../runtime/ui/slot-registry.js';
import { getBuiltinShellPluginEntries } from './shell-plugin-registry.js';
import {
    getShellThemeSnapshot,
    observeShellTheme,
    requestShellLayoutSync,
} from './shell-host-utils.js';

function createPluginMeta(entry = {}) {
    return {
        id: normalizeString(entry?.plugin?.id),
        manifest: entry?.manifest ? { ...entry.manifest } : null,
    };
}

export function createShellPluginRuntime({
    messageInput,
    slotContainers = {},
} = {}) {
    const editor = createEditorController({
        messageInput,
    });
    const slotRegistry = createSlotRegistry({
        slots: slotContainers,
    });
    const chatRuntimeRef = {
        current: null,
    };
    const pluginResources = createPluginResourceStore({
        logger: console,
        createState: () => ({
            promptFragments: new Map(),
        }),
        onCleanup(pluginId, resources) {
            resources?.promptFragments?.clear?.();
            slotRegistry.unmountByPlugin(pluginId);
        },
    });
    let started = false;
    let inputHookTimer = 0;

    const collectPersistentPromptFragments = () => {
        const fragments = [];

        pluginResources.forEach((resources) => {
            resources.promptFragments?.forEach((fragment) => {
                fragments.push({ ...fragment });
            });
        });

        return sortPromptFragments(fragments);
    };

    const dispatchIncomingBridgeMessage = (bridgeMessage, baseContext = {}) => {
        if (!isPluginBridgeMessage(bridgeMessage, 'shell')) {
            return Promise.resolve([]);
        }

        const hookResultsPromise = runtimeController.pluginManager.invokeHook('onBridgeMessage', (entry) => [
            bridgeMessage,
            createHookContext(entry, {
                ...baseContext,
                bridgeMessage,
            }),
        ], {
            timeoutMs: 320,
        });

        const { command, payload = {} } = bridgeMessage;
        if (command === 'editor.focus') {
            editor.focus();
            return hookResultsPromise;
        }
        if (command === 'editor.setDraft') {
            editor.setDraft(payload.text);
            return hookResultsPromise;
        }
        if (command === 'editor.insertText') {
            editor.insertText(payload.text, payload.options || {});
            return hookResultsPromise;
        }
        if (command === 'editor.importText') {
            editor.importText(payload.text, {
                focus: payload.focus !== false,
                separator: payload.separator || '\n\n',
            });
        }

        return hookResultsPromise;
    };

    const createChatHostApi = (entry = null, { allowDirectives = false, directives = null } = {}) => {
        const permissions = createPermissionController(entry);

        return {
            getCurrentChat() {
                if (entry) {
                    permissions.assert('chat:read');
                }
                return chatRuntimeRef.current?.getCurrentChat?.() || null;
            },
            getMessages() {
                if (entry) {
                    permissions.assert('chat:read');
                }
                return chatRuntimeRef.current?.getMessages?.() || [];
            },
            sendDraft() {
                if (entry) {
                    permissions.assert('chat:write');
                }
                return chatRuntimeRef.current?.sendMessage?.() ?? false;
            },
            abort() {
                if (entry) {
                    permissions.assert('chat:write');
                }
                chatRuntimeRef.current?.abortActiveReply?.();
                return true;
            },
            regenerate(messageElement) {
                if (entry) {
                    permissions.assert('chat:write');
                }
                return chatRuntimeRef.current?.regenerateMessage?.(messageElement) ?? false;
            },
            retry(reason = '', options = {}) {
                if (entry) {
                    permissions.assert('chat:write');
                }
                if (!allowDirectives || !directives) return null;

                directives.retry = {
                    reason: normalizeString(reason),
                    maxAttempts: normalizePositiveInt(options.maxAttempts, 20),
                };
                return directives.retry;
            },
            cancel(reason = '') {
                if (entry) {
                    permissions.assert('chat:write');
                }
                if (!allowDirectives || !directives) return null;

                directives.cancel = {
                    reason: normalizeString(reason),
                };
                return directives.cancel;
            },
        };
    };

    const createPromptApi = (entry = {}) => {
        const permissions = createPermissionController(entry);

        return {
            addFragment(fragment) {
                permissions.assert('prompt:extend', ['prompt:write']);
                const normalized = normalizePromptFragment(fragment, entry?.plugin?.id);
                if (!normalized) {
                    return null;
                }

                const resources = pluginResources.ensure(entry?.plugin?.id);
                resources.promptFragments.set(normalized.id, normalized);

                const dispose = () => {
                    resources.promptFragments.delete(normalized.id);
                };
                pluginResources.addDisposer(entry?.plugin?.id, dispose);

                return {
                    ...(materializePromptFragment(normalized) || normalized),
                    dispose,
                };
            },
            removeFragment(fragmentId) {
                const resources = pluginResources.ensure(entry?.plugin?.id);
                resources.promptFragments.delete(normalizeString(fragmentId));
            },
            listFragments() {
                const resources = pluginResources.ensure(entry?.plugin?.id);
                return sortPromptFragments(
                    [...resources.promptFragments.values()].map((fragment) => ({ ...fragment }))
                )
                    .map((fragment) => materializePromptFragment(fragment))
                    .filter(Boolean);
            },
        };
    };

    const createUiApi = (entry = {}) => {
        const permissions = createPermissionController(entry);

        return {
            showToast(message, options = {}) {
                showToast(String(message ?? ''), options);
            },
            mountSlot(slotId, renderer, options = {}) {
                permissions.assert('ui:mount');
                const handle = slotRegistry.mount(slotId, entry?.plugin?.id, renderer, options);
                pluginResources.addDisposer(entry?.plugin?.id, () => handle.dispose());
                return handle;
            },
            getAvailableSlots() {
                return slotRegistry.getAvailableSlots();
            },
        };
    };

    const createBrowserApi = (entry = {}) => {
        const permissions = createPermissionController(entry);

        return {
            async getCurrentTab() {
                permissions.assert('tabs:read', ['tabs:active']);
                return browserAdapter.getCurrentTab();
            },
        };
    };

    const createShellApi = (entry = {}) => {
        const permissions = createPermissionController(entry);

        return {
            isVisible() {
                return true;
            },
            open() {
                return true;
            },
            close() {
                return true;
            },
            toggle() {
                return true;
            },
            mountInputAddon(renderer, options = {}) {
                permissions.assert('shell:input', ['ui:mount']);
                const handle = slotRegistry.mount(
                    normalizeString(options.slotId, 'shell.input.after'),
                    entry?.plugin?.id,
                    renderer,
                    {
                        ...options,
                        className: [
                            'cerebr-plugin-slot-item--shell-input-addon',
                            normalizeString(options.className),
                        ]
                            .filter(Boolean)
                            .join(' '),
                    }
                );

                pluginResources.addDisposer(entry?.plugin?.id, () => handle.dispose());
                requestShellLayoutSync();
                return handle;
            },
            observeTheme(callback, options = {}) {
                const unsubscribe = observeShellTheme(callback, options);
                pluginResources.addDisposer(entry?.plugin?.id, unsubscribe);
                return unsubscribe;
            },
            getThemeSnapshot() {
                return getShellThemeSnapshot();
            },
            requestLayoutSync() {
                permissions.assert('shell:input', ['ui:mount']);
                return requestShellLayoutSync();
            },
        };
    };

    const createBridgeApi = (entry = {}) => {
        const permissions = createPermissionController(entry);
        const sourcePluginId = normalizeString(entry?.plugin?.id);

        return {
            async send(target, command, payload = {}) {
                permissions.assert('bridge:send');
                const normalizedTarget = normalizeString(target);
                const bridgeMessage = createPluginBridgeMessage(
                    normalizedTarget,
                    command,
                    payload,
                    {
                        sourceHost: 'shell',
                        sourcePluginId,
                    }
                );

                if (normalizedTarget === 'shell') {
                    const results = await dispatchIncomingBridgeMessage(bridgeMessage, {
                        bridgeSource: {
                            host: 'shell',
                            pluginId: sourcePluginId,
                        },
                    });
                    return {
                        success: true,
                        target: normalizedTarget,
                        results,
                    };
                }

                if (normalizedTarget === 'background' && isExtensionEnvironment && chrome?.runtime?.sendMessage) {
                    try {
                        const response = await chrome.runtime.sendMessage({
                            type: 'PLUGIN_BRIDGE_RELAY',
                            bridge: bridgeMessage,
                        });
                        return response || {
                            success: true,
                            target: normalizedTarget,
                        };
                    } catch (error) {
                        return {
                            success: false,
                            target: normalizedTarget,
                            error: error?.message || String(error),
                        };
                    }
                }

                if (window.parent && window.parent !== window) {
                    try {
                        window.parent.postMessage(bridgeMessage, '*');
                        return {
                            success: true,
                            target: normalizedTarget,
                        };
                    } catch (error) {
                        return {
                            success: false,
                            target: normalizedTarget,
                            error: error?.message || String(error),
                        };
                    }
                }

                return {
                    success: false,
                    target: normalizedTarget,
                    error: 'Bridge target is unavailable',
                };
            },
        };
    };

    const createPluginApi = (entry = {}) => ({
        editor,
        browser: createBrowserApi(entry),
        chat: createChatHostApi(entry),
        prompt: createPromptApi(entry),
        ui: createUiApi(entry),
        bridge: createBridgeApi(entry),
        shell: createShellApi(entry),
    });

    const createHookContext = (entry = {}, baseContext = {}) => {
        const directives = {
            retry: null,
            cancel: null,
            promptFragments: [],
        };
        const permissions = createPermissionController(entry);

        return {
            ...baseContext,
            directives,
            plugin: createPluginMeta(entry),
            editor,
            browser: createBrowserApi(entry),
            chat: createChatHostApi(entry, {
                allowDirectives: true,
                directives,
            }),
            prompt: {
                addFragment(fragment) {
                    permissions.assert('prompt:extend', ['prompt:write']);
                    const normalized = normalizePromptFragment(fragment, entry?.plugin?.id);
                    if (!normalized) {
                        return null;
                    }
                    directives.promptFragments.push(normalized);
                    return materializePromptFragment(normalized) || normalized;
                },
            },
            ui: {
                showToast(message, options = {}) {
                    showToast(String(message ?? ''), options);
                },
                getAvailableSlots() {
                    return slotRegistry.getAvailableSlots();
                },
            },
            bridge: createBridgeApi(entry),
            shell: createShellApi(entry),
            runtime: {
                host: 'shell',
                isExtension: isExtensionEnvironment,
            },
        };
    };

    const runtimeController = createHostedPluginRuntime({
        host: 'shell',
        builtinEntries: getBuiltinShellPluginEntries(),
        declarativeScopes: ['shell', 'prompt'],
        createApi: createPluginApi,
        logger: console,
        onPluginStopped(entry) {
            pluginResources.cleanup(entry?.plugin?.id);
        },
    });

    const scheduleInputHook = () => {
        if (inputHookTimer) {
            clearTimeout(inputHookTimer);
        }

        inputHookTimer = window.setTimeout(() => {
            inputHookTimer = 0;
            const snapshot = editor.getDraftSnapshot();
            void runtimeController.pluginManager.invokeHook('onInputChanged', (entry) => [
                snapshot,
                createHookContext(entry, {
                    draft: snapshot,
                }),
            ], {
                timeoutMs: 220,
            });
        }, 120);
    };

    const handleBridgeMessage = (event) => {
        if (!isPluginBridgeMessage(event?.data, 'shell')) return;
        void dispatchIncomingBridgeMessage(event.data, {
            bridgeSource: {
                host: normalizeString(event?.data?.meta?.sourceHost),
                pluginId: normalizeString(event?.data?.meta?.sourcePluginId),
                origin: normalizeString(event?.origin),
            },
        });
    };

    return {
        attachChatRuntime(chatRuntime = null) {
            chatRuntimeRef.current = chatRuntime;
        },
        async runBeforeSend(payload, context = {}) {
            const hookStates = [];
            const result = await runtimeController.pluginManager.runWaterfallHook('onBeforeSend', payload, (entry) => {
                const hookContext = createHookContext(entry, {
                    ...context,
                    payload,
                });
                hookStates.push(hookContext);
                return [hookContext];
            }, {
                timeoutMs: 1400,
            });

            return {
                payload: result.value,
                cancel: hookStates.some((state) => !!state.directives.cancel),
            };
        },
        async buildPromptFragments(requestContext = {}) {
            const hookStates = [];
            const hookResults = await runtimeController.pluginManager.collectHookResults('onBuildPrompt', (entry) => {
                const hookContext = createHookContext(entry, {
                    request: requestContext,
                });
                hookStates.push(hookContext);
                return [hookContext];
            }, {
                timeoutMs: 900,
            });
            const dynamicFragments = hookResults
                .map(({ pluginId, value }) => normalizePromptFragment(value, pluginId))
                .filter(Boolean);

            return {
                fragments: sortPromptFragments([
                    ...collectPersistentPromptFragments(),
                    ...hookStates.flatMap((state) => state.directives.promptFragments),
                    ...dynamicFragments,
                ])
                    .map((fragment) => materializePromptFragment(fragment))
                    .filter(Boolean),
            };
        },
        async transformRequest(requestDescriptor, requestContext = {}) {
            const result = await runtimeController.pluginManager.runWaterfallHook('onRequest', requestDescriptor, (entry) => [
                createHookContext(entry, {
                    request: requestContext,
                    requestDescriptor,
                }),
            ], {
                timeoutMs: 900,
            });
            return result.value;
        },
        async handleResponse(responseDescriptor, requestContext = {}) {
            await runtimeController.pluginManager.invokeHook('onResponse', (entry) => [
                responseDescriptor,
                createHookContext(entry, {
                    request: requestContext,
                }),
            ], {
                timeoutMs: 900,
            });
        },
        async handleRequestError(error, requestDescriptor, requestContext = {}) {
            await runtimeController.pluginManager.invokeHook('onRequestError', (entry) => [
                error,
                createHookContext(entry, {
                    request: requestContext,
                    requestDescriptor,
                }),
            ], {
                timeoutMs: 900,
            });
        },
        async handleStreamChunk(chunk, requestContext = {}) {
            await runtimeController.pluginManager.invokeHook('onStreamChunk', (entry) => [
                chunk,
                createHookContext(entry, {
                    request: requestContext,
                }),
            ], {
                timeoutMs: 220,
            });
        },
        async handleResponseError(error, requestContext = {}) {
            const hookStates = [];
            await runtimeController.pluginManager.invokeHook('onResponseError', (entry) => {
                const hookContext = createHookContext(entry, {
                    request: requestContext,
                    error,
                });
                hookStates.push(hookContext);
                return [error, hookContext];
            }, {
                timeoutMs: 900,
            });

            const retryDirectives = hookStates
                .map((state) => state.directives.retry)
                .filter(Boolean);

            return {
                retry: retryDirectives.length ? retryDirectives[retryDirectives.length - 1] : null,
                cancel: hookStates.some((state) => !!state.directives.cancel),
            };
        },
        async handleAfterResponse(result, requestContext = {}) {
            await runtimeController.pluginManager.invokeHook('onAfterResponse', (entry) => [
                result,
                createHookContext(entry, {
                    request: requestContext,
                    result,
                }),
            ], {
                timeoutMs: 900,
            });
        },
        getAvailableSlots() {
            return slotRegistry.getAvailableSlots();
        },
        async start() {
            if (started) return;
            started = true;

            window.addEventListener('message', handleBridgeMessage);
            messageInput?.addEventListener?.('input', scheduleInputHook);
            await runtimeController.start();
        },
        async stop() {
            if (!started) return;
            started = false;

            window.removeEventListener('message', handleBridgeMessage);
            messageInput?.removeEventListener?.('input', scheduleInputHook);
            if (inputHookTimer) {
                clearTimeout(inputHookTimer);
                inputHookTimer = 0;
            }

            await runtimeController.stop();
            pluginResources.cleanupAll();
        },
    };
}
