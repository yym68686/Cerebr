import { normalizeString } from '../core/runtime-utils.js';
import {
    createGuestMessage,
    GUEST_BOOT,
    GUEST_ERROR,
    GUEST_EVENT,
    GUEST_FRAME_READY,
    GUEST_READY,
    GUEST_RESIZE,
    GUEST_RPC_REQUEST,
    GUEST_RPC_RESPONSE,
    GUEST_SHUTDOWN,
    isGuestMessage,
} from './guest-protocol.js';
import {
    getActiveLocale as getHostLocale,
    onLocaleChanged as observeLocaleChanged,
} from '../../utils/i18n.js';
import { isExtensionRuntimeAvailable } from '../../utils/storage-adapter.js';

const GUEST_STORAGE_KEY_PREFIX = 'cerebr_guest_plugin_storage_v1_';
const GUEST_BOOT_TIMEOUT_MS = 8000;
const SHELL_PLUGIN_API_FACTORY_KEY = '__CEREBR_SHELL_PLUGIN_API_FACTORY__';
const SHELL_GUEST_HOST_API_FACTORY_KEY = '__CEREBR_SHELL_GUEST_HOST_API_FACTORY__';
const SHELL_PLUGIN_API_REGISTRY_KEY = '__CEREBR_SHELL_PLUGIN_API_REGISTRY__';
const GUEST_SERVICE_NAMES = Object.freeze([
    'shell',
    'browser',
    'chat',
    'editor',
    'storage',
    'i18n',
    'ui',
    'bridge',
]);
const LEGACY_GUEST_OVERLAY_OPTIONS = Object.freeze({
    width: 'min(1100px, calc(100vw - 24px))',
    maxWidth: 'calc(100vw - 24px)',
    height: 'min(820px, calc(100vh - 24px))',
    maxHeight: 'calc(100vh - 24px)',
    minHeight: '320px',
    fillHeight: true,
    dimBackground: true,
    blockBackground: true,
});

function getGuestPageUrl() {
    return new URL('./shell-plugin-guest.html', import.meta.url).toString();
}

function hasCallableMethod(target, methodNames = []) {
    return methodNames.some((methodName) => typeof target?.[methodName] === 'function');
}

function hasNamespacedGuestServices(target) {
    return GUEST_SERVICE_NAMES.some((serviceName) => {
        return target?.[serviceName] && typeof target[serviceName] === 'object';
    });
}

function hasGuestServiceKeys(target) {
    if (!target || typeof target !== 'object') {
        return false;
    }

    return GUEST_SERVICE_NAMES.some((serviceName) => {
        return Object.prototype.hasOwnProperty.call(target, serviceName);
    });
}

function normalizeGuestHostApi(api = {}) {
    const rootApi = api && typeof api === 'object' ? api : {};
    const nestedApi = rootApi?.api && typeof rootApi.api === 'object' ? rootApi.api : null;
    const nestedContext = rootApi?.context && typeof rootApi.context === 'object' ? rootApi.context : null;
    const fallbackApi = nestedApi || nestedContext || rootApi;

    if (hasNamespacedGuestServices(rootApi)) {
        return rootApi;
    }
    if (hasNamespacedGuestServices(nestedApi)) {
        return nestedApi;
    }
    if (hasNamespacedGuestServices(nestedContext)) {
        return nestedContext;
    }

    return {
        shell: hasCallableMethod(fallbackApi, [
            'mountInputAddon',
            'requestLayoutSync',
            'showModal',
            'updateModal',
            'hideModal',
            'openPage',
            'updatePage',
            'closePage',
            'observeTheme',
            'getThemeSnapshot',
            'setInputActions',
            'clearInputActions',
            'onInputAction',
            'setMenuItems',
            'clearMenuItems',
            'onMenuAction',
            'setSlashCommands',
            'clearSlashCommands',
            'onSlashCommandEvent',
            'isVisible',
            'open',
            'close',
            'toggle',
        ]) ? fallbackApi : undefined,
        browser: hasCallableMethod(fallbackApi, [
            'getCurrentTab',
        ]) ? fallbackApi : undefined,
        chat: hasCallableMethod(fallbackApi, [
            'abort',
            'sendDraft',
            'getCurrentChat',
            'getMessages',
        ]) ? fallbackApi : undefined,
        editor: hasCallableMethod(fallbackApi, [
            'clear',
            'focus',
            'getDraft',
            'getDraftSnapshot',
            'hasDraft',
            'importText',
            'insertText',
            'setDraft',
        ]) ? fallbackApi : undefined,
        storage: hasCallableMethod(fallbackApi, [
            'get',
            'set',
            'remove',
        ]) ? fallbackApi : undefined,
        i18n: hasCallableMethod(fallbackApi, [
            'getLocale',
            'getMessage',
            'onLocaleChanged',
        ]) ? fallbackApi : undefined,
        ui: hasCallableMethod(fallbackApi, [
            'showToast',
            'copyText',
        ]) ? fallbackApi : undefined,
        bridge: hasCallableMethod(fallbackApi, [
            'send',
        ]) ? fallbackApi : undefined,
    };
}

function coerceGuestHostApi(api = {}) {
    const rootApi = api && typeof api === 'object' ? api : {};
    if (hasNamespacedGuestServices(rootApi) || hasGuestServiceKeys(rootApi)) {
        return rootApi;
    }

    return normalizeGuestHostApi(rootApi);
}

function mergeGuestHostApis(primaryApi = {}, fallbackApi = {}) {
    const serviceNames = [
        'shell',
        'browser',
        'chat',
        'editor',
        'storage',
        'i18n',
        'ui',
        'bridge',
    ];

    return Object.fromEntries(
        serviceNames.map((serviceName) => [
            serviceName,
            primaryApi?.[serviceName] || fallbackApi?.[serviceName] || undefined,
        ])
    );
}

function normalizeSerializableError(error) {
    return {
        message: error?.message || String(error),
        stack: error?.stack ? String(error.stack) : '',
    };
}

function isMissingPermissionError(error) {
    return /requires permission/i.test(String(error?.message || ''));
}

function getGuestStorageKey(pluginId) {
    return `${GUEST_STORAGE_KEY_PREFIX}${pluginId}`;
}

function readGuestStorageSnapshot(pluginId) {
    if (!pluginId) {
        return {};
    }

    try {
        const raw = localStorage.getItem(getGuestStorageKey(pluginId));
        if (!raw) {
            return {};
        }

        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }

        return Object.fromEntries(
            Object.entries(parsed).map(([key, value]) => [String(key), String(value ?? '')])
        );
    } catch (error) {
        console.warn('[Cerebr] Failed to read guest plugin storage snapshot', error);
        return {};
    }
}

function writeGuestStorageSnapshot(pluginId, nextState) {
    if (!pluginId) {
        return true;
    }

    try {
        localStorage.setItem(getGuestStorageKey(pluginId), JSON.stringify(
            nextState && typeof nextState === 'object' && !Array.isArray(nextState)
                ? nextState
                : {}
        ));
        return true;
    } catch (error) {
        console.warn('[Cerebr] Failed to write guest plugin storage snapshot', error);
        return false;
    }
}

function mutateGuestStorage(pluginId, mutator) {
    const currentState = readGuestStorageSnapshot(pluginId);
    const nextState = { ...currentState };

    mutator(nextState);
    writeGuestStorageSnapshot(pluginId, nextState);
    return nextState;
}

export function createGuestShellPluginProxy(descriptor = {}) {
    const manifest = descriptor?.manifest && typeof descriptor.manifest === 'object'
        ? descriptor.manifest
        : {};
    const pluginId = normalizeString(manifest.id);
    const descriptorPluginApi = coerceGuestHostApi(
        descriptor?.runtime?.pluginApi && typeof descriptor.runtime.pluginApi === 'object'
            ? descriptor.runtime.pluginApi
            : {}
    );
    const descriptorCreateApi = typeof descriptor?.runtime?.createApi === 'function'
        ? descriptor.runtime.createApi
        : null;
    const resolveRegisteredPluginApi = () => coerceGuestHostApi(
        globalThis?.[SHELL_PLUGIN_API_REGISTRY_KEY]?.[pluginId]
            && typeof globalThis[SHELL_PLUGIN_API_REGISTRY_KEY][pluginId] === 'object'
            ? globalThis[SHELL_PLUGIN_API_REGISTRY_KEY][pluginId]
            : {}
    );

    return Object.freeze({
        id: pluginId,
        async setup(api) {
            const registeredPluginApi = resolveRegisteredPluginApi();
            let normalizedApi = mergeGuestHostApis(
                coerceGuestHostApi(api),
                descriptorPluginApi
            );
            const extensionRuntimeInvalidated = typeof chrome !== 'undefined'
                && !!chrome?.runtime
                && !isExtensionRuntimeAvailable();

            if (!normalizedApi.shell) {
                normalizedApi = mergeGuestHostApis(
                    normalizedApi,
                    registeredPluginApi
                );
            }

            if (!normalizedApi.shell) {
                const createGuestHostApi = globalThis?.[SHELL_GUEST_HOST_API_FACTORY_KEY];
                if (typeof createGuestHostApi === 'function') {
                    try {
                        normalizedApi = mergeGuestHostApis(
                            normalizedApi,
                            coerceGuestHostApi(createGuestHostApi({
                                plugin: {
                                    id: pluginId,
                                },
                                manifest,
                            }))
                        );
                    } catch (error) {
                        console.warn('[Cerebr] Failed to create direct guest host API for plugin', {
                            pluginId,
                            message: error?.message || String(error),
                        });
                    }
                }
            }

            if (!normalizedApi.shell) {
                const createPluginApi = descriptorCreateApi
                    || globalThis?.[SHELL_PLUGIN_API_FACTORY_KEY];
                if (typeof createPluginApi === 'function') {
                    try {
                        normalizedApi = mergeGuestHostApis(
                            normalizedApi,
                            coerceGuestHostApi(createPluginApi({
                                plugin: {
                                    id: pluginId,
                                },
                                manifest,
                            }))
                        );
                    } catch (error) {
                        console.warn('[Cerebr] Failed to create fallback shell API for guest plugin', {
                            pluginId,
                            message: error?.message || String(error),
                        });
                    }
                }
            }

            if (!normalizedApi.shell) {
                if (extensionRuntimeInvalidated) {
                    return () => {};
                }
                console.warn(
                    `[Cerebr] Guest shell plugin host did not receive a shell API `
                    + `(pluginId=${pluginId || 'unknown'}, `
                    + `apiKeys=${Object.keys(api && typeof api === 'object' ? api : {}).join(',') || 'none'}, `
                    + `descriptorShell=${descriptorPluginApi?.shell ? 'yes' : 'no'}, `
                    + `registryShell=${registeredPluginApi?.shell ? 'yes' : 'no'}, `
                    + `directFactory=${typeof globalThis?.[SHELL_GUEST_HOST_API_FACTORY_KEY] === 'function' ? 'yes' : 'no'}, `
                    + `factory=${typeof descriptorCreateApi === 'function' || typeof globalThis?.[SHELL_PLUGIN_API_FACTORY_KEY] === 'function' ? 'yes' : 'no'})`
                );
            }
            const host = createGuestShellPluginHost({
                descriptor,
                api: normalizedApi,
            });
            await host.start();
            return () => host.stop();
        },
    });
}

function createGuestShellPluginHost({
    descriptor = {},
    api = {},
} = {}) {
    const manifest = descriptor?.manifest && typeof descriptor.manifest === 'object'
        ? descriptor.manifest
        : {};
    const pluginId = normalizeString(manifest.id);
    const sessionId = `${pluginId || 'guest-plugin'}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    const currentThemeRef = {
        current: null,
    };
    const currentLocaleRef = {
        current: getHostLocale(),
    };
    const disposers = [];
    let iframe = null;
    let mountHandle = null;
    let hiddenRuntimeHost = null;
    let modalPresentationActive = false;
    let modalFillHeight = false;
    let pagePresentationActive = false;
    let pageRenderMode = '';
    let lastInlineHeight = 0;
    let started = false;

    function syncInlineFrameState(height = 0) {
        const normalizedHeight = Math.max(0, Math.ceil(Number(height) || 0));
        lastInlineHeight = normalizedHeight;
        const collapsed = normalizedHeight <= 0
            && !modalPresentationActive
            && !(pagePresentationActive && pageRenderMode === 'mount');

        iframe?.classList.toggle('cerebr-plugin-guest-frame--collapsed', collapsed);
        mountHandle?.element?.classList?.toggle?.('cerebr-plugin-slot-item--shell-input-addon-empty', collapsed);

        if (!iframe) {
            return;
        }

        if (collapsed) {
            iframe.style.height = '0px';
            return;
        }

        if (pagePresentationActive && pageRenderMode === 'mount') {
            iframe.style.height = '100%';
            return;
        }

        if (!modalPresentationActive || !modalFillHeight) {
            iframe.style.height = `${normalizedHeight}px`;
        }
    }

    function syncModalFrameState() {
        if (!iframe) {
            return;
        }

        iframe.classList.toggle(
            'cerebr-plugin-guest-frame--modal',
            modalPresentationActive && modalFillHeight
        );
        iframe.classList.toggle(
            'cerebr-plugin-guest-frame--overlay',
            false
        );
        iframe.style.height = modalPresentationActive && modalFillHeight
            ? '100%'
            : (iframe.classList.contains('cerebr-plugin-guest-frame--collapsed') ? '0px' : '');
    }

    function syncPageFrameState() {
        if (!iframe) {
            return;
        }

        iframe.classList.toggle(
            'cerebr-plugin-guest-frame--page',
            pagePresentationActive && pageRenderMode === 'mount'
        );
        if (pagePresentationActive && pageRenderMode === 'mount') {
            iframe.style.height = '100%';
        } else if (!modalPresentationActive || !modalFillHeight) {
            iframe.style.height = iframe.classList.contains('cerebr-plugin-guest-frame--collapsed')
                ? '0px'
                : `${lastInlineHeight}px`;
        }
    }

    function ensureHiddenRuntimeHost() {
        if (hiddenRuntimeHost?.isConnected) {
            return hiddenRuntimeHost;
        }

        const hostBody = document?.body;
        if (!(hostBody instanceof HTMLElement)) {
            throw new Error('Guest shell plugin could not create a hidden runtime host');
        }

        const container = document.createElement('div');
        container.className = 'cerebr-plugin-guest-frame-host cerebr-plugin-guest-frame-host--hidden';
        container.hidden = true;
        container.setAttribute('aria-hidden', 'true');
        container.style.position = 'fixed';
        container.style.inset = '0 auto auto 0';
        container.style.width = '0';
        container.style.height = '0';
        container.style.overflow = 'hidden';
        container.style.opacity = '0';
        container.style.pointerEvents = 'none';
        hostBody.appendChild(container);
        hiddenRuntimeHost = container;
        return container;
    }

    function mountGuestFrame() {
        if (typeof api.shell?.mountInputAddon === 'function') {
            try {
                mountHandle = api.shell.mountInputAddon(() => iframe, {
                    slotId: 'shell.input.row.after',
                    className: 'cerebr-plugin-slot-item--shell-input-addon-guest',
                });
                hiddenRuntimeHost?.remove?.();
                hiddenRuntimeHost = null;
                return;
            } catch (error) {
                if (!isMissingPermissionError(error)) {
                    throw error;
                }
            }
        }

        mountHandle = null;
        ensureHiddenRuntimeHost().replaceChildren(iframe);
    }

    async function requestLayoutSyncSafe() {
        try {
            await api.shell?.requestLayoutSync?.();
            return true;
        } catch (error) {
            if (isMissingPermissionError(error)) {
                return false;
            }
            throw error;
        }
    }

    async function invokeShellMethodForCleanup(methodName, args = []) {
        try {
            const method = api.shell?.[methodName];
            if (typeof method !== 'function') {
                return false;
            }
            await method(...args);
            return true;
        } catch (error) {
            if (isMissingPermissionError(error)) {
                return false;
            }
            throw error;
        }
    }

    async function showModal(options = {}) {
        modalPresentationActive = true;
        modalFillHeight = !!options?.fillHeight;
        syncModalFrameState();
        await api.shell?.showModal?.(options);
        await requestLayoutSyncSafe();
        return true;
    }

    async function updateModal(options = {}) {
        if (!modalPresentationActive) {
            return showModal(options);
        }

        if (Object.prototype.hasOwnProperty.call(options || {}, 'fillHeight')) {
            modalFillHeight = !!options?.fillHeight;
        }
        syncModalFrameState();
        await api.shell?.updateModal?.(options);
        await requestLayoutSyncSafe();
        return true;
    }

    async function hideModal() {
        modalPresentationActive = false;
        modalFillHeight = false;
        syncModalFrameState();
        syncPageFrameState();
        syncInlineFrameState(lastInlineHeight);
        await api.shell?.hideModal?.();
        await requestLayoutSyncSafe();
        return true;
    }

    async function openPage(page = {}) {
        pagePresentationActive = true;
        pageRenderMode = page && typeof page === 'object' && page.view && typeof page.view === 'object'
            ? 'host-view'
            : 'mount';
        syncPageFrameState();
        syncInlineFrameState(lastInlineHeight);
        await api.shell?.openPage?.(page);
        await requestLayoutSyncSafe();
        return true;
    }

    async function updatePage(page = {}) {
        if (!pagePresentationActive) {
            return openPage(page);
        }

        if (page && typeof page === 'object' && Object.prototype.hasOwnProperty.call(page, 'view')) {
            pageRenderMode = page.view && typeof page.view === 'object'
                ? 'host-view'
                : 'mount';
        }
        syncPageFrameState();
        syncInlineFrameState(lastInlineHeight);
        await api.shell?.updatePage?.(page);
        await requestLayoutSyncSafe();
        return true;
    }

    async function closePage(reason = 'programmatic') {
        pagePresentationActive = false;
        pageRenderMode = '';
        syncPageFrameState();
        syncInlineFrameState(lastInlineHeight);
        await api.shell?.closePage?.(reason);
        await requestLayoutSyncSafe();
        return true;
    }

    function postToGuest(kind, payload = {}) {
        if (!iframe?.contentWindow) {
            return false;
        }

        iframe.contentWindow.postMessage(
            createGuestMessage(kind, payload, sessionId),
            '*'
        );
        return true;
    }

    async function dispatchRpc(method, args = []) {
        switch (method) {
        case 'browser.getCurrentTab':
            return api.browser?.getCurrentTab?.() ?? null;
        case 'chat.abort':
            return api.chat?.abort?.() ?? false;
        case 'chat.sendDraft':
            return api.chat?.sendDraft?.() ?? false;
        case 'editor.clear':
            api.editor?.clear?.();
            return true;
        case 'editor.focus':
            api.editor?.focus?.();
            return true;
        case 'editor.getDraft':
            return api.editor?.getDraft?.() ?? '';
        case 'editor.getDraftSnapshot':
            return api.editor?.getDraftSnapshot?.() || {
                text: '',
                imageTags: [],
                empty: true,
            };
        case 'editor.hasDraft':
            return api.editor?.hasDraft?.() ?? false;
        case 'editor.importText':
            api.editor?.importText?.(args[0], args[1] && typeof args[1] === 'object' ? args[1] : {});
            return true;
        case 'editor.insertText':
            api.editor?.insertText?.(args[0], args[1] && typeof args[1] === 'object' ? args[1] : {});
            return true;
        case 'editor.setDraft':
            api.editor?.setDraft?.(args[0]);
            return true;
        case 'guestStorage.clear':
            mutateGuestStorage(pluginId, (state) => {
                Object.keys(state).forEach((key) => {
                    delete state[key];
                });
            });
            return true;
        case 'guestStorage.removeItem':
            mutateGuestStorage(pluginId, (state) => {
                delete state[String(args[0] ?? '')];
            });
            return true;
        case 'guestStorage.setItem':
            mutateGuestStorage(pluginId, (state) => {
                state[String(args[0] ?? '')] = String(args[1] ?? '');
            });
            return true;
        case 'i18n.getLocale':
            return currentLocaleRef.current || getHostLocale();
        case 'i18n.getMessage':
            return api.i18n?.getMessage?.(args[0], Array.isArray(args[1]) ? args[1] : args[1], args[2]) || '';
        case 'storage.get':
            return api.storage?.get?.(args[0], args[1] && typeof args[1] === 'object' ? args[1] : {}) || {};
        case 'storage.set':
            return api.storage?.set?.(args[0], args[1] && typeof args[1] === 'object' ? args[1] : {}) ?? false;
        case 'storage.remove':
            return api.storage?.remove?.(args[0], args[1] && typeof args[1] === 'object' ? args[1] : {}) ?? false;
        case 'shell.close':
            return api.shell?.close?.() ?? true;
        case 'shell.getThemeSnapshot':
            return currentThemeRef.current || api.shell?.getThemeSnapshot?.() || null;
        case 'shell.showModal':
            return showModal(args[0] && typeof args[0] === 'object' ? args[0] : {});
        case 'shell.updateModal':
            return updateModal(args[0] && typeof args[0] === 'object' ? args[0] : {});
        case 'shell.hideModal':
            return hideModal();
        case 'shell.enterOverlayPresentation':
            return showModal(LEGACY_GUEST_OVERLAY_OPTIONS);
        case 'shell.exitOverlayPresentation':
            return hideModal();
        case 'shell.isVisible':
            return api.shell?.isVisible?.() ?? true;
        case 'shell.open':
            return api.shell?.open?.() ?? true;
        case 'shell.setInputActions':
            return api.shell?.setInputActions?.(Array.isArray(args[0]) ? args[0] : []) ?? [];
        case 'shell.clearInputActions':
            return api.shell?.clearInputActions?.() ?? true;
        case 'shell.setSlashCommands':
            return api.shell?.setSlashCommands?.(
                Array.isArray(args[0]) ? args[0] : [],
                args[1] && typeof args[1] === 'object' ? args[1] : {}
            ) ?? [];
        case 'shell.clearSlashCommands':
            return api.shell?.clearSlashCommands?.() ?? true;
        case 'shell.setMenuItems':
            return api.shell?.setMenuItems?.(Array.isArray(args[0]) ? args[0] : []) ?? [];
        case 'shell.clearMenuItems':
            return api.shell?.clearMenuItems?.() ?? true;
        case 'shell.openPage':
            return openPage(args[0] && typeof args[0] === 'object' ? args[0] : {});
        case 'shell.updatePage':
            return updatePage(args[0] && typeof args[0] === 'object' ? args[0] : {});
        case 'shell.closePage':
            return closePage(normalizeString(args[0], 'programmatic'));
        case 'shell.requestLayoutSync':
            return api.shell?.requestLayoutSync?.() ?? true;
        case 'shell.toggle':
            return api.shell?.toggle?.() ?? true;
        case 'ui.showToast':
            api.ui?.showToast?.(args[0], args[1] && typeof args[1] === 'object' ? args[1] : {});
            return true;
        case 'ui.copyText':
            return api.ui?.copyText?.(args[0]) ?? false;
        case 'bridge.send':
            return api.bridge?.send?.(args[0], args[1], args[2] && typeof args[2] === 'object' ? args[2] : {});
        default:
            throw new Error(`Unsupported guest API method: ${method}`);
        }
    }

    function handleGuestMessage(event, resolveReady, rejectReady) {
        if (event.source !== iframe?.contentWindow || !isGuestMessage(event.data)) {
            return;
        }

        const { kind, payload = {} } = event.data;

        if (kind === GUEST_FRAME_READY) {
            postToGuest(GUEST_BOOT, {
                sessionId,
                manifest,
                theme: currentThemeRef.current || api.shell?.getThemeSnapshot?.() || null,
                locale: currentLocaleRef.current || getHostLocale(),
                storage: readGuestStorageSnapshot(pluginId),
            });
            return;
        }

        if (!isGuestMessage(event.data, sessionId)) {
            return;
        }

        if (kind === GUEST_READY) {
            resolveReady();
            return;
        }

        if (kind === GUEST_ERROR) {
            rejectReady(new Error(
                normalizeString(payload?.message, `Guest shell plugin "${pluginId}" failed to start`)
            ));
            return;
        }

        if (kind === GUEST_RESIZE) {
            syncInlineFrameState(payload?.height);
            void requestLayoutSyncSafe();
            return;
        }

        if (kind !== GUEST_RPC_REQUEST) {
            return;
        }

        const requestId = normalizeString(payload.requestId);
        const method = normalizeString(payload.method);
        const args = Array.isArray(payload.args) ? payload.args : [];

        void Promise.resolve()
            .then(() => dispatchRpc(method, args))
            .then((value) => {
                postToGuest(GUEST_RPC_RESPONSE, {
                    requestId,
                    ok: true,
                    value,
                });
            })
            .catch((error) => {
                postToGuest(GUEST_RPC_RESPONSE, {
                    requestId,
                    ok: false,
                    error: normalizeSerializableError(error),
                });
            });
    }

    async function start() {
        if (started) {
            return;
        }
        if (!pluginId) {
            throw new Error('Guest shell plugin is missing manifest.id');
        }

        started = true;
        iframe = document.createElement('iframe');
        iframe.className = 'cerebr-plugin-guest-frame';
        iframe.title = manifest.displayName || pluginId;
        iframe.setAttribute('aria-label', manifest.displayName || pluginId);
        iframe.setAttribute('scrolling', 'no');

        const onTheme = (snapshot) => {
            currentThemeRef.current = snapshot;
            postToGuest(GUEST_EVENT, {
                name: 'shell.theme',
                value: snapshot,
            });
        };
        const registerOptionalObserver = (subscribe) => {
            if (typeof subscribe !== 'function') {
                return false;
            }

            try {
                const unsubscribe = subscribe();
                if (typeof unsubscribe === 'function') {
                    disposers.push(unsubscribe);
                }
                return true;
            } catch (error) {
                if (isMissingPermissionError(error)) {
                    return false;
                }
                throw error;
            }
        };

        registerOptionalObserver(() => api.shell?.observeTheme?.(onTheme));

        registerOptionalObserver(() => api.i18n?.onLocaleChanged?.(({ locale } = {}) => {
            currentLocaleRef.current = normalizeString(locale, getHostLocale());
            postToGuest(GUEST_EVENT, {
                name: 'i18n.locale',
                value: {
                    locale: currentLocaleRef.current,
                },
            });
        }));

        registerOptionalObserver(() => api.shell?.onInputAction?.((event) => {
            postToGuest(GUEST_EVENT, {
                name: 'shell.inputAction',
                value: event,
            });
        }));

        registerOptionalObserver(() => api.shell?.onSlashCommandEvent?.((event) => {
            postToGuest(GUEST_EVENT, {
                name: 'shell.slashCommand',
                value: event,
            });
        }));

        registerOptionalObserver(() => api.shell?.onMenuAction?.((event) => {
            postToGuest(GUEST_EVENT, {
                name: 'shell.menuAction',
                value: event,
            });
        }));

        registerOptionalObserver(() => api.shell?.onPageEvent?.((event) => {
            if (event?.type === 'close') {
                pagePresentationActive = false;
                pageRenderMode = '';
                syncPageFrameState();
                syncInlineFrameState(lastInlineHeight);
            }
            postToGuest(GUEST_EVENT, {
                name: 'shell.pageEvent',
                value: event,
            });
        }));

        const readyPromise = new Promise((resolve, reject) => {
            const timeoutId = window.setTimeout(() => {
                reject(new Error(`Guest shell plugin "${pluginId}" timed out while starting`));
            }, GUEST_BOOT_TIMEOUT_MS);

            const handleMessage = (event) => {
                handleGuestMessage(
                    event,
                    () => {
                        window.clearTimeout(timeoutId);
                        resolve();
                    },
                    (error) => {
                        window.clearTimeout(timeoutId);
                        reject(error);
                    }
                );
            };

            window.addEventListener('message', handleMessage);
            disposers.push(() => {
                window.removeEventListener('message', handleMessage);
            });
        });

        iframe.src = getGuestPageUrl();
        mountGuestFrame();
        syncInlineFrameState(0);
        syncModalFrameState();

        try {
            await readyPromise;
            await requestLayoutSyncSafe();
        } catch (error) {
            await stop();
            throw error;
        }
    }

    async function stop() {
        if (!started) {
            return;
        }

        started = false;
        postToGuest(GUEST_SHUTDOWN, {});

        while (disposers.length > 0) {
            const dispose = disposers.pop();
            try {
                dispose?.();
            } catch (error) {
                console.error('[Cerebr] Failed to dispose guest shell plugin resource', error);
            }
        }

        try {
            await invokeShellMethodForCleanup('clearInputActions');
            await invokeShellMethodForCleanup('clearMenuItems');
            await invokeShellMethodForCleanup('closePage', ['stop']);
            await invokeShellMethodForCleanup('hideModal');
            await requestLayoutSyncSafe();
            mountHandle?.dispose?.();
        } catch (error) {
            console.error('[Cerebr] Failed to dispose guest shell plugin mount', error);
        }

        mountHandle = null;
        hiddenRuntimeHost?.remove?.();
        hiddenRuntimeHost = null;

        if (iframe?.parentElement) {
            iframe.parentElement.removeChild(iframe);
        }
        iframe = null;
    }

    return {
        start,
        stop,
    };
}
