import { isPluginBridgeMessage } from '../bridge/plugin-bridge.js';
import { createPluginManager } from '../shared/plugin-manager.js';
import { isPluginEnabled, readPluginSettings, subscribePluginSettings } from '../shared/plugin-store.js';
import { getInstalledScriptPlugins } from '../dev/local-plugin-service.js';
import { readDeveloperModePreference, subscribeDeveloperModePreference } from '../dev/developer-mode.js';
import { createScriptPluginCacheKey, loadScriptPluginModule } from '../dev/script-plugin-loader.js';
import { isExtensionEnvironment } from '../../utils/storage-adapter.js';
import { showToast } from '../../utils/ui.js';
import { createEditorController } from '../../runtime/input/editor-controller.js';
import { createSlotRegistry } from '../../runtime/ui/slot-registry.js';
import { getBuiltinShellPluginEntries } from './shell-plugin-registry.js';

function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function normalizeStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => normalizeString(item)).filter(Boolean);
}

function normalizePositiveInt(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0
        ? Math.max(1, Math.floor(numeric))
        : fallback;
}

function normalizePromptFragment(fragment, pluginId) {
    if (typeof fragment === 'string') {
        const content = normalizeString(fragment);
        if (!content) return null;
        return {
            pluginId,
            id: `${pluginId || 'plugin'}:fragment:${content.slice(0, 32)}`,
            placement: 'system.append',
            content,
        };
    }

    if (!fragment || typeof fragment !== 'object') {
        return null;
    }

    const content = normalizeString(fragment.content);
    if (!content) {
        return null;
    }

    const placement = normalizeString(fragment.placement, 'system.append');
    const normalizedPluginId = normalizeString(fragment.pluginId, pluginId);
    const fragmentId = normalizeString(
        fragment.id,
        `${normalizedPluginId || 'plugin'}:fragment:${content.slice(0, 32)}`
    );

    return {
        pluginId: normalizedPluginId,
        id: fragmentId,
        placement,
        content,
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
    const builtinPluginEntries = Array.isArray(getBuiltinShellPluginEntries())
        ? getBuiltinShellPluginEntries()
        : [];
    const builtinEntryMap = new Map(
        builtinPluginEntries
            .filter((entry) => entry?.plugin?.id)
            .map((entry) => [
                entry.plugin.id,
                {
                    plugin: entry.plugin,
                    manifest: entry.manifest || null,
                },
            ])
    );

    const pluginResources = new Map();
    const scriptPluginCache = new Map();
    const chatRuntimeRef = {
        current: null,
    };
    let unsubscribePluginSettings = null;
    let unsubscribeDeveloperMode = null;
    let pluginSyncPromise = Promise.resolve();
    let developerModeEnabled = false;
    let started = false;
    let inputHookTimer = 0;

    const ensurePluginResources = (pluginId) => {
        const normalizedPluginId = normalizeString(pluginId);
        if (!pluginResources.has(normalizedPluginId)) {
            pluginResources.set(normalizedPluginId, {
                promptFragments: new Map(),
                disposers: new Set(),
            });
        }
        return pluginResources.get(normalizedPluginId);
    };

    const registerPluginDisposer = (pluginId, disposer) => {
        if (typeof disposer !== 'function') {
            return () => {};
        }

        const resources = ensurePluginResources(pluginId);
        resources.disposers.add(disposer);
        return () => {
            resources.disposers.delete(disposer);
        };
    };

    const cleanupPluginResources = (pluginId) => {
        const normalizedPluginId = normalizeString(pluginId);
        const resources = pluginResources.get(normalizedPluginId);
        if (!resources) {
            slotRegistry.unmountByPlugin(normalizedPluginId);
            return;
        }

        resources.disposers.forEach((dispose) => {
            try {
                dispose();
            } catch (error) {
                console.error(`[Cerebr] Failed to clean up resources for plugin "${normalizedPluginId}"`, error);
            }
        });
        resources.disposers.clear();
        resources.promptFragments.clear();
        pluginResources.delete(normalizedPluginId);
        slotRegistry.unmountByPlugin(normalizedPluginId);
    };

    const isPluginBuiltin = (entry = {}) => {
        return entry?.manifest?.kind === 'builtin' || String(entry?.plugin?.id || '').startsWith('builtin.');
    };

    const hasPermission = (entry = {}, permission, aliases = []) => {
        if (!permission || isPluginBuiltin(entry)) {
            return true;
        }

        const allowed = new Set(normalizeStringArray(entry?.manifest?.permissions));
        if (allowed.has(permission)) {
            return true;
        }

        return aliases.some((alias) => allowed.has(alias));
    };

    const assertPermission = (entry, permission, aliases = []) => {
        if (!hasPermission(entry, permission, aliases)) {
            throw new Error(`Plugin "${entry?.plugin?.id || ''}" requires permission "${permission}"`);
        }
    };

    const createUiApi = (entry) => ({
        showToast(message, options = {}) {
            showToast(String(message ?? ''), options);
        },
        mountSlot(slotId, renderer, options = {}) {
            assertPermission(entry, 'ui:mount');
            const handle = slotRegistry.mount(slotId, entry?.plugin?.id, renderer, options);
            registerPluginDisposer(entry?.plugin?.id, () => handle.dispose());
            return handle;
        },
        getAvailableSlots() {
            return slotRegistry.getAvailableSlots();
        },
    });

    const createPromptApi = (entry) => ({
        addFragment(fragment) {
            assertPermission(entry, 'prompt:extend', ['prompt:write']);
            const normalized = normalizePromptFragment(fragment, entry?.plugin?.id);
            if (!normalized) {
                return null;
            }

            const resources = ensurePluginResources(entry?.plugin?.id);
            resources.promptFragments.set(normalized.id, normalized);

            const dispose = () => {
                resources.promptFragments.delete(normalized.id);
            };
            registerPluginDisposer(entry?.plugin?.id, dispose);
            return {
                ...normalized,
                dispose,
            };
        },
        removeFragment(fragmentId) {
            const resources = ensurePluginResources(entry?.plugin?.id);
            resources.promptFragments.delete(normalizeString(fragmentId));
        },
        listFragments() {
            const resources = ensurePluginResources(entry?.plugin?.id);
            return [...resources.promptFragments.values()].map((fragment) => ({ ...fragment }));
        },
    });

    const createChatHostApi = (entry = null, { allowDirectives = false, directives = null } = {}) => ({
        getCurrentChat() {
            if (entry) {
                assertPermission(entry, 'chat:read');
            }
            return chatRuntimeRef.current?.getCurrentChat?.() || null;
        },
        getMessages() {
            if (entry) {
                assertPermission(entry, 'chat:read');
            }
            return chatRuntimeRef.current?.getMessages?.() || [];
        },
        sendDraft() {
            if (entry) {
                assertPermission(entry, 'chat:write');
            }
            return chatRuntimeRef.current?.sendMessage?.() ?? false;
        },
        abort() {
            if (entry) {
                assertPermission(entry, 'chat:write');
            }
            chatRuntimeRef.current?.abortActiveReply?.();
            return true;
        },
        regenerate(messageElement) {
            if (entry) {
                assertPermission(entry, 'chat:write');
            }
            return chatRuntimeRef.current?.regenerateMessage?.(messageElement) ?? false;
        },
        retry(reason = '', options = {}) {
            if (entry) {
                assertPermission(entry, 'chat:write');
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
                assertPermission(entry, 'chat:write');
            }
            if (!allowDirectives || !directives) return null;
            directives.cancel = {
                reason: normalizeString(reason),
            };
            return directives.cancel;
        },
    });

    const shellApi = {
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
    };

    const createPluginApi = (entry) => ({
        editor,
        chat: createChatHostApi(entry),
        prompt: createPromptApi(entry),
        ui: createUiApi(entry),
        shell: shellApi,
    });

    const createHookContext = (entry, baseContext = {}) => {
        const directives = {
            retry: null,
            cancel: null,
            promptFragments: [],
        };

        return {
            ...baseContext,
            directives,
            plugin: {
                id: normalizeString(entry?.plugin?.id),
                manifest: entry?.manifest ? { ...entry.manifest } : null,
            },
            editor,
            chat: createChatHostApi(entry, {
                allowDirectives: true,
                directives,
            }),
            prompt: {
                addFragment(fragment) {
                    assertPermission(entry, 'prompt:extend', ['prompt:write']);
                    const normalized = normalizePromptFragment(fragment, entry?.plugin?.id);
                    if (!normalized) return null;
                    directives.promptFragments.push(normalized);
                    return normalized;
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
            shell: shellApi,
            runtime: {
                host: 'shell',
                isExtension: isExtensionEnvironment,
            },
        };
    };

    const collectPersistentPromptFragments = () => {
        const fragments = [];

        pluginResources.forEach((resources) => {
            resources.promptFragments.forEach((fragment) => {
                fragments.push({ ...fragment });
            });
        });

        return fragments;
    };

    const pluginManager = createPluginManager({
        plugins: [],
        createApi: createPluginApi,
        logger: console,
        onPluginStopped(entry) {
            cleanupPluginResources(entry?.plugin?.id);
        },
    });

    const getRegisteredPluginIds = () => new Set(
        pluginManager.getPlugins().map((plugin) => plugin?.id).filter(Boolean)
    );

    const resolveScriptPlugin = async (descriptor) => {
        const signature = createScriptPluginCacheKey(descriptor);
        const cached = scriptPluginCache.get(descriptor.id);
        if (cached?.signature === signature && cached.plugin) {
            return {
                plugin: cached.plugin,
                changed: false,
            };
        }

        const plugin = await loadScriptPluginModule(descriptor);
        scriptPluginCache.set(descriptor.id, { signature, plugin });
        return {
            plugin,
            changed: true,
        };
    };

    const scheduleInputHook = () => {
        if (inputHookTimer) {
            clearTimeout(inputHookTimer);
        }

        inputHookTimer = window.setTimeout(() => {
            inputHookTimer = 0;
            const snapshot = editor.getDraftSnapshot();
            const hookContext = createHookContext({
                draft: snapshot,
            });
            void pluginManager.invokeHook('onInputChanged', [snapshot, hookContext], {
                timeoutMs: 220,
            });
        }, 120);
    };

    const applyPluginSettings = async (settings) => {
        const activePluginIds = new Set(pluginManager.getActivePluginIds());
        const registeredPluginIds = getRegisteredPluginIds();
        const desiredScriptPluginIds = new Set();

        for (const [pluginId, entry] of builtinEntryMap.entries()) {
            const shouldEnable = isPluginEnabled(settings, pluginId, entry.manifest?.defaultEnabled !== false);

            if (!shouldEnable) {
                if (registeredPluginIds.has(pluginId)) {
                    await pluginManager.unregister(pluginId);
                    registeredPluginIds.delete(pluginId);
                    activePluginIds.delete(pluginId);
                }
                continue;
            }

            if (!activePluginIds.has(pluginId)) {
                await pluginManager.register(entry);
                activePluginIds.add(pluginId);
                registeredPluginIds.add(pluginId);
            }
        }

        const installedScriptPlugins = await getInstalledScriptPlugins({ scope: 'shell' });
        const activeScriptPlugins = installedScriptPlugins.filter((descriptor) => {
            return developerModeEnabled || descriptor.sourceType !== 'developer';
        });

        for (const descriptor of activeScriptPlugins) {
            desiredScriptPluginIds.add(descriptor.id);
            const shouldEnable = descriptor.compatible &&
                descriptor.runtimeSupported &&
                isPluginEnabled(settings, descriptor.id, descriptor.manifest?.defaultEnabled !== false);

            if (!shouldEnable) {
                if (registeredPluginIds.has(descriptor.id)) {
                    await pluginManager.unregister(descriptor.id);
                    registeredPluginIds.delete(descriptor.id);
                    activePluginIds.delete(descriptor.id);
                }
                continue;
            }

            try {
                const { plugin, changed } = await resolveScriptPlugin(descriptor);
                const entry = {
                    plugin,
                    manifest: descriptor.manifest || null,
                };

                if (changed || !registeredPluginIds.has(descriptor.id)) {
                    await pluginManager.register(entry);
                    registeredPluginIds.add(descriptor.id);
                    activePluginIds.add(descriptor.id);
                }
            } catch (error) {
                scriptPluginCache.delete(descriptor.id);
                if (registeredPluginIds.has(descriptor.id)) {
                    await pluginManager.unregister(descriptor.id);
                    registeredPluginIds.delete(descriptor.id);
                    activePluginIds.delete(descriptor.id);
                }
                console.error(`[Cerebr] Failed to load shell script plugin "${descriptor.id}"`, error);
            }
        }

        for (const pluginId of [...scriptPluginCache.keys()]) {
            if (desiredScriptPluginIds.has(pluginId)) continue;

            scriptPluginCache.delete(pluginId);
            if (registeredPluginIds.has(pluginId)) {
                await pluginManager.unregister(pluginId);
            }
        }
    };

    const syncPlugins = ({ settings = null, developerMode = null } = {}) => {
        pluginSyncPromise = pluginSyncPromise
            .then(async () => {
                if (!started) return;

                developerModeEnabled = typeof developerMode === 'boolean'
                    ? developerMode
                    : await readDeveloperModePreference();
                const effectiveSettings = settings || await readPluginSettings();
                await applyPluginSettings(effectiveSettings);
            })
            .catch((error) => {
                console.error('[Cerebr] Failed to sync shell plugins', error);
            });

        return pluginSyncPromise;
    };

    const handleBridgeMessage = (event) => {
        if (!isPluginBridgeMessage(event?.data, 'shell')) return;

        const { command, payload = {} } = event.data;

        if (command === 'editor.focus') {
            editor.focus();
            return;
        }
        if (command === 'editor.setDraft') {
            editor.setDraft(payload.text);
            return;
        }
        if (command === 'editor.insertText') {
            editor.insertText(payload.text, payload.options || {});
            return;
        }
        if (command === 'editor.importText') {
            editor.importText(payload.text, {
                focus: payload.focus !== false,
                separator: payload.separator || '\n\n',
            });
        }
    };

    return {
        attachChatRuntime(chatRuntime = null) {
            chatRuntimeRef.current = chatRuntime;
        },
        async runBeforeSend(payload, context = {}) {
            const hookStates = [];
            const result = await pluginManager.runWaterfallHook('onBeforeSend', payload, (entry) => {
                const hookContext = createHookContext(entry, context);
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
            const hookResults = await pluginManager.collectHookResults('onBuildPrompt', (entry) => {
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
                fragments: [
                    ...collectPersistentPromptFragments(),
                    ...hookStates.flatMap((state) => state.directives.promptFragments),
                    ...dynamicFragments,
                ],
            };
        },
        async transformRequest(requestDescriptor, requestContext = {}) {
            const result = await pluginManager.runWaterfallHook('onRequest', requestDescriptor, (entry) => [
                createHookContext(entry, {
                    request: requestContext,
                }),
            ], {
                timeoutMs: 900,
            });
            return result.value;
        },
        async handleResponse(responseDescriptor, requestContext = {}) {
            await pluginManager.invokeHook('onResponse', (entry) => [
                responseDescriptor,
                createHookContext(entry, {
                    request: requestContext,
                }),
            ], {
                timeoutMs: 900,
            });
        },
        async handleRequestError(error, requestDescriptor, requestContext = {}) {
            await pluginManager.invokeHook('onRequestError', (entry) => [
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
            await pluginManager.invokeHook('onStreamChunk', (entry) => [
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
            await pluginManager.invokeHook('onResponseError', (entry) => {
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
            await pluginManager.invokeHook('onAfterResponse', (entry) => [
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
            await pluginManager.start();
            developerModeEnabled = await readDeveloperModePreference();
            await syncPlugins({
                settings: await readPluginSettings(),
                developerMode: developerModeEnabled,
            });
            unsubscribePluginSettings = subscribePluginSettings((settings) => {
                void syncPlugins({ settings });
            });
            unsubscribeDeveloperMode = subscribeDeveloperModePreference((enabled) => {
                void syncPlugins({ developerMode: enabled });
            });
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
            unsubscribePluginSettings?.();
            unsubscribePluginSettings = null;
            unsubscribeDeveloperMode?.();
            unsubscribeDeveloperMode = null;
            scriptPluginCache.clear();
            await pluginManager.stop();
            pluginResources.forEach((_, pluginId) => {
                cleanupPluginResources(pluginId);
            });
            pluginResources.clear();
        },
    };
}
