import { loadScriptPluginModule } from '../dev/script-plugin-loader.js';
import {
    createGuestMessage,
    GUEST_BOOT,
    GUEST_ERROR,
    GUEST_EVENT,
    GUEST_FRAME_READY,
    GUEST_READY,
    GUEST_RPC_REQUEST,
    GUEST_RPC_RESPONSE,
    GUEST_SHUTDOWN,
    isGuestMessage,
} from './guest-protocol.js';

const state = {
    actionCallbacks: new Map(),
    cleanup: null,
    currentSelection: null,
    pendingRpc: new Map(),
    rpcCounter: 0,
    selectionWatchers: new Set(),
    sessionId: '',
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

function applySelectionSnapshot(snapshot) {
    state.currentSelection = snapshot && typeof snapshot === 'object'
        ? cloneSimpleObject(snapshot, null)
        : null;

    state.selectionWatchers.forEach((callback) => {
        try {
            callback(cloneSimpleObject(state.currentSelection, null));
        } catch (error) {
            console.warn('[Cerebr] Guest page selection watcher failed', error);
        }
    });
}

function createRpcRequest(method, args = []) {
    return new Promise((resolve, reject) => {
        const requestId = `page-guest-rpc-${++state.rpcCounter}`;
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

function createGuestExtractorHandle(handleId, definition = {}) {
    return {
        ...definition,
        dispose() {
            return createRpcRequest('page.disposeExtractor', [handleId]);
        },
    };
}

function createGuestAnchoredActionHandle(handleId, actionId) {
    return {
        update(nextConfig = {}) {
            if (typeof nextConfig?.onClick === 'function') {
                state.actionCallbacks.set(actionId, nextConfig.onClick);
            }
            const serializableConfig = {
                ...(nextConfig && typeof nextConfig === 'object' ? nextConfig : {}),
                __actionId: actionId,
            };
            delete serializableConfig.onClick;
            return createRpcRequest('ui.updateAnchoredAction', [handleId, serializableConfig]);
        },
        dispose() {
            state.actionCallbacks.delete(actionId);
            return createRpcRequest('ui.disposeAnchoredAction', [handleId]);
        },
    };
}

function createGuestPluginApi() {
    return {
        page: {
            getSelection() {
                return state.currentSelection || createRpcRequest('page.getSelection');
            },
            getSelectedText() {
                return createRpcRequest('page.getSelectedText');
            },
            watchSelection(callback, { immediate = true } = {}) {
                if (typeof callback !== 'function') {
                    return () => {};
                }

                state.selectionWatchers.add(callback);
                if (immediate && state.currentSelection) {
                    callback(cloneSimpleObject(state.currentSelection, null));
                }

                return () => {
                    state.selectionWatchers.delete(callback);
                };
            },
            clearSelection() {
                return createRpcRequest('page.clearSelection');
            },
            getSnapshot(options = {}) {
                return createRpcRequest('page.getSnapshot', [options]);
            },
            getMessage(key, substitutions = [], fallback = '') {
                return createRpcRequest('page.getMessage', [key, substitutions, fallback]);
            },
            listExtractors() {
                return createRpcRequest('page.listExtractors');
            },
            async registerExtractor(definition = {}) {
                const result = await createRpcRequest('page.registerExtractor', [definition]);
                if (!result?.handleId) {
                    return null;
                }
                return createGuestExtractorHandle(result.handleId, result);
            },
        },
        site: {
            click(selector) {
                return createRpcRequest('site.click', [selector]);
            },
            fill(selector, value) {
                return createRpcRequest('site.fill', [selector, value]);
            },
        },
        ui: {
            async showAnchoredAction(config = {}) {
                const actionId = `anchored-action:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
                if (typeof config?.onClick === 'function') {
                    state.actionCallbacks.set(actionId, config.onClick);
                }
                const serializableConfig = {
                    ...(config && typeof config === 'object' ? config : {}),
                    __actionId: actionId,
                };
                delete serializableConfig.onClick;
                const result = await createRpcRequest('ui.showAnchoredAction', [serializableConfig]);
                if (!result?.handleId) {
                    return {
                        update() {},
                        dispose() {
                            state.actionCallbacks.delete(actionId);
                        },
                    };
                }
                return createGuestAnchoredActionHandle(result.handleId, actionId);
            },
        },
        bridge: {
            send(target, command, payload = {}) {
                return createRpcRequest('bridge.send', [target, command, payload]);
            },
        },
        shell: {
            isOpen() {
                return createRpcRequest('shell.isOpen');
            },
            open() {
                return createRpcRequest('shell.open');
            },
            toggle() {
                return createRpcRequest('shell.toggle');
            },
            focusInput() {
                return createRpcRequest('shell.focusInput');
            },
            setDraft(text) {
                return createRpcRequest('shell.setDraft', [text]);
            },
            insertText(text, options = {}) {
                return createRpcRequest('shell.insertText', [text, options]);
            },
            importText(text, options = {}) {
                return createRpcRequest('shell.importText', [text, options]);
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
    applySelectionSnapshot(payload.selection);

    const descriptor = createGuestDescriptor(payload.manifest);
    const plugin = await loadScriptPluginModule(descriptor);
    const cleanup = await plugin.setup(createGuestPluginApi());
    state.cleanup = typeof cleanup === 'function'
        ? cleanup
        : (cleanup && typeof cleanup.dispose === 'function' ? cleanup.dispose.bind(cleanup) : null);

    postToParent(GUEST_READY, {});
}

async function shutdownGuestPlugin() {
    const cleanup = state.cleanup;
    state.cleanup = null;

    while (state.pendingRpc.size > 0) {
        const [requestId, pending] = state.pendingRpc.entries().next().value;
        state.pendingRpc.delete(requestId);
        pending.reject(new Error('Guest page plugin was stopped'));
    }

    state.actionCallbacks.clear();
    state.selectionWatchers.clear();

    if (typeof cleanup === 'function') {
        await cleanup();
    }
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
        bootGuestPlugin(payload).catch((error) => {
            postToParent(GUEST_ERROR, normalizeSerializableError(error));
        });
        return;
    }

    if (kind === GUEST_EVENT && payload?.name === 'page.selection') {
        applySelectionSnapshot(payload.value);
        return;
    }

    if (kind === GUEST_EVENT && payload?.name === 'ui.anchoredAction.click') {
        const actionId = String(payload?.value?.actionId || '');
        const callback = state.actionCallbacks.get(actionId);
        if (typeof callback === 'function') {
            try {
                callback();
            } catch (error) {
                console.warn('[Cerebr] Guest anchored action callback failed', error);
            }
        }
        return;
    }

    if (kind === GUEST_RPC_RESPONSE) {
        const requestId = String(payload.requestId || '');
        const pending = state.pendingRpc.get(requestId);
        if (!pending) {
            return;
        }

        state.pendingRpc.delete(requestId);
        if (payload.ok === false) {
            pending.reject(new Error(String(payload?.error?.message || 'Guest page RPC failed')));
            return;
        }

        pending.resolve(payload.value);
        return;
    }

    if (kind === GUEST_SHUTDOWN) {
        void shutdownGuestPlugin();
    }
});

postToParent(GUEST_FRAME_READY, {});
