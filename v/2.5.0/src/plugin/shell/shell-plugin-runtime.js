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
import { createPluginRuntimeContext } from '../core/plugin-runtime-context.js';
import {
    browserAdapter,
    isExtensionEnvironment,
    storageAdapter,
    syncStorageAdapter,
} from '../../utils/storage-adapter.js';
import { showToast } from '../../utils/ui.js';
import { createEditorController } from '../../runtime/input/editor-controller.js';
import { createSlotRegistry } from '../../runtime/ui/slot-registry.js';
import { createShellHostManager } from '../../runtime/ui/shell-host-manager.js';
import { getBuiltinShellPluginEntries } from './shell-plugin-registry.js';
import {
    getShellThemeSnapshot,
    observeShellTheme,
    requestShellLayoutSync,
} from './shell-host-utils.js';
import { createHostServiceRegistry } from '../services/host-service-registry.js';
import {
    createPluginRuntimeI18nApi,
    getActiveLocale as getHostLocale,
    onLocaleChanged as observeLocaleChanged,
    t as getI18nMessage,
} from '../../utils/i18n.js';

const SHELL_PLUGIN_API_FACTORY_KEY = '__CEREBR_SHELL_PLUGIN_API_FACTORY__';
const SHELL_GUEST_HOST_API_FACTORY_KEY = '__CEREBR_SHELL_GUEST_HOST_API_FACTORY__';
const CHAT_RENDER_SNAPSHOT_STYLE_URLS = Object.freeze([
    '../../../styles/base/variables.css',
    '../../../styles/base/reset.css',
    '../../../styles/utils/animations.css',
    '../../../styles/components/chat-container.css',
    '../../../styles/components/message.css',
    '../../../styles/components/reasoning.css',
    '../../../styles/components/image-tag.css',
    '../../../styles/components/code.css',
    '../../../../../htmd/styles/code.css',
    '../../../../../htmd/styles/math.css',
    '../../../../../htmd/styles/table.css',
]);

let chatRenderSnapshotStyleTextPromise = null;

function createPluginMeta(entry = {}) {
    return {
        id: normalizeString(entry?.plugin?.id),
        manifest: entry?.manifest ? { ...entry.manifest } : null,
    };
}

async function copyTextToClipboard(text) {
    const normalizedText = String(text ?? '');

    if (navigator?.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(normalizedText);
            return true;
        } catch {
            // Fall back to execCommand when the async clipboard API is unavailable.
        }
    }

    const hostBody = document?.body;
    if (!(hostBody instanceof HTMLElement)) {
        throw new Error('Clipboard is unavailable');
    }

    const textarea = document.createElement('textarea');
    const activeElement = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    textarea.value = normalizedText;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    hostBody.appendChild(textarea);
    textarea.focus();
    textarea.select();

    try {
        if (document.execCommand('copy')) {
            return true;
        }
    } finally {
        textarea.remove();
        activeElement?.focus?.();
    }

    throw new Error(document?.hasFocus?.()
        ? 'Clipboard is unavailable'
        : 'Document is not focused');
}

function stripCssImports(cssText = '') {
    return String(cssText ?? '').replace(/@import\s+[^;]+;\s*/g, '');
}

async function loadChatRenderSnapshotStyleText() {
    if (chatRenderSnapshotStyleTextPromise) {
        return chatRenderSnapshotStyleTextPromise;
    }

    chatRenderSnapshotStyleTextPromise = Promise.all(
        CHAT_RENDER_SNAPSHOT_STYLE_URLS.map(async (relativeUrl) => {
            const response = await fetch(new URL(relativeUrl, import.meta.url), {
                cache: 'no-store',
            });
            if (!response.ok) {
                throw new Error(`Failed to load snapshot style asset: ${relativeUrl}`);
            }
            return stripCssImports(await response.text());
        })
    )
        .then((styleTexts) => styleTexts.join('\n\n'))
        .catch((error) => {
            chatRenderSnapshotStyleTextPromise = null;
            throw error;
        });

    return chatRenderSnapshotStyleTextPromise;
}

function sanitizeRenderedTranscriptMessageNode(messageNode) {
    if (!(messageNode instanceof HTMLElement)) {
        return null;
    }

    const clone = messageNode.cloneNode(true);
    clone.classList.remove('updating', 'batch-load', 'show', 'is-editing');
    clone.removeAttribute('data-original-text');
    delete clone.dataset.seedId;
    delete clone.dataset.seedManaged;

    clone.querySelectorAll('.delete-btn').forEach((button) => button.remove());
    clone.querySelectorAll('.typing-indicator').forEach((indicator) => indicator.remove());
    clone.querySelectorAll('[data-original-text]').forEach((element) => {
        element.removeAttribute('data-original-text');
    });
    clone.querySelectorAll('[data-seed-id]').forEach((element) => {
        element.removeAttribute('data-seed-id');
    });
    clone.querySelectorAll('[data-seed-managed]').forEach((element) => {
        element.removeAttribute('data-seed-managed');
    });

    return clone;
}

async function createRenderedTranscriptSnapshot() {
    const chatContainer = document.getElementById('chat-container');
    let styleText = '';

    try {
        styleText = await loadChatRenderSnapshotStyleText();
    } catch (error) {
        console.warn('[Cerebr] Failed to load rendered transcript styles for snapshot export', error);
    }

    if (!(chatContainer instanceof HTMLElement)) {
        return {
            html: '',
            styleText,
            messageCount: 0,
            imageCount: 0,
        };
    }

    const messageNodes = Array.from(chatContainer.querySelectorAll('.message'))
        .map((messageNode) => sanitizeRenderedTranscriptMessageNode(messageNode))
        .filter(Boolean);

    const transcriptHost = document.createElement('div');
    messageNodes.forEach((messageNode) => {
        transcriptHost.appendChild(messageNode);
    });

    return {
        html: transcriptHost.innerHTML,
        styleText,
        messageCount: messageNodes.length,
        imageCount: transcriptHost.querySelectorAll('.message img').length,
    };
}

export function createShellPluginRuntime({
    messageInput,
    inputContainer = null,
    inputActionsContainer = null,
    menuItemsContainer = null,
    slashCommandsContainer = null,
    pageElements = {},
    slotContainers = {},
} = {}) {
    const editor = createEditorController({
        messageInput,
    });
    const slotRegistry = createSlotRegistry({
        slots: slotContainers,
    });
    const shellHostManager = createShellHostManager({
        messageInput,
        inputContainer,
        editor,
        inputActionsContainer,
        menuItemsContainer,
        slashCommandsContainer,
        pageElements,
        onLayoutSync: requestShellLayoutSync,
    });
    const chatRuntimeRef = {
        current: null,
    };
    const pluginResources = createPluginResourceStore({
        logger: console,
        createState: () => ({
            promptFragments: new Map(),
            latestInputAddonHandle: null,
        }),
        onCleanup(pluginId, resources) {
            resources?.promptFragments?.clear?.();
            shellHostManager.removePlugin(pluginId);
            if (resources) {
                resources.latestInputAddonHandle = null;
            }
            slotRegistry.unmountByPlugin(pluginId);
            requestShellLayoutSync();
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
                    permissions.assert('chat:current', ['chat:read']);
                }
                return chatRuntimeRef.current?.getCurrentChat?.() || null;
            },
            getMessages() {
                if (entry) {
                    permissions.assert('chat:messages', ['chat:read']);
                }
                return chatRuntimeRef.current?.getMessages?.() || [];
            },
            async getRenderedTranscript() {
                if (entry) {
                    permissions.assert('chat:messages', ['chat:read']);
                }
                return createRenderedTranscriptSnapshot();
            },
            sendDraft() {
                if (entry) {
                    permissions.assert('chat:send', ['chat:write']);
                }
                return chatRuntimeRef.current?.sendMessage?.() ?? false;
            },
            abort() {
                if (entry) {
                    permissions.assert('chat:abort', ['chat:write']);
                }
                chatRuntimeRef.current?.abortActiveReply?.();
                return true;
            },
            regenerate(messageElement) {
                if (entry) {
                    permissions.assert('chat:regenerate', ['chat:write']);
                }
                return chatRuntimeRef.current?.regenerateMessage?.(messageElement) ?? false;
            },
            retry(reason = '', options = {}) {
                if (entry) {
                    permissions.assert('chat:retry', ['chat:write']);
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
                    permissions.assert('chat:cancel', ['chat:write']);
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
                permissions.assert('prompt:fragments', ['prompt:extend', 'prompt:write']);
                const normalized = normalizePromptFragment(fragment, entry?.plugin?.id, entry?.manifest);
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
                    ...(materializePromptFragment(normalized, {
                        locale: getHostLocale(),
                        hostGetMessage(key, substitutions = [], fallback = '') {
                            const translated = getI18nMessage(key, substitutions);
                            return translated === key
                                ? normalizeString(fallback)
                                : translated;
                        },
                    }) || normalized),
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
                    .map((fragment) => materializePromptFragment(fragment, {
                        locale: getHostLocale(),
                        hostGetMessage(key, substitutions = [], fallback = '') {
                            const translated = getI18nMessage(key, substitutions);
                            return translated === key
                                ? normalizeString(fallback)
                                : translated;
                        },
                    }))
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
            copyText(text) {
                return copyTextToClipboard(text);
            },
            mountSlot(slotId, renderer, options = {}) {
                permissions.assert('ui:slots', ['ui:mount']);
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
                permissions.assert('tabs:query:active', ['tabs:query', 'tabs:read', 'tabs:active']);
                return browserAdapter.getCurrentTab();
            },
        };
    };

    const getStorageAreaName = (area = 'local') => normalizeString(area) === 'sync'
        ? 'sync'
        : 'local';

    const resolveStorageArea = (area = 'local') => getStorageAreaName(area) === 'sync'
        ? syncStorageAdapter
        : storageAdapter;

    const assertStoragePermission = (permissions, action, area = 'local') => {
        const areaName = getStorageAreaName(area);
        permissions.assert(`storage:${action}:${areaName}`, [
            `storage:${action}`,
            ...(areaName === 'local' ? ['storage:local'] : []),
        ]);
    };

    const createStorageApi = (entry = {}) => {
        const permissions = createPermissionController(entry);

        return {
            async get(keys, options = {}) {
                assertStoragePermission(permissions, 'read', options?.area);
                return resolveStorageArea(options?.area).get(keys);
            },
            async set(items, options = {}) {
                assertStoragePermission(permissions, 'write', options?.area);
                if (!items || typeof items !== 'object') {
                    return false;
                }
                await resolveStorageArea(options?.area).set(items);
                return true;
            },
            async remove(keys, options = {}) {
                assertStoragePermission(permissions, 'write', options?.area);
                await resolveStorageArea(options?.area).remove(keys);
                return true;
            },
        };
    };

    const createI18nApi = (entry = {}) => {
        return createPluginRuntimeI18nApi(entry, {
            getLocale() {
                return getHostLocale();
            },
            onLocaleChanged(callback, options = {}) {
                return observeLocaleChanged(callback, options);
            },
            hostGetMessage(key, substitutions = [], fallback = '') {
                const normalizedKey = normalizeString(key);
                if (!normalizedKey) {
                    return normalizeString(fallback);
                }

                const translated = getI18nMessage(normalizedKey, substitutions);
                if (translated === normalizedKey) {
                    return normalizeString(fallback, normalizedKey);
                }
                return translated;
            },
            addDisposer(pluginId, disposer) {
                pluginResources.addDisposer(pluginId, disposer);
            },
        });
    };

    const createPromptHookApi = (entry = {}, directives = null) => {
        const permissions = createPermissionController(entry);

        return {
            addFragment(fragment) {
                permissions.assert('prompt:fragments', ['prompt:extend', 'prompt:write']);
                const normalized = normalizePromptFragment(fragment, entry?.plugin?.id, entry?.manifest);
                if (!normalized || !directives?.promptFragments) {
                    return null;
                }

                directives.promptFragments.push(normalized);
                return materializePromptFragment(normalized, {
                    locale: getHostLocale(),
                    hostGetMessage(key, substitutions = [], fallback = '') {
                        const translated = getI18nMessage(key, substitutions);
                        return translated === key
                            ? normalizeString(fallback)
                            : translated;
                    },
                }) || normalized;
            },
        };
    };

    const createHookUiApi = () => ({
        showToast(message, options = {}) {
            showToast(String(message ?? ''), options);
        },
        copyText(text) {
            return copyTextToClipboard(text);
        },
        getAvailableSlots() {
            return slotRegistry.getAvailableSlots();
        },
    });

    const createEditorApi = (entry = {}) => {
        const permissions = createPermissionController(entry);

        return {
            focus() {
                permissions.assert('shell:input:write', ['shell:input']);
                return editor.focus();
            },
            blur() {
                permissions.assert('shell:input:write', ['shell:input']);
                return editor.blur();
            },
            getDraft() {
                permissions.assert('shell:input:read', ['shell:input']);
                return editor.getDraft();
            },
            getDraftSnapshot() {
                permissions.assert('shell:input:read', ['shell:input']);
                return editor.getDraftSnapshot();
            },
            hasDraft() {
                permissions.assert('shell:input:read', ['shell:input']);
                return editor.hasDraft();
            },
            setDraft(text) {
                permissions.assert('shell:input:write', ['shell:input']);
                return editor.setDraft(text);
            },
            insertText(text, options = {}) {
                permissions.assert('shell:input:write', ['shell:input']);
                return editor.insertText(text, options);
            },
            importText(text, options = {}) {
                permissions.assert('shell:input:write', ['shell:input']);
                return editor.importText(text, options);
            },
            clear() {
                permissions.assert('shell:input:write', ['shell:input']);
                return editor.clear();
            },
        };
    };

    const createShellApi = (entry = {}) => {
        const permissions = createPermissionController(entry);
        const pluginId = normalizeString(entry?.plugin?.id);

        const getLatestInputAddonHandle = () => {
            const resources = pluginResources.ensure(pluginId);
            return resources?.latestInputAddonHandle || null;
        };

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
                permissions.assert('shell:input:mount', ['shell:input', 'ui:mount']);
                const handle = slotRegistry.mount(
                    normalizeString(options.slotId, 'shell.input.after'),
                    pluginId,
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
                const resources = pluginResources.ensure(pluginId);
                resources.latestInputAddonHandle = handle;
                pluginResources.addDisposer(pluginId, () => {
                    if (resources.latestInputAddonHandle === handle) {
                        resources.latestInputAddonHandle = null;
                    }
                    handle.dispose();
                });
                requestShellLayoutSync();
                return handle;
            },
            setInputActions(actions = []) {
                permissions.assert('shell:input:actions', ['shell:input', 'ui:mount']);
                return shellHostManager.setInputActions(pluginId, actions);
            },
            clearInputActions() {
                permissions.assert('shell:input:actions', ['shell:input', 'ui:mount']);
                return shellHostManager.clearInputActions(pluginId);
            },
            onInputAction(callback) {
                permissions.assert('shell:input:actions', ['shell:input', 'ui:mount']);
                const unsubscribe = shellHostManager.onInputAction(pluginId, callback);
                pluginResources.addDisposer(pluginId, unsubscribe);
                return unsubscribe;
            },
            setMenuItems(items = []) {
                permissions.assert('shell:menu:items', ['shell:menu', 'ui:mount']);
                return shellHostManager.setMenuItems(pluginId, items);
            },
            clearMenuItems() {
                permissions.assert('shell:menu:items', ['shell:menu', 'ui:mount']);
                return shellHostManager.clearMenuItems(pluginId);
            },
            onMenuAction(callback) {
                permissions.assert('shell:menu:items', ['shell:menu', 'ui:mount']);
                const unsubscribe = shellHostManager.onMenuAction(pluginId, callback);
                pluginResources.addDisposer(pluginId, unsubscribe);
                return unsubscribe;
            },
            setSlashCommands(commands = [], options = {}) {
                permissions.assert('shell:input:slash-commands', ['shell:input', 'ui:mount']);
                return shellHostManager.setSlashCommands(
                    pluginId,
                    Array.isArray(commands) ? commands : [],
                    options && typeof options === 'object' ? options : {}
                );
            },
            clearSlashCommands() {
                permissions.assert('shell:input:slash-commands', ['shell:input', 'ui:mount']);
                return shellHostManager.clearSlashCommands(pluginId);
            },
            onSlashCommandEvent(callback) {
                permissions.assert('shell:input:slash-commands', ['shell:input', 'ui:mount']);
                const unsubscribe = shellHostManager.onSlashCommandEvent((event) => {
                    if (normalizeString(event?.pluginId) !== pluginId) {
                        return;
                    }
                    callback?.(event);
                });
                pluginResources.addDisposer(pluginId, unsubscribe);
                return unsubscribe;
            },
            showModal(options = {}) {
                permissions.assert('shell:input:modal', ['shell:input', 'ui:mount']);
                const targetHandle = getLatestInputAddonHandle();
                return shellHostManager.showModal(
                    pluginId,
                    targetHandle?.element,
                    options
                );
            },
            updateModal(options = {}) {
                permissions.assert('shell:input:modal', ['shell:input', 'ui:mount']);
                return shellHostManager.updateModal(pluginId, options);
            },
            hideModal() {
                permissions.assert('shell:input:modal', ['shell:input', 'ui:mount']);
                return shellHostManager.hideModal(pluginId);
            },
            openPage(page = {}) {
                permissions.assert('shell:page:control', ['shell:page', 'ui:mount']);
                const targetHandle = getLatestInputAddonHandle();
                return shellHostManager.openPage(
                    pluginId,
                    targetHandle?.element,
                    page
                );
            },
            updatePage(page = {}) {
                permissions.assert('shell:page:control', ['shell:page', 'ui:mount']);
                return shellHostManager.updatePage(pluginId, page);
            },
            closePage(reason = 'programmatic') {
                permissions.assert('shell:page:control', ['shell:page', 'ui:mount']);
                return shellHostManager.closePage(pluginId, normalizeString(reason, 'programmatic'));
            },
            onPageEvent(callback) {
                permissions.assert('shell:page:control', ['shell:page', 'ui:mount']);
                const unsubscribe = shellHostManager.onPageEvent(pluginId, callback);
                pluginResources.addDisposer(pluginId, unsubscribe);
                return unsubscribe;
            },
            observeTheme(callback, options = {}) {
                const unsubscribe = observeShellTheme(callback, options);
                pluginResources.addDisposer(pluginId, unsubscribe);
                return unsubscribe;
            },
            getThemeSnapshot() {
                return getShellThemeSnapshot();
            },
            requestLayoutSync() {
                permissions.assert('shell:input:layout', ['shell:input', 'ui:mount']);
                return requestShellLayoutSync();
            },
        };
    };

    const createBridgeApi = (entry = {}) => {
        const permissions = createPermissionController(entry);
        const sourcePluginId = normalizeString(entry?.plugin?.id);

        return {
            async send(target, command, payload = {}) {
                const normalizedTarget = normalizeString(target);
                if (!normalizedTarget) {
                    return {
                        success: false,
                        target: '',
                        error: 'Bridge target is unavailable',
                    };
                }
                permissions.assert(`bridge:send:${normalizedTarget}`, ['bridge:send']);
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

    const hostServiceRegistry = createHostServiceRegistry({
        editor: {
            createApi(entry) {
                return createEditorApi(entry);
            },
        },
        browser: {
            createApi: createBrowserApi,
        },
        chat: {
            createApi(entry) {
                return createChatHostApi(entry);
            },
            createContext(entry, { baseContext }) {
                return createChatHostApi(entry, {
                    allowDirectives: true,
                    directives: baseContext?.directives || null,
                });
            },
        },
        storage: {
            createApi: createStorageApi,
        },
        i18n: {
            createApi: createI18nApi,
        },
        prompt: {
            createApi: createPromptApi,
            createContext(entry, { baseContext }) {
                return createPromptHookApi(entry, baseContext?.directives || null);
            },
        },
        ui: {
            createApi: createUiApi,
            createContext() {
                return createHookUiApi();
            },
        },
        bridge: {
            createApi: createBridgeApi,
        },
        shell: {
            createApi: createShellApi,
        },
    });

    const createPluginApi = (entry = {}) => hostServiceRegistry.createPluginApi(entry);
    const createGuestHostApi = (entry = {}) => ({
        shell: createShellApi(entry),
        browser: createBrowserApi(entry),
        chat: createChatHostApi(entry),
        editor: createEditorApi(entry),
        storage: createStorageApi(entry),
        i18n: createI18nApi(entry),
        ui: createUiApi(entry),
        bridge: createBridgeApi(entry),
    });
    globalThis[SHELL_PLUGIN_API_FACTORY_KEY] = createPluginApi;
    globalThis[SHELL_GUEST_HOST_API_FACTORY_KEY] = createGuestHostApi;

    const createHookContext = (entry = {}, baseContext = {}) => {
        const directives = {
            retry: null,
            cancel: null,
            promptFragments: [],
        };
        const { context } = hostServiceRegistry.createHookContext(entry, {
            ...baseContext,
            directives,
        });

        return {
            ...context,
            plugin: createPluginMeta(entry),
            runtime: {
                host: 'shell',
                isExtension: isExtensionEnvironment,
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
                    host: 'shell',
                    isExtension: isExtensionEnvironment,
                },
            },
            host: 'shell',
        });
    };

    const runtimeController = createHostedPluginRuntime({
        host: 'shell',
        builtinEntries: getBuiltinShellPluginEntries(),
        declarativeScopes: ['shell', 'prompt'],
        createApi: createPluginApi,
        createPluginContext,
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
                .map(({ pluginId, value }) => {
                    const pluginEntry = runtimeController.pluginKernel.getPluginEntries?.()
                        ?.find?.((entry) => normalizeString(entry?.plugin?.id) === pluginId)
                        || null;
                    return normalizePromptFragment(value, pluginId, pluginEntry?.manifest || null);
                })
                .filter(Boolean);

            return {
                fragments: sortPromptFragments([
                    ...collectPersistentPromptFragments(),
                    ...hookStates.flatMap((state) => state.directives.promptFragments),
                    ...dynamicFragments,
                ])
                    .map((fragment) => materializePromptFragment(fragment, {
                        locale: getHostLocale(),
                        hostGetMessage(key, substitutions = [], fallback = '') {
                            const translated = getI18nMessage(key, substitutions);
                            return translated === key
                                ? normalizeString(fallback)
                                : translated;
                        },
                    }))
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
        getDiagnostics() {
            return runtimeController.pluginManager.getDiagnostics?.() || [];
        },
        dismissPage(reason = 'programmatic') {
            return shellHostManager.closeActivePage(normalizeString(reason, 'programmatic'));
        },
        hasOpenPage() {
            return shellHostManager.hasOpenPage();
        },
        async start() {
            if (started) return;
            started = true;

            window.addEventListener('message', handleBridgeMessage);
            messageInput?.addEventListener?.('input', scheduleInputHook);
            await runtimeController.start();
            await runtimeController.pluginManager.notifyEvent?.('shell.ready', {
                sticky: true,
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

            await runtimeController.stop();
            pluginResources.cleanupAll();
            if (globalThis[SHELL_PLUGIN_API_FACTORY_KEY] === createPluginApi) {
                delete globalThis[SHELL_PLUGIN_API_FACTORY_KEY];
            }
            if (globalThis[SHELL_GUEST_HOST_API_FACTORY_KEY] === createGuestHostApi) {
                delete globalThis[SHELL_GUEST_HOST_API_FACTORY_KEY];
            }
        },
    };
}
