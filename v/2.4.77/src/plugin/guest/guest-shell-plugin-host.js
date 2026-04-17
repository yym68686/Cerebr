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

const GUEST_STORAGE_KEY_PREFIX = 'cerebr_guest_plugin_storage_v1_';
const GUEST_BOOT_TIMEOUT_MS = 8000;

function getGuestPageUrl() {
    return new URL('./shell-plugin-guest.html', import.meta.url).toString();
}

function normalizeSerializableError(error) {
    return {
        message: error?.message || String(error),
        stack: error?.stack ? String(error.stack) : '',
    };
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

    return Object.freeze({
        id: pluginId,
        async setup(api) {
            const host = createGuestShellPluginHost({
                descriptor,
                api,
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
    const disposers = [];
    let iframe = null;
    let mountHandle = null;
    let started = false;

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
        case 'shell.close':
            return api.shell?.close?.() ?? true;
        case 'shell.getThemeSnapshot':
            return currentThemeRef.current || api.shell?.getThemeSnapshot?.() || null;
        case 'shell.isVisible':
            return api.shell?.isVisible?.() ?? true;
        case 'shell.open':
            return api.shell?.open?.() ?? true;
        case 'shell.requestLayoutSync':
            return api.shell?.requestLayoutSync?.() ?? true;
        case 'shell.toggle':
            return api.shell?.toggle?.() ?? true;
        case 'ui.showToast':
            api.ui?.showToast?.(args[0], args[1] && typeof args[1] === 'object' ? args[1] : {});
            return true;
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
            const height = Math.max(0, Math.ceil(Number(payload?.height) || 0));
            if (iframe) {
                iframe.style.height = `${height}px`;
            }
            api.shell?.requestLayoutSync?.();
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
        if (typeof api.shell?.mountInputAddon !== 'function') {
            throw new Error('Shell guest plugins require shell.mountInputAddon() support');
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
        const stopObservingTheme = api.shell.observeTheme?.(onTheme);
        if (typeof stopObservingTheme === 'function') {
            disposers.push(stopObservingTheme);
        }

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
        mountHandle = api.shell.mountInputAddon(() => iframe, {
            slotId: 'shell.input.after',
            className: 'cerebr-plugin-slot-item--shell-input-addon-guest',
        });

        try {
            await readyPromise;
            api.shell?.requestLayoutSync?.();
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
            mountHandle?.dispose?.();
        } catch (error) {
            console.error('[Cerebr] Failed to dispose guest shell plugin mount', error);
        }

        mountHandle = null;

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
