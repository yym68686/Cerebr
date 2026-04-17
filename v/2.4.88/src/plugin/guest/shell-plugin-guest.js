import { loadScriptPluginModule } from '../dev/script-plugin-loader.js';
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

const guestRoot = document.getElementById('cerebr-plugin-guest-root');
const state = {
    cleanup: null,
    currentLocale: '',
    currentTheme: null,
    inputActionWatchers: new Set(),
    localeWatchers: new Set(),
    menuActionWatchers: new Set(),
    pendingRpc: new Map(),
    pageEventWatchers: new Set(),
    resizeObserver: null,
    resizeRaf: 0,
    rpcCounter: 0,
    sessionId: '',
    slashCommandWatchers: new Set(),
    themeWatchers: new Set(),
};

function postToParent(kind, payload = {}) {
    window.parent?.postMessage?.(
        createGuestMessage(kind, payload, state.sessionId),
        '*'
    );
}

function normalizeSerializableError(error) {
    return {
        message: error?.message || String(error),
        stack: error?.stack ? String(error.stack) : '',
    };
}

function cloneSimpleObject(value, fallback = null) {
    if (!value || typeof value !== 'object') {
        return fallback;
    }

    return JSON.parse(JSON.stringify(value));
}

function applyThemeSnapshot(snapshot) {
    state.currentTheme = snapshot && typeof snapshot === 'object'
        ? {
            themePreference: String(snapshot.themePreference || 'system'),
            isDark: !!snapshot.isDark,
        }
        : {
            themePreference: 'system',
            isDark: false,
        };

    const root = document.documentElement;
    root.classList.remove('dark-theme', 'light-theme');

    if (state.currentTheme.themePreference === 'dark') {
        root.classList.add('dark-theme');
    } else if (state.currentTheme.themePreference === 'light') {
        root.classList.add('light-theme');
    }

    root.dataset.themePreference = state.currentTheme.themePreference;

    state.themeWatchers.forEach((callback) => {
        try {
            callback(cloneSimpleObject(state.currentTheme, null));
        } catch (error) {
            console.warn('[Cerebr] Guest theme watcher failed', error);
        }
    });
}

function applyLocaleSnapshot(snapshot) {
    const locale = typeof snapshot === 'string'
        ? snapshot
        : String(snapshot?.locale || '');
    state.currentLocale = locale || 'en';

    state.localeWatchers.forEach((callback) => {
        try {
            callback({
                locale: state.currentLocale,
            });
        } catch (error) {
            console.warn('[Cerebr] Guest locale watcher failed', error);
        }
    });
}

function ensureResizeObserver() {
    if (state.resizeObserver || typeof ResizeObserver !== 'function') {
        return;
    }

    state.resizeObserver = new ResizeObserver(() => {
        scheduleResizeReport();
    });
    state.resizeObserver.observe(document.documentElement);
    if (guestRoot) {
        state.resizeObserver.observe(guestRoot);
    }
}

function scheduleResizeReport() {
    if (state.resizeRaf) {
        return;
    }

    state.resizeRaf = requestAnimationFrame(() => {
        state.resizeRaf = 0;
        const bodyHeight = document.body?.scrollHeight || 0;
        const rootHeight = guestRoot?.scrollHeight || 0;
        const nextHeight = Math.max(0, Math.ceil(Math.max(bodyHeight, rootHeight)));

        postToParent(GUEST_RESIZE, {
            height: nextHeight,
        });
    });
}

function createRpcRequest(method, args = []) {
    return new Promise((resolve, reject) => {
        const requestId = `guest-rpc-${++state.rpcCounter}`;
        state.pendingRpc.set(requestId, {
            resolve,
            reject,
        });

        postToParent(GUEST_RPC_REQUEST, {
            requestId,
            method,
            args,
        });
    });
}

function createGuestStorage(snapshot = {}) {
    const data = new Map(
        Object.entries(snapshot && typeof snapshot === 'object' ? snapshot : {})
            .map(([key, value]) => [String(key), String(value ?? '')])
    );

    return {
        clear() {
            data.clear();
            void createRpcRequest('guestStorage.clear');
        },
        getItem(key) {
            const normalizedKey = String(key ?? '');
            return data.has(normalizedKey) ? data.get(normalizedKey) : null;
        },
        key(index) {
            const keys = Array.from(data.keys());
            return Number.isInteger(index) && index >= 0 && index < keys.length ? keys[index] : null;
        },
        removeItem(key) {
            const normalizedKey = String(key ?? '');
            data.delete(normalizedKey);
            void createRpcRequest('guestStorage.removeItem', [normalizedKey]);
        },
        setItem(key, value) {
            const normalizedKey = String(key ?? '');
            const normalizedValue = String(value ?? '');
            data.set(normalizedKey, normalizedValue);
            void createRpcRequest('guestStorage.setItem', [normalizedKey, normalizedValue]);
        },
        get length() {
            return data.size;
        },
    };
}

function installLocalStorageShim(snapshot = {}) {
    const storage = createGuestStorage(snapshot);

    try {
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            enumerable: true,
            value: storage,
        });
    } catch (error) {
        try {
            Object.defineProperty(window, 'localStorage', {
                configurable: true,
                enumerable: true,
                value: storage,
            });
        } catch (fallbackError) {
            console.warn('[Cerebr] Failed to override guest localStorage', fallbackError || error);
        }
    }

    return storage;
}

function createGuestShellApi() {
    return {
        isVisible() {
            return createRpcRequest('shell.isVisible');
        },
        open() {
            return createRpcRequest('shell.open');
        },
        close() {
            return createRpcRequest('shell.close');
        },
        toggle() {
            return createRpcRequest('shell.toggle');
        },
        mountInputAddon() {
            scheduleResizeReport();
            return guestRoot;
        },
        setInputActions(actions = []) {
            return createRpcRequest('shell.setInputActions', [Array.isArray(actions) ? actions : []]);
        },
        clearInputActions() {
            return createRpcRequest('shell.clearInputActions');
        },
        setSlashCommands(commands = [], options = {}) {
            return createRpcRequest('shell.setSlashCommands', [
                Array.isArray(commands) ? commands : [],
                options && typeof options === 'object' ? options : {},
            ]);
        },
        clearSlashCommands() {
            return createRpcRequest('shell.clearSlashCommands');
        },
        onInputAction(callback) {
            if (typeof callback !== 'function') {
                return () => {};
            }

            state.inputActionWatchers.add(callback);
            return () => {
                state.inputActionWatchers.delete(callback);
            };
        },
        onSlashCommandEvent(callback) {
            if (typeof callback !== 'function') {
                return () => {};
            }

            state.slashCommandWatchers.add(callback);
            return () => {
                state.slashCommandWatchers.delete(callback);
            };
        },
        setMenuItems(items = []) {
            return createRpcRequest('shell.setMenuItems', [Array.isArray(items) ? items : []]);
        },
        clearMenuItems() {
            return createRpcRequest('shell.clearMenuItems');
        },
        onMenuAction(callback) {
            if (typeof callback !== 'function') {
                return () => {};
            }

            state.menuActionWatchers.add(callback);
            return () => {
                state.menuActionWatchers.delete(callback);
            };
        },
        showModal(options = {}) {
            scheduleResizeReport();
            return createRpcRequest('shell.showModal', [options]);
        },
        updateModal(options = {}) {
            scheduleResizeReport();
            return createRpcRequest('shell.updateModal', [options]);
        },
        hideModal() {
            return createRpcRequest('shell.hideModal');
        },
        enterOverlayPresentation() {
            return createRpcRequest('shell.enterOverlayPresentation');
        },
        exitOverlayPresentation() {
            return createRpcRequest('shell.exitOverlayPresentation');
        },
        openPage(page = {}) {
            scheduleResizeReport();
            return createRpcRequest('shell.openPage', [page]);
        },
        updatePage(page = {}) {
            scheduleResizeReport();
            return createRpcRequest('shell.updatePage', [page]);
        },
        closePage(reason = 'programmatic') {
            return createRpcRequest('shell.closePage', [reason]);
        },
        onPageEvent(callback) {
            if (typeof callback !== 'function') {
                return () => {};
            }

            state.pageEventWatchers.add(callback);
            return () => {
                state.pageEventWatchers.delete(callback);
            };
        },
        requestLayoutSync() {
            scheduleResizeReport();
            return createRpcRequest('shell.requestLayoutSync');
        },
        observeTheme(callback, { immediate = true } = {}) {
            if (typeof callback !== 'function') {
                return () => {};
            }

            state.themeWatchers.add(callback);
            if (immediate && state.currentTheme) {
                callback(cloneSimpleObject(state.currentTheme, null));
            }

            return () => {
                state.themeWatchers.delete(callback);
            };
        },
        getThemeSnapshot() {
            return cloneSimpleObject(state.currentTheme, null);
        },
    };
}

function createGuestPluginApi() {
    return {
        browser: {
            getCurrentTab() {
                return createRpcRequest('browser.getCurrentTab');
            },
        },
        i18n: {
            getLocale() {
                return state.currentLocale || createRpcRequest('i18n.getLocale');
            },
            getMessage(key, substitutions = [], fallback = '') {
                return createRpcRequest('i18n.getMessage', [key, substitutions, fallback]);
            },
            onLocaleChanged(callback, { immediate = true } = {}) {
                if (typeof callback !== 'function') {
                    return () => {};
                }

                state.localeWatchers.add(callback);
                if (immediate && state.currentLocale) {
                    callback({
                        locale: state.currentLocale,
                    });
                }

                return () => {
                    state.localeWatchers.delete(callback);
                };
            },
        },
        bridge: {
            send(target, command, payload = {}) {
                return createRpcRequest('bridge.send', [target, command, payload]);
            },
        },
        chat: {
            abort() {
                return createRpcRequest('chat.abort');
            },
            sendDraft() {
                return createRpcRequest('chat.sendDraft');
            },
        },
        editor: {
            clear() {
                return createRpcRequest('editor.clear');
            },
            focus() {
                return createRpcRequest('editor.focus');
            },
            getDraft() {
                return createRpcRequest('editor.getDraft');
            },
            getDraftSnapshot() {
                return createRpcRequest('editor.getDraftSnapshot');
            },
            hasDraft() {
                return createRpcRequest('editor.hasDraft');
            },
            importText(text, options = {}) {
                return createRpcRequest('editor.importText', [text, options]);
            },
            insertText(text, options = {}) {
                return createRpcRequest('editor.insertText', [text, options]);
            },
            setDraft(text) {
                return createRpcRequest('editor.setDraft', [text]);
            },
        },
        storage: {
            get(keys, options = {}) {
                return createRpcRequest('storage.get', [keys, options]);
            },
            set(items, options = {}) {
                return createRpcRequest('storage.set', [items, options]);
            },
            remove(keys, options = {}) {
                return createRpcRequest('storage.remove', [keys, options]);
            },
        },
        shell: createGuestShellApi(),
        ui: {
            showToast(message, options = {}) {
                return createRpcRequest('ui.showToast', [message, options]);
            },
            copyText(text) {
                return createRpcRequest('ui.copyText', [text]);
            },
        },
    };
}

function createGuestDescriptor(manifest) {
    const normalizedSource = manifest?.source && typeof manifest.source === 'object'
        ? {
            ...manifest.source,
            mode: 'bundle',
        }
        : {
            mode: 'bundle',
        };

    return {
        manifest: {
            ...manifest,
            source: normalizedSource,
        },
        runtime: {
            disableGuestProxy: true,
            moduleUrlStrategy: 'data',
        },
        record: {
            updatedAt: Date.now(),
        },
    };
}

async function bootGuestPlugin(payload = {}) {
    state.sessionId = String(payload.sessionId || '');
    installLocalStorageShim(payload.storage);
    applyLocaleSnapshot(payload.locale);
    applyThemeSnapshot(payload.theme);
    ensureResizeObserver();

    const descriptor = createGuestDescriptor(payload.manifest);
    const plugin = await loadScriptPluginModule(descriptor);
    const cleanup = await plugin.setup(createGuestPluginApi());
    state.cleanup = typeof cleanup === 'function'
        ? cleanup
        : (cleanup && typeof cleanup.dispose === 'function' ? cleanup.dispose.bind(cleanup) : null);

    scheduleResizeReport();
    postToParent(GUEST_READY, {});
}

async function shutdownGuestPlugin() {
    const cleanup = state.cleanup;
    state.cleanup = null;

    while (state.pendingRpc.size > 0) {
        const [requestId, pending] = state.pendingRpc.entries().next().value;
        state.pendingRpc.delete(requestId);
        pending.reject(new Error('Guest plugin was stopped'));
    }

    state.resizeObserver?.disconnect?.();
    state.resizeObserver = null;

    if (state.resizeRaf) {
        cancelAnimationFrame(state.resizeRaf);
        state.resizeRaf = 0;
    }

    if (typeof cleanup === 'function') {
        await cleanup();
    }

    state.inputActionWatchers.clear();
    state.localeWatchers.clear();
    state.menuActionWatchers.clear();
    state.pageEventWatchers.clear();
    state.slashCommandWatchers.clear();
    state.themeWatchers.clear();
}

window.addEventListener('message', (event) => {
    if (!isGuestMessage(event.data)) {
        return;
    }

    const { kind, payload = {} } = event.data;
    if (kind !== GUEST_BOOT && (!state.sessionId || !isGuestMessage(event.data, state.sessionId))) {
        return;
    }

    if (kind === GUEST_BOOT) {
        void bootGuestPlugin(payload).catch((error) => {
            postToParent(GUEST_ERROR, normalizeSerializableError(error));
        });
        return;
    }

    if (kind === GUEST_EVENT && payload?.name === 'shell.theme') {
        applyThemeSnapshot(payload.value);
        scheduleResizeReport();
        return;
    }

    if (kind === GUEST_EVENT && payload?.name === 'i18n.locale') {
        applyLocaleSnapshot(payload.value);
        return;
    }

    if (kind === GUEST_EVENT && payload?.name === 'shell.inputAction') {
        const eventValue = cloneSimpleObject(payload.value, null);
        state.inputActionWatchers.forEach((callback) => {
            try {
                callback(eventValue);
            } catch (error) {
                console.warn('[Cerebr] Guest input action watcher failed', error);
            }
        });
        return;
    }

    if (kind === GUEST_EVENT && payload?.name === 'shell.slashCommand') {
        const eventValue = cloneSimpleObject(payload.value, null);
        state.slashCommandWatchers.forEach((callback) => {
            try {
                callback(eventValue);
            } catch (error) {
                console.warn('[Cerebr] Guest slash command watcher failed', error);
            }
        });
        return;
    }

    if (kind === GUEST_EVENT && payload?.name === 'shell.menuAction') {
        const eventValue = cloneSimpleObject(payload.value, null);
        state.menuActionWatchers.forEach((callback) => {
            try {
                callback(eventValue);
            } catch (error) {
                console.warn('[Cerebr] Guest menu action watcher failed', error);
            }
        });
        return;
    }

    if (kind === GUEST_EVENT && payload?.name === 'shell.pageEvent') {
        const eventValue = cloneSimpleObject(payload.value, null);
        state.pageEventWatchers.forEach((callback) => {
            try {
                callback(eventValue);
            } catch (error) {
                console.warn('[Cerebr] Guest page watcher failed', error);
            }
        });
        return;
    }

    if (kind === GUEST_RPC_RESPONSE) {
        const pending = state.pendingRpc.get(String(payload.requestId || ''));
        if (!pending) {
            return;
        }

        state.pendingRpc.delete(String(payload.requestId || ''));
        if (payload.ok) {
            pending.resolve(payload.value);
        } else {
            pending.reject(new Error(payload?.error?.message || 'Guest RPC failed'));
        }
        return;
    }

    if (kind === GUEST_SHUTDOWN) {
        void shutdownGuestPlugin();
    }
});

postToParent(GUEST_FRAME_READY, {});
