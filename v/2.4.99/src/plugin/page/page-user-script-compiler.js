import {
    getLocalPluginBundleFiles,
    isLocalPluginBundlePackage,
    resolveLocalPluginBundleSpecifier,
} from '../dev/local-plugin-bundle.js';
import { normalizeString } from '../core/runtime-utils.js';
import { getPageUserScriptCompatibilityIssues } from './page-user-script-support.js';

const STATIC_IMPORT_PATTERN = /(import\s+(?:[^"'()]*?\s+from\s+)?)(['"])([^'"]+)\2/g;
const EXPORT_FROM_PATTERN = /(export\s+(?:[^"'()]*?\s+from\s+))(['"])([^'"]+)\2/g;
const DYNAMIC_IMPORT_PATTERN = /(import\s*\(\s*)(['"])([^'"]+)\2(\s*(?:,\s*[^)]*)?\))/g;
const PAGE_USER_SCRIPT_REGISTRATION_PREFIX = 'cerebr.page.user-script.';

function normalizeStringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.map((item) => normalizeString(item)).filter(Boolean);
}

function isJsonModulePath(modulePath, fileRecord = {}) {
    if (String(fileRecord.type || '').includes('json')) return true;
    return /\.json$/i.test(modulePath);
}

function isJavaScriptModulePath(modulePath, fileRecord = {}) {
    if (isJsonModulePath(modulePath, fileRecord)) return false;
    const mimeType = normalizeString(fileRecord.type).toLowerCase();
    if (mimeType.includes('javascript') || mimeType.includes('ecmascript')) {
        return true;
    }
    if (/\.(?:m?js|jsx|ts|tsx)$/i.test(modulePath)) {
        return true;
    }
    return !/\.[a-z0-9]+$/i.test(modulePath);
}

function getModuleMimeType(modulePath, fileRecord = {}) {
    const declaredType = normalizeString(fileRecord.type);
    if (declaredType) return declaredType;
    if (isJsonModulePath(modulePath, fileRecord)) return 'application/json';
    return 'text/javascript';
}

function createDataModuleSourceUrl(source, mimeType) {
    return `data:${mimeType};charset=utf-8,${encodeURIComponent(source)}`;
}

async function replaceAsync(source, pattern, replacer) {
    const matches = [];
    source.replace(pattern, (...args) => {
        matches.push(args);
        return args[0];
    });

    if (matches.length === 0) {
        return source;
    }

    const replacements = await Promise.all(matches.map((args) => replacer(...args)));
    let replacementIndex = 0;
    return source.replace(pattern, () => replacements[replacementIndex++]);
}

async function resolveBundledImportSpecifier(specifier, fromModulePath, bundleFiles, urlCache) {
    const resolved = resolveLocalPluginBundleSpecifier(specifier, fromModulePath);

    if (resolved.kind === 'bundle') {
        const nextModuleUrl = await createBundledModuleDataUrl(resolved.path, bundleFiles, urlCache);
        return resolved.suffix ? `${nextModuleUrl}${resolved.suffix}` : nextModuleUrl;
    }

    throw new Error(`Page user scripts require a self-contained bundled module graph. Unsupported import "${specifier}"`);
}

async function rewriteBundledModuleSource(source, modulePath, bundleFiles, urlCache) {
    let rewritten = String(source ?? '');

    rewritten = await replaceAsync(rewritten, STATIC_IMPORT_PATTERN, async (match, prefix, quote, specifier) => {
        const resolvedSpecifier = await resolveBundledImportSpecifier(specifier, modulePath, bundleFiles, urlCache);
        return `${prefix}${JSON.stringify(resolvedSpecifier)}`;
    });

    rewritten = await replaceAsync(rewritten, EXPORT_FROM_PATTERN, async (match, prefix, quote, specifier) => {
        const resolvedSpecifier = await resolveBundledImportSpecifier(specifier, modulePath, bundleFiles, urlCache);
        return `${prefix}${JSON.stringify(resolvedSpecifier)}`;
    });

    rewritten = await replaceAsync(rewritten, DYNAMIC_IMPORT_PATTERN, async (match, prefix, quote, specifier, suffix) => {
        const resolvedSpecifier = await resolveBundledImportSpecifier(specifier, modulePath, bundleFiles, urlCache);
        return `${prefix}${JSON.stringify(resolvedSpecifier)}${suffix}`;
    });

    return rewritten;
}

async function createBundledModuleDataUrl(modulePath, bundleFiles, urlCache) {
    const normalizedPath = normalizeString(modulePath);
    if (!normalizedPath) {
        throw new Error('Cannot resolve an empty page user script module path');
    }

    const cachedUrl = urlCache.get(normalizedPath);
    if (cachedUrl) {
        return cachedUrl;
    }

    const fileRecord = bundleFiles?.[normalizedPath];
    if (!fileRecord) {
        throw new Error(`Local plugin file "${normalizedPath}" is missing from the installed bundle`);
    }

    const moduleSource = isJavaScriptModulePath(normalizedPath, fileRecord)
        ? await rewriteBundledModuleSource(fileRecord.text, normalizedPath, bundleFiles, urlCache)
        : String(fileRecord.text ?? '');
    const dataUrl = createDataModuleSourceUrl(
        moduleSource,
        getModuleMimeType(normalizedPath, fileRecord)
    );

    urlCache.set(normalizedPath, dataUrl);
    return dataUrl;
}

function createBootstrapSource({
    manifest = {},
    entryModuleUrl = '',
} = {}) {
    const pluginMeta = {
        id: normalizeString(manifest.id),
        displayName: normalizeString(manifest.displayName, normalizeString(manifest.id)),
        version: normalizeString(manifest.version),
        kind: normalizeString(manifest.kind, 'script'),
        scope: normalizeString(manifest.scope, 'page'),
    };
    const permissions = normalizeStringArray(manifest.permissions);

    return `(() => {
const MANIFEST = ${JSON.stringify(pluginMeta)};
const ENTRY_MODULE_URL = ${JSON.stringify(entryModuleUrl)};
const GRANTED_PERMISSIONS = ${JSON.stringify(permissions)};
const PORT_NAME = ${JSON.stringify(`cerebr.page.user-script:${pluginMeta.id}`)};
const MSG_READY = 'PAGE_USER_SCRIPT_READY';
const MSG_ERROR = 'PAGE_USER_SCRIPT_ERROR';
const MSG_RPC = 'PAGE_USER_SCRIPT_RPC';
const MSG_RPC_RESPONSE = 'PAGE_USER_SCRIPT_RPC_RESPONSE';
const MSG_EVENT = 'PAGE_USER_SCRIPT_EVENT';
const MSG_HOOK_REQUEST = 'PAGE_USER_SCRIPT_HOOK_REQUEST';
const MSG_HOOK_RESPONSE = 'PAGE_USER_SCRIPT_HOOK_RESPONSE';
const runtimeApi = globalThis.chrome?.runtime || globalThis.browser?.runtime;
if (!runtimeApi?.connect) {
    return;
}

const state = {
    actionCallbacks: new Map(),
    cleanup: null,
    pagePlugin: null,
    pendingRpc: new Map(),
    port: null,
    reconnectTimer: 0,
    rpcCounter: 0,
    selectionWatchers: new Set(),
    selectionRaf: 0,
    stopped: false,
};

function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function createSerializableError(error) {
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

function hasPermission(permission, aliases = []) {
    const requested = [permission, ...(Array.isArray(aliases) ? aliases : [])]
        .map((item) => normalizeString(item))
        .filter(Boolean);
    if (requested.length === 0) {
        return true;
    }
    return requested.some((item) => GRANTED_PERMISSIONS.includes(item));
}

function assertPermission(permission, aliases = []) {
    if (hasPermission(permission, aliases)) {
        return true;
    }
    throw new Error(\`Plugin "\${MANIFEST.id}" requires permission "\${permission}"\`);
}

function getClosestElement(node) {
    if (!node) return null;
    if (node instanceof Element) return node;
    return node.parentElement || null;
}

function rectToPlainObject(rect) {
    if (!rect) return null;
    const x = Number.isFinite(rect.x) ? rect.x : rect.left;
    const y = Number.isFinite(rect.y) ? rect.y : rect.top;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    return {
        x,
        y,
        left: Number.isFinite(rect.left) ? rect.left : x,
        top: Number.isFinite(rect.top) ? rect.top : y,
        right: Number.isFinite(rect.right) ? rect.right : x + (Number(rect.width) || 0),
        bottom: Number.isFinite(rect.bottom) ? rect.bottom : y + (Number(rect.height) || 0),
        width: Number(rect.width) || 0,
        height: Number(rect.height) || 0,
    };
}

function getSelectionRect(range) {
    if (!range) return null;

    try {
        const rects = range.getClientRects?.();
        if (rects?.length) {
            return rectToPlainObject(rects[rects.length - 1]);
        }
    } catch {}

    try {
        const rect = range.getBoundingClientRect?.();
        if (rect && (rect.width || rect.height)) {
            return rectToPlainObject(rect);
        }
    } catch {}

    return null;
}

function createSelectionSnapshot() {
    let selection = null;
    try {
        selection = window.getSelection?.() || null;
    } catch {
        selection = null;
    }

    if (!selection) {
        return {
            text: '',
            collapsed: true,
            rect: null,
            rangeCount: 0,
            insideEditable: false,
            insideCodeBlock: false,
        };
    }

    const rangeCount = selection.rangeCount || 0;
    const text = String(selection.toString?.() || '');
    const collapsed = !text.trim() || selection.isCollapsed || rangeCount === 0;
    const range = rangeCount > 0 ? selection.getRangeAt(0) : null;
    const anchorElement = getClosestElement(range?.commonAncestorContainer || selection.anchorNode);

    return {
        text,
        collapsed,
        rect: collapsed ? null : getSelectionRect(range),
        rangeCount,
        insideEditable: !!anchorElement?.closest?.('input, textarea, [contenteditable]:not([contenteditable="false"])'),
        insideCodeBlock: !!anchorElement?.closest?.('pre, code'),
    };
}

function createPageSnapshot(options = {}) {
    const includeText = options?.includeText === true;
    const maxTextLength = Number(options?.maxTextLength) || 20000;
    const bodyText = includeText
        ? String(document.body?.innerText || '').trim().slice(0, maxTextLength)
        : '';

    return {
        title: document.title || '',
        url: window.location.href,
        text: bodyText,
        readyState: document.readyState,
        selection: createSelectionSnapshot(),
    };
}

function notifySelectionWatchers() {
    state.selectionRaf = 0;
    const snapshot = createSelectionSnapshot();
    state.selectionWatchers.forEach((callback) => {
        try {
            callback(cloneSimpleObject(snapshot, null));
        } catch (error) {
            console.warn('[Cerebr] User script selection watcher failed', error);
        }
    });
}

function scheduleSelectionNotify() {
    if (state.selectionRaf) return;
    state.selectionRaf = requestAnimationFrame(notifySelectionWatchers);
}

function bindSelectionObservers() {
    document.addEventListener('selectionchange', scheduleSelectionNotify, true);
    document.addEventListener('mouseup', scheduleSelectionNotify, true);
    document.addEventListener('keyup', scheduleSelectionNotify, true);
    window.addEventListener('scroll', scheduleSelectionNotify, true);
    window.addEventListener('resize', scheduleSelectionNotify, true);
    window.addEventListener('blur', scheduleSelectionNotify, true);
}

function unbindSelectionObservers() {
    document.removeEventListener('selectionchange', scheduleSelectionNotify, true);
    document.removeEventListener('mouseup', scheduleSelectionNotify, true);
    document.removeEventListener('keyup', scheduleSelectionNotify, true);
    window.removeEventListener('scroll', scheduleSelectionNotify, true);
    window.removeEventListener('resize', scheduleSelectionNotify, true);
    window.removeEventListener('blur', scheduleSelectionNotify, true);
}

function createSelectorWatcher(selectors, callback, options = {}) {
    const normalizedSelectors = Array.isArray(selectors)
        ? selectors.map((item) => normalizeString(item)).filter(Boolean)
        : [];
    if (normalizedSelectors.length === 0 || typeof callback !== 'function') {
        return () => {};
    }

    let rafId = 0;
    const emit = () => {
        rafId = 0;
        const matches = normalizedSelectors.map((selector) => ({
            selector,
            elements: Array.from(document.querySelectorAll(selector)),
        }));
        callback({
            selectors: normalizedSelectors,
            matches,
            snapshot: createPageSnapshot({
                includeText: options.includeText === true,
                maxTextLength: options.maxTextLength,
            }),
        });
    };

    const schedule = () => {
        if (rafId) return;
        rafId = requestAnimationFrame(emit);
    };

    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
        characterData: options.characterData !== false,
        attributes: options.attributes === true,
    });

    window.addEventListener('hashchange', schedule);
    window.addEventListener('popstate', schedule);
    document.addEventListener('visibilitychange', schedule);

    if (options.immediate !== false) {
        emit();
    }

    return () => {
        if (rafId) {
            cancelAnimationFrame(rafId);
        }
        observer.disconnect();
        window.removeEventListener('hashchange', schedule);
        window.removeEventListener('popstate', schedule);
        document.removeEventListener('visibilitychange', schedule);
    };
}

function rejectPendingRpc(message) {
    const pendingEntries = Array.from(state.pendingRpc.values());
    state.pendingRpc.clear();
    pendingEntries.forEach((pending) => {
        pending.reject(new Error(message));
    });
}

function scheduleReconnect() {
    if (state.stopped || state.reconnectTimer) {
        return;
    }
    state.reconnectTimer = window.setTimeout(() => {
        state.reconnectTimer = 0;
        ensurePort();
    }, 250);
}

function handlePortMessage(message) {
    const type = normalizeString(message?.type);
    if (type === MSG_RPC_RESPONSE) {
        const requestId = normalizeString(message?.requestId);
        const pending = state.pendingRpc.get(requestId);
        if (!pending) {
            return;
        }

        state.pendingRpc.delete(requestId);
        if (message?.ok === false) {
            pending.reject(new Error(normalizeString(message?.error?.message, 'User script RPC failed')));
            return;
        }

        pending.resolve(message?.value);
        return;
    }

    if (type === MSG_EVENT && normalizeString(message?.event) === 'ui.anchoredAction.click') {
        const actionId = normalizeString(message?.value?.actionId);
        const callback = state.actionCallbacks.get(actionId);
        if (typeof callback === 'function') {
            try {
                callback();
            } catch (error) {
                console.warn('[Cerebr] User script anchored action callback failed', error);
            }
        }
        return;
    }

    if (type === MSG_HOOK_REQUEST) {
        void handleHookRequest(message);
    }
}

function ensurePort() {
    if (state.port) {
        return state.port;
    }

    const port = runtimeApi.connect({ name: PORT_NAME });
    state.port = port;
    port.onMessage.addListener(handlePortMessage);
    port.onDisconnect.addListener(() => {
        state.port = null;
        rejectPendingRpc('User script host disconnected');
        scheduleReconnect();
    });
    return port;
}

function postPortMessage(message) {
    ensurePort().postMessage(message);
}

function createRpcRequest(method, args = []) {
    return new Promise((resolve, reject) => {
        const requestId = \`user-script-rpc-\${++state.rpcCounter}\`;
        state.pendingRpc.set(requestId, {
            resolve,
            reject,
        });

        postPortMessage({
            type: MSG_RPC,
            pluginId: MANIFEST.id,
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

function createAnchoredActionHandle(handleId, actionId) {
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

function createRuntimeContext(extraContext = {}) {
    const permissions = {
        granted: [...GRANTED_PERMISSIONS],
        has(permission, aliases = []) {
            return hasPermission(permission, aliases);
        },
        assert(permission, aliases = []) {
            return assertPermission(permission, aliases);
        },
    };
    const serviceApi = {
        page: {
            getSelection() {
                assertPermission('page:selection:read', ['page:selection']);
                return createSelectionSnapshot();
            },
            getSelectedText() {
                assertPermission('page:selection:read', ['page:selection']);
                return createSelectionSnapshot().text;
            },
            watchSelection(callback, { immediate = true } = {}) {
                assertPermission('page:selection:read', ['page:selection']);
                if (typeof callback !== 'function') {
                    return () => {};
                }

                state.selectionWatchers.add(callback);
                if (immediate) {
                    callback(cloneSimpleObject(createSelectionSnapshot(), null));
                }

                return () => {
                    state.selectionWatchers.delete(callback);
                };
            },
            clearSelection() {
                assertPermission('page:selection:clear', ['page:selection']);
                try {
                    window.getSelection?.()?.removeAllRanges?.();
                } catch {}
                return true;
            },
            getSnapshot(options = {}) {
                assertPermission('page:snapshot', ['page:read']);
                return createPageSnapshot(options);
            },
            watchSelectors(selectors, callback, options = {}) {
                assertPermission('page:observe:selectors', ['page:observe']);
                return createSelectorWatcher(selectors, callback, options);
            },
            async registerExtractor(definition = {}) {
                assertPermission('page:extractors', ['page:read']);
                const result = await createRpcRequest('page.registerExtractor', [definition]);
                if (!result?.handleId) {
                    return null;
                }
                return createGuestExtractorHandle(result.handleId, result);
            },
            listExtractors() {
                assertPermission('page:extractors', ['page:read']);
                return createRpcRequest('page.listExtractors');
            },
            getMessage(key, substitutions = [], fallback = '') {
                return createRpcRequest('page.getMessage', [key, substitutions, fallback]);
            },
            query(selector) {
                assertPermission('page:query', ['page:read']);
                const normalizedSelector = normalizeString(selector);
                return normalizedSelector ? document.querySelector(normalizedSelector) : null;
            },
            queryAll(selector) {
                assertPermission('page:query', ['page:read']);
                const normalizedSelector = normalizeString(selector);
                return normalizedSelector ? Array.from(document.querySelectorAll(normalizedSelector)) : [];
            },
        },
        site: {
            query(selector) {
                assertPermission('site:query', ['site:read']);
                const normalizedSelector = normalizeString(selector);
                return normalizedSelector ? document.querySelector(normalizedSelector) : null;
            },
            queryAll(selector) {
                assertPermission('site:query', ['site:read']);
                const normalizedSelector = normalizeString(selector);
                return normalizedSelector ? Array.from(document.querySelectorAll(normalizedSelector)) : [];
            },
            fill(selector, value) {
                assertPermission('site:fill', ['site:write']);
                const normalizedSelector = normalizeString(selector);
                const target = normalizedSelector ? document.querySelector(normalizedSelector) : null;
                if (!target) return false;

                if ('value' in target) {
                    target.focus?.({ preventScroll: true });
                    target.value = String(value ?? '');
                    target.dispatchEvent?.(new Event('input', { bubbles: true }));
                    target.dispatchEvent?.(new Event('change', { bubbles: true }));
                    return true;
                }
                if (target.isContentEditable) {
                    target.focus?.({ preventScroll: true });
                    target.textContent = String(value ?? '');
                    target.dispatchEvent?.(new Event('input', { bubbles: true }));
                    target.dispatchEvent?.(new Event('change', { bubbles: true }));
                    return true;
                }
                return false;
            },
            click(selector) {
                assertPermission('site:click');
                const normalizedSelector = normalizeString(selector);
                const target = normalizedSelector ? document.querySelector(normalizedSelector) : null;
                if (!target || typeof target.click !== 'function') {
                    return false;
                }
                target.click();
                return true;
            },
            observe(selector, callback, options = {}) {
                assertPermission('site:observe');
                const dispose = createSelectorWatcher([selector], (payload) => {
                    const firstMatch = payload.matches[0] || {
                        selector: normalizeString(selector),
                        elements: [],
                    };
                    callback?.({
                        selector: firstMatch.selector,
                        elements: firstMatch.elements,
                        snapshot: payload.snapshot,
                    });
                }, options);
                return dispose;
            },
        },
        ui: {
            async showAnchoredAction(config = {}) {
                assertPermission('ui:anchored-action', ['ui:mount']);
                const actionId = \`anchored-action:\${Date.now()}:\${Math.random().toString(36).slice(2, 10)}\`;
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
                return createAnchoredActionHandle(result.handleId, actionId);
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

    const diagnostics = {
        host: 'page',
        executionSurface: 'user_script',
        serviceNames: Object.keys(serviceApi),
        preflight: {
            ok: true,
            errors: [],
            warnings: [],
        },
    };
    const runtime = {
        host: 'page',
        isExtension: true,
        isWeb: false,
        isServiceWorker: false,
        isGuest: false,
        executionSurface: 'user_script',
    };
    const contextPayload = {
        ...(extraContext && typeof extraContext === 'object' ? extraContext : {}),
        plugin: MANIFEST,
        runtime,
        permissions,
        diagnostics,
    };

    return {
        ...serviceApi,
        api: serviceApi,
        capabilities: serviceApi,
        services: serviceApi,
        context: contextPayload,
        plugin: MANIFEST,
        meta: MANIFEST,
        runtime,
        env: {
            host: 'page',
            isExtension: true,
            isWeb: false,
            isServiceWorker: false,
            isGuest: false,
        },
        permissions,
        diagnostics,
    };
}

async function handleHookRequest(message) {
    const requestId = normalizeString(message?.requestId);
    const hookName = normalizeString(message?.hookName);
    const args = Array.isArray(message?.args) ? message.args : [];
    const hookHandler = state.pagePlugin?.[hookName];

    try {
        let value = null;
        if (typeof hookHandler === 'function') {
            const hookArgs = [...args];
            if (hookName === 'onBridgeMessage') {
                hookArgs[1] = createRuntimeContext(hookArgs[1]);
            } else if (hookName === 'onPageSnapshot') {
                hookArgs[1] = createRuntimeContext(hookArgs[1]);
            }
            value = await hookHandler(...hookArgs);
        }

        postPortMessage({
            type: MSG_HOOK_RESPONSE,
            requestId,
            ok: true,
            value,
        });
    } catch (error) {
        postPortMessage({
            type: MSG_HOOK_RESPONSE,
            requestId,
            ok: false,
            error: createSerializableError(error),
        });
    }
}

async function boot() {
    bindSelectionObservers();
    ensurePort();
    const moduleNamespace = await import(ENTRY_MODULE_URL);
    let plugin = moduleNamespace.default || null;

    if (!plugin && moduleNamespace?.plugin) {
        plugin = moduleNamespace.plugin;
    }

    if (!plugin || typeof plugin.id !== 'string' || typeof plugin.setup !== 'function') {
        throw new Error(\`Script plugin "\${MANIFEST.id}" did not export a valid plugin object\`);
    }
    if (plugin.id !== MANIFEST.id) {
        throw new Error(\`Script plugin id mismatch: expected "\${MANIFEST.id}", received "\${plugin.id}"\`);
    }

    state.pagePlugin = plugin;
    const cleanup = await plugin.setup(createRuntimeContext());
    state.cleanup = typeof cleanup === 'function'
        ? cleanup
        : (cleanup && typeof cleanup.dispose === 'function' ? cleanup.dispose.bind(cleanup) : null);

    postPortMessage({
        type: MSG_READY,
        pluginId: MANIFEST.id,
        url: window.location.href,
        title: document.title || '',
    });
}

async function stop() {
    state.stopped = true;
    if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = 0;
    }
    if (state.selectionRaf) {
        cancelAnimationFrame(state.selectionRaf);
        state.selectionRaf = 0;
    }

    unbindSelectionObservers();
    state.selectionWatchers.clear();
    state.actionCallbacks.clear();
    rejectPendingRpc('User script host stopped');

    const cleanup = state.cleanup;
    state.cleanup = null;
    if (typeof cleanup === 'function') {
        await cleanup();
    }

    try {
        state.port?.disconnect?.();
    } catch {}
    state.port = null;
}

window.addEventListener('pagehide', () => {
    void stop();
}, { once: true });

boot().catch((error) => {
    console.error('[Cerebr] Failed to boot page user script plugin', error);
    try {
        postPortMessage({
            type: MSG_ERROR,
            pluginId: MANIFEST.id,
            error: createSerializableError(error),
        });
    } catch {}
});
})();`;
}

export function getPageUserScriptRegistrationId(pluginId = '') {
    return `${PAGE_USER_SCRIPT_REGISTRATION_PREFIX}${normalizeString(pluginId)}`;
}

export async function buildPageUserScriptRegistration(descriptor = {}) {
    const manifest = descriptor?.manifest || {};
    const pluginId = normalizeString(manifest.id);
    const compatibilityIssues = getPageUserScriptCompatibilityIssues(manifest);
    if (compatibilityIssues.length > 0) {
        throw new Error(
            compatibilityIssues.map((issue) => `${issue.code}: ${issue.message}`).join('; ')
        );
    }
    if (!isLocalPluginBundlePackage(manifest)) {
        throw new Error(`Page user script plugin "${pluginId || 'unknown'}" must be materialized as a local bundle package`);
    }

    const bundleFiles = getLocalPluginBundleFiles(manifest);
    const manifestPath = normalizeString(manifest?.source?.bundle?.manifestPath, 'plugin.json');
    const entry = normalizeString(manifest?.script?.entry);
    const entryResolution = resolveLocalPluginBundleSpecifier(entry, manifestPath);
    if (entryResolution.kind !== 'bundle' || !bundleFiles?.[entryResolution.path]) {
        throw new Error(`Page user script plugin "${pluginId || 'unknown'}" is missing "${entryResolution.path || entry}"`);
    }

    const moduleUrlCache = new Map();
    const entryModuleUrl = await createBundledModuleDataUrl(
        entryResolution.path,
        bundleFiles,
        moduleUrlCache
    );
    const code = createBootstrapSource({
        manifest,
        entryModuleUrl,
    });

    return {
        id: getPageUserScriptRegistrationId(pluginId),
        matches: ['<all_urls>'],
        js: [{
            code,
        }],
        runAt: 'document_idle',
    };
}

