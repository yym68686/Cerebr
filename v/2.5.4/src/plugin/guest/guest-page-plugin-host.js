import { normalizeString } from '../core/runtime-utils.js';
import {
    getActiveLocale as getHostLocale,
    onLocaleChanged as observeLocaleChanged,
} from '../../utils/i18n.js';
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

const GUEST_BOOT_TIMEOUT_MS = 8000;

function getGuestPageUrl() {
    return new URL('./page-plugin-guest.html', import.meta.url).toString();
}

function normalizeSerializableError(error) {
    return {
        message: error?.message || String(error),
        stack: error?.stack ? String(error.stack) : '',
    };
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

export function createGuestPagePluginProxy(descriptor = {}) {
    const manifest = descriptor?.manifest && typeof descriptor.manifest === 'object'
        ? descriptor.manifest
        : {};
    const pluginId = normalizeString(manifest.id);

    return Object.freeze({
        id: pluginId,
        async setup(api) {
            const host = createGuestPagePluginHost({
                descriptor,
                api,
            });
            await host.start();
            return () => host.stop();
        },
    });
}

function createGuestPagePluginHost({
    descriptor = {},
    api = {},
} = {}) {
    const manifest = descriptor?.manifest && typeof descriptor.manifest === 'object'
        ? descriptor.manifest
        : {};
    const pluginId = normalizeString(manifest.id);
    const sessionId = `${pluginId || 'page-guest-plugin'}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    const disposers = [];
    const anchoredActionHandles = new Map();
    const extractorHandles = new Map();
    let iframe = null;
    let started = false;
    let resourceCounter = 0;
    let currentSelection = null;

    function createResourceId(prefix) {
        resourceCounter += 1;
        return `${prefix}:${resourceCounter}`;
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
        case 'page.getSelection':
            return api.page?.getSelection?.() ?? null;
        case 'page.getSelectedText':
            return api.page?.getSelectedText?.() ?? '';
        case 'page.clearSelection':
            api.page?.clearSelection?.();
            return true;
        case 'page.getSnapshot':
            return api.page?.getSnapshot?.(args[0] && typeof args[0] === 'object' ? args[0] : {}) ?? null;
        case 'page.getMessage':
            return api.page?.getMessage?.(args[0], args[1], args[2]) ?? '';
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
        case 'site.click':
            return api.site?.click?.(args[0]) ?? false;
        case 'site.fill':
            return api.site?.fill?.(args[0], args[1]) ?? false;
        case 'ui.showAnchoredAction': {
            const config = args[0] && typeof args[0] === 'object'
                ? args[0]
                : {};
            const actionId = normalizeString(config.__actionId);
            const handle = api.ui?.showAnchoredAction?.(
                buildAnchoredActionConfig(config, () => {
                    postToGuest(GUEST_EVENT, {
                        name: 'ui.anchoredAction.click',
                        value: {
                            actionId,
                        },
                    });
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
                postToGuest(GUEST_EVENT, {
                    name: 'ui.anchoredAction.click',
                    value: {
                        actionId,
                    },
                });
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
            return api.bridge?.send?.(args[0], args[1], args[2] && typeof args[2] === 'object' ? args[2] : {}) ?? {
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
            return api.shell?.insertText?.(args[0], args[1] && typeof args[1] === 'object' ? args[1] : {}) ?? false;
        case 'shell.importText':
            return api.shell?.importText?.(args[0], args[1] && typeof args[1] === 'object' ? args[1] : {}) ?? false;
        default:
            throw new Error(`Unsupported guest page API method: ${method}`);
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
                locale: getHostLocale(),
                selection: currentSelection || api.page?.getSelection?.() || null,
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
                normalizeString(payload?.message, `Guest page plugin "${pluginId}" failed to start`)
            ));
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
            throw new Error('Guest page plugin is missing manifest.id');
        }

        started = true;
        iframe = document.createElement('iframe');
        iframe.className = 'cerebr-plugin-page-guest-frame';
        iframe.title = manifest.displayName || pluginId;
        iframe.setAttribute('aria-hidden', 'true');
        iframe.hidden = true;
        iframe.style.position = 'fixed';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.opacity = '0';
        iframe.style.pointerEvents = 'none';
        iframe.style.border = '0';
        iframe.style.inset = '0 auto auto 0';

        if (typeof api.page?.watchSelection === 'function') {
            const stopWatchingSelection = api.page.watchSelection((selection) => {
                currentSelection = selection;
                postToGuest(GUEST_EVENT, {
                    name: 'page.selection',
                    value: selection,
                });
            });
            if (typeof stopWatchingSelection === 'function') {
                disposers.push(stopWatchingSelection);
            }
        }

        const readyPromise = new Promise((resolve, reject) => {
            const timeoutId = window.setTimeout(() => {
                reject(new Error(`Guest page plugin "${pluginId}" timed out while starting`));
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

        disposers.push(observeLocaleChanged(({ locale } = {}) => {
            postToGuest(GUEST_EVENT, {
                name: 'i18n.locale',
                value: {
                    locale: normalizeString(locale, getHostLocale()),
                },
            });
        }));

        iframe.src = getGuestPageUrl();
        (document.body || document.documentElement)?.appendChild(iframe);

        try {
            await readyPromise;
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
                console.error('[Cerebr] Failed to dispose guest page plugin resource', error);
            }
        }

        anchoredActionHandles.forEach((handle) => {
            try {
                handle?.dispose?.();
            } catch (error) {
                console.error('[Cerebr] Failed to dispose guest page anchored action', error);
            }
        });
        anchoredActionHandles.clear();

        extractorHandles.forEach((handle) => {
            try {
                handle?.dispose?.();
            } catch (error) {
                console.error('[Cerebr] Failed to dispose guest page extractor', error);
            }
        });
        extractorHandles.clear();

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
