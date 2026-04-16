import { createHostedPluginRuntime } from '../core/hosted-plugin-runtime.js';
import { createPluginBridgeMessage, isPluginBridgeMessage } from '../bridge/plugin-bridge.js';
import {
    extractTextWithPageExtractor,
    matchesPageExtractor,
    normalizePageExtractorDefinition,
    sortPageExtractors,
} from '../core/page-extractor-utils.js';
import { createPermissionController } from '../core/plugin-permissions.js';
import { createPluginResourceStore } from '../core/plugin-resource-store.js';
import { normalizeString, normalizeStringArray } from '../core/runtime-utils.js';
import { getBuiltinPagePluginEntries } from './page-plugin-registry.js';
import { createSlotRegistry } from '../../runtime/ui/slot-registry.js';
import { isExtensionEnvironment } from '../../utils/storage-adapter.js';

function createPluginMeta(entry = {}) {
    return {
        id: normalizeString(entry?.plugin?.id),
        manifest: entry?.manifest ? { ...entry.manifest } : null,
    };
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
    } catch {
        // ignore
    }

    try {
        const rect = range.getBoundingClientRect?.();
        if (rect && (rect.width || rect.height)) {
            return rectToPlainObject(rect);
        }
    } catch {
        // ignore
    }

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
        insideEditable: !!anchorElement?.closest?.(
            'input, textarea, [contenteditable]:not([contenteditable="false"])'
        ),
        insideCodeBlock: !!anchorElement?.closest?.('pre, code'),
    };
}

function getExtensionMessage(key, substitutions, fallback = '') {
    try {
        return chrome?.i18n?.getMessage?.(key, substitutions) || fallback;
    } catch {
        return fallback;
    }
}

function createPageSnapshot({ maxTextLength = 20000, includeText = true } = {}) {
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

function dispatchSyntheticInput(element) {
    element?.dispatchEvent?.(new Event('input', { bubbles: true }));
    element?.dispatchEvent?.(new Event('change', { bubbles: true }));
}

function positionAnchoredElement(element, rect, offsets = {}) {
    if (!element || !rect) return;

    const margin = 12;
    const offsetX = 8 + (Number(offsets?.offsetX) || 0);
    const offsetY = 8 + (Number(offsets?.offsetY) || 0);
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const elementRect = element.getBoundingClientRect();
    const bubbleWidth = elementRect.width || 20;
    const bubbleHeight = elementRect.height || 20;

    let left = rect.right + offsetX;
    let top = rect.top - bubbleHeight - offsetY;

    if (left + bubbleWidth + margin > viewportWidth) {
        left = viewportWidth - bubbleWidth - margin;
    }
    if (left < margin) {
        left = margin;
    }

    if (top < margin) {
        top = rect.bottom + offsetY;
    }
    if (top + bubbleHeight + margin > viewportHeight) {
        top = viewportHeight - bubbleHeight - margin;
    }

    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
}

function createOverlayApi(layer) {
    if (!layer) {
        return {
            showAnchoredAction() {
                return {
                    update() {},
                    dispose() {},
                };
            },
            mountSlot() {
                return {
                    update() {},
                    dispose() {},
                };
            },
            getAvailableSlots() {
                return [];
            },
            unmountByPlugin() {},
        };
    }

    const floatingLayer = document.createElement('div');
    floatingLayer.className = 'cerebr-plugin-floating-layer';
    layer.appendChild(floatingLayer);

    const selectionLayer = document.createElement('div');
    selectionLayer.className = 'cerebr-plugin-selection-layer';
    layer.appendChild(selectionLayer);

    const slotRegistry = createSlotRegistry({
        slots: {
            'page.floating': floatingLayer,
            'page.selection-bubble': selectionLayer,
        },
        itemClassName: 'cerebr-plugin-slot-item',
    });

    let nextId = 0;

    const createActionElement = () => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cerebr-plugin-action';

        const dot = document.createElement('span');
        dot.className = 'cerebr-plugin-action__icon cerebr-plugin-action__icon--dot';
        button.appendChild(dot);

        let clickHandler = null;

        button.addEventListener('mousedown', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            clickHandler?.(event);
        });

        return {
            button,
            iconElement: dot,
            setOnClick(nextHandler) {
                clickHandler = typeof nextHandler === 'function' ? nextHandler : null;
            },
        };
    };

    return {
        showAnchoredAction(initialConfig = {}) {
            const actionId = `plugin-action-${++nextId}`;
            let config = { ...initialConfig };
            const action = createActionElement();
            const element = action.button;
            element.dataset.pluginActionId = actionId;
            selectionLayer.appendChild(element);

            const applyConfig = (nextConfig = {}) => {
                config = { ...config, ...nextConfig };
                element.setAttribute('aria-label', config.label || config.title || '');
                action.setOnClick(config.onClick);
                action.iconElement.className = `cerebr-plugin-action__icon cerebr-plugin-action__icon--${config.icon || 'dot'}`;
                if (config.title) {
                    element.title = config.title;
                } else {
                    element.removeAttribute('title');
                }
                positionAnchoredElement(element, config.rect, {
                    offsetX: config.offsetX,
                    offsetY: config.offsetY,
                });
            };

            applyConfig(config);

            return {
                update(nextConfig = {}) {
                    applyConfig(nextConfig);
                },
                dispose() {
                    element.remove();
                },
            };
        },
        mountSlot(slotId, pluginId, renderer, options = {}) {
            return slotRegistry.mount(slotId, pluginId, renderer, options);
        },
        getAvailableSlots() {
            return slotRegistry.getAvailableSlots();
        },
        unmountByPlugin(pluginId) {
            slotRegistry.unmountByPlugin(pluginId);
        },
    };
}

export function createPagePluginRuntime({
    sidebar,
    overlayLayer,
    pluginEntries = getBuiltinPagePluginEntries(),
} = {}) {
    const selectionWatchers = new Set();
    const overlayApi = createOverlayApi(overlayLayer);
    const pluginResources = createPluginResourceStore({
        logger: console,
        createState: () => ({
            extractors: new Map(),
        }),
        onCleanup(pluginId, resources) {
            resources?.extractors?.clear?.();
            overlayApi.unmountByPlugin(pluginId);
        },
    });
    let started = false;
    let selectionRaf = 0;
    let pageSnapshotRaf = 0;

    const collectRegisteredExtractors = (url = window.location.href) => {
        const extractors = [];

        pluginResources.forEach((resources) => {
            resources.extractors?.forEach((extractor) => {
                if (matchesPageExtractor(extractor, url)) {
                    extractors.push({ ...extractor });
                }
            });
        });

        return sortPageExtractors(extractors);
    };

    const applyExtractors = ({ url = window.location.href, content = '' } = {}) => {
        let nextContent = String(content ?? '').trim();

        for (const extractor of collectRegisteredExtractors(url)) {
            const extractedText = extractTextWithPageExtractor(extractor, {
                root: document.body,
            });
            if (!extractedText) {
                continue;
            }

            if (extractor.strategy === 'prepend') {
                nextContent = nextContent
                    ? `${extractedText}\n\n${nextContent}`
                    : extractedText;
                continue;
            }

            if (extractor.strategy === 'append') {
                nextContent = nextContent
                    ? `${nextContent}\n\n${extractedText}`
                    : extractedText;
                continue;
            }

            nextContent = extractedText;
        }

        return nextContent.trim();
    };

    const dispatchIncomingBridgeMessage = (bridgeMessage, baseContext = {}) => {
        if (!isPluginBridgeMessage(bridgeMessage, 'page')) {
            return Promise.resolve([]);
        }

        return runtimeController.pluginManager.invokeHook('onBridgeMessage', (entry) => [
            bridgeMessage,
            createHookContext(entry, {
                ...baseContext,
                bridgeMessage,
            }),
        ], {
            timeoutMs: 320,
        });
    };

    const createSelectorWatcher = (selectors, callback, options = {}) => {
        const normalizedSelectors = normalizeStringArray(selectors);
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
    };

    const notifySelectionWatchers = () => {
        selectionRaf = 0;
        const snapshot = createSelectionSnapshot();
        selectionWatchers.forEach((watcher) => {
            try {
                watcher(snapshot);
            } catch (error) {
                console.error('[Cerebr] Selection watcher failed', error);
            }
        });
    };

    const scheduleSelectionNotify = () => {
        if (selectionRaf) return;
        selectionRaf = requestAnimationFrame(notifySelectionWatchers);
    };

    const createPageApi = (entry = {}) => {
        const permissions = createPermissionController(entry);

        return {
            getSelection() {
                permissions.assert('page:selection');
                return createSelectionSnapshot();
            },
            getSelectedText() {
                permissions.assert('page:selection');
                return createSelectionSnapshot().text;
            },
            watchSelection(callback) {
                permissions.assert('page:selection');
                if (typeof callback !== 'function') {
                    return () => {};
                }

                selectionWatchers.add(callback);
                try {
                    callback(createSelectionSnapshot());
                } catch (error) {
                    console.error('[Cerebr] Selection watcher bootstrap failed', error);
                }

                const dispose = () => {
                    selectionWatchers.delete(callback);
                };
                pluginResources.addDisposer(entry?.plugin?.id, dispose);
                return dispose;
            },
            clearSelection() {
                permissions.assert('page:selection');
                try {
                    window.getSelection?.()?.removeAllRanges?.();
                } catch {
                    // ignore
                }
            },
            getSnapshot(options = {}) {
                permissions.assert('page:read');
                return createPageSnapshot(options);
            },
            watchSelectors(selectors, callback, options = {}) {
                permissions.assert('page:observe');
                const dispose = createSelectorWatcher(selectors, callback, options);
                pluginResources.addDisposer(entry?.plugin?.id, dispose);
                return dispose;
            },
            registerExtractor(extractorDefinition) {
                permissions.assert('page:read');
                const normalized = normalizePageExtractorDefinition(extractorDefinition, entry?.plugin?.id);
                if (!normalized) {
                    return null;
                }

                const resources = pluginResources.ensure(entry?.plugin?.id);
                resources.extractors.set(normalized.id, normalized);

                const dispose = () => {
                    resources.extractors.delete(normalized.id);
                };
                pluginResources.addDisposer(entry?.plugin?.id, dispose);

                return {
                    ...normalized,
                    dispose,
                };
            },
            listExtractors() {
                permissions.assert('page:read');
                return collectRegisteredExtractors().map((extractor) => ({ ...extractor }));
            },
            query(selector) {
                permissions.assert('page:read');
                const normalizedSelector = normalizeString(selector);
                return normalizedSelector ? document.querySelector(normalizedSelector) : null;
            },
            queryAll(selector) {
                permissions.assert('page:read');
                const normalizedSelector = normalizeString(selector);
                return normalizedSelector ? Array.from(document.querySelectorAll(normalizedSelector)) : [];
            },
            getMessage(key, substitutions, fallback = '') {
                return getExtensionMessage(key, substitutions, fallback);
            },
        };
    };

    const createSiteApi = (entry = {}) => {
        const permissions = createPermissionController(entry);

        return {
            query(selector) {
                permissions.assert('site:read');
                const normalizedSelector = normalizeString(selector);
                return normalizedSelector ? document.querySelector(normalizedSelector) : null;
            },
            queryAll(selector) {
                permissions.assert('site:read');
                const normalizedSelector = normalizeString(selector);
                return normalizedSelector ? Array.from(document.querySelectorAll(normalizedSelector)) : [];
            },
            fill(selector, value) {
                permissions.assert('site:write');
                const normalizedSelector = normalizeString(selector);
                const target = normalizedSelector ? document.querySelector(normalizedSelector) : null;
                if (!target) return false;

                if ('value' in target) {
                    target.focus?.({ preventScroll: true });
                    target.value = String(value ?? '');
                    dispatchSyntheticInput(target);
                    return true;
                }
                if (target.isContentEditable) {
                    target.focus?.({ preventScroll: true });
                    target.textContent = String(value ?? '');
                    dispatchSyntheticInput(target);
                    return true;
                }

                return false;
            },
            click(selector) {
                permissions.assert('site:click');
                const normalizedSelector = normalizeString(selector);
                const target = normalizedSelector ? document.querySelector(normalizedSelector) : null;
                if (!target || typeof target.click !== 'function') {
                    return false;
                }

                target.click();
                return true;
            },
            observe(selector, callback, options = {}) {
                permissions.assert('site:observe');
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
                pluginResources.addDisposer(entry?.plugin?.id, dispose);
                return dispose;
            },
        };
    };

    const createUiApi = (entry = {}) => {
        const permissions = createPermissionController(entry);

        return {
            showAnchoredAction(config) {
                permissions.assert('ui:mount');
                const handle = overlayApi.showAnchoredAction(config);
                pluginResources.addDisposer(entry?.plugin?.id, () => handle.dispose());
                return handle;
            },
            mountSlot(slotId, renderer, options = {}) {
                permissions.assert('ui:mount');
                const handle = overlayApi.mountSlot(slotId, entry?.plugin?.id, renderer, options);
                pluginResources.addDisposer(entry?.plugin?.id, () => handle.dispose());
                return handle;
            },
            getAvailableSlots() {
                return overlayApi.getAvailableSlots();
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
                        sourceHost: 'page',
                        sourcePluginId,
                    }
                );

                if (normalizedTarget === 'page') {
                    const results = await dispatchIncomingBridgeMessage(bridgeMessage, {
                        bridgeSource: {
                            host: 'page',
                            pluginId: sourcePluginId,
                        },
                    });
                    return {
                        success: true,
                        target: normalizedTarget,
                        results,
                    };
                }

                if (normalizedTarget === 'shell') {
                    return {
                        success: sidebar?.sendReadyAwareMessage?.(bridgeMessage) ?? false,
                        target: normalizedTarget,
                    };
                }

                if (normalizedTarget === 'background' && chrome?.runtime?.sendMessage) {
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

                return {
                    success: false,
                    target: normalizedTarget,
                    error: 'Bridge target is unavailable',
                };
            },
        };
    };

    const createShellApi = (entry = {}) => {
        const permissions = createPermissionController(entry);

        return {
            isOpen: () => !!sidebar?.isVisible,
            open: () => {
                permissions.assert('shell:input');
                return sidebar?.open?.() ?? false;
            },
            toggle: () => {
                permissions.assert('shell:input');
                return sidebar?.toggle?.() ?? false;
            },
            focusInput: () => {
                permissions.assert('shell:input');
                return sidebar?.sendPluginBridgeCommand?.('editor.focus') ?? false;
            },
            setDraft: (text) => {
                permissions.assert('shell:input');
                sidebar?.open?.();
                return sidebar?.sendPluginBridgeCommand?.('editor.setDraft', { text }) ?? false;
            },
            insertText: (text, options = {}) => {
                permissions.assert('shell:input');
                sidebar?.open?.();
                return sidebar?.sendPluginBridgeCommand?.('editor.insertText', {
                    text,
                    options,
                }) ?? false;
            },
            importText: (text, options = {}) => {
                permissions.assert('shell:input');
                sidebar?.open?.();
                return sidebar?.sendPluginBridgeCommand?.('editor.importText', {
                    text,
                    focus: options.focus !== false,
                    separator: options.separator || '\n\n',
                }) ?? false;
            },
        };
    };

    const createHookContext = (entry = {}, baseContext = {}) => ({
        ...baseContext,
        plugin: createPluginMeta(entry),
        page: createPageApi(entry),
        site: createSiteApi(entry),
        ui: createUiApi(entry),
        bridge: createBridgeApi(entry),
        shell: createShellApi(entry),
        runtime: {
            host: 'page',
            isExtension: isExtensionEnvironment,
        },
    });

    const runtimeController = createHostedPluginRuntime({
        host: 'page',
        builtinEntries: pluginEntries,
        declarativeScopes: ['page'],
        createApi(entry) {
            return {
                page: createPageApi(entry),
                site: createSiteApi(entry),
                ui: createUiApi(entry),
                bridge: createBridgeApi(entry),
                shell: createShellApi(entry),
            };
        },
        logger: console,
        onPluginStopped(entry) {
            pluginResources.cleanup(entry?.plugin?.id);
        },
    });

    const notifyPageSnapshotHooks = () => {
        pageSnapshotRaf = 0;
        const snapshot = createPageSnapshot({ includeText: false });
        void runtimeController.pluginManager.invokeHook('onPageSnapshot', (entry) => [
            snapshot,
            createHookContext(entry, {
                snapshot,
            }),
        ], {
            timeoutMs: 320,
        });
    };

    const schedulePageSnapshotNotify = () => {
        if (pageSnapshotRaf) return;
        pageSnapshotRaf = requestAnimationFrame(notifyPageSnapshotHooks);
    };

    return {
        applyExtractors,
        async handleBridgeMessage(bridgeMessage, bridgeSource = null) {
            return dispatchIncomingBridgeMessage(bridgeMessage, {
                bridgeSource,
            });
        },
        getRegisteredExtractors() {
            return collectRegisteredExtractors().map((extractor) => ({ ...extractor }));
        },
        async start() {
            if (started) return;
            started = true;

            document.addEventListener('selectionchange', scheduleSelectionNotify, true);
            document.addEventListener('mouseup', scheduleSelectionNotify, true);
            document.addEventListener('keyup', scheduleSelectionNotify, true);
            window.addEventListener('scroll', scheduleSelectionNotify, true);
            window.addEventListener('resize', scheduleSelectionNotify, true);
            window.addEventListener('blur', scheduleSelectionNotify, true);

            window.addEventListener('hashchange', schedulePageSnapshotNotify, true);
            window.addEventListener('popstate', schedulePageSnapshotNotify, true);
            document.addEventListener('visibilitychange', schedulePageSnapshotNotify, true);

            await runtimeController.start();
            scheduleSelectionNotify();
            schedulePageSnapshotNotify();
        },
        async stop() {
            if (!started) return;
            started = false;

            document.removeEventListener('selectionchange', scheduleSelectionNotify, true);
            document.removeEventListener('mouseup', scheduleSelectionNotify, true);
            document.removeEventListener('keyup', scheduleSelectionNotify, true);
            window.removeEventListener('scroll', scheduleSelectionNotify, true);
            window.removeEventListener('resize', scheduleSelectionNotify, true);
            window.removeEventListener('blur', scheduleSelectionNotify, true);

            window.removeEventListener('hashchange', schedulePageSnapshotNotify, true);
            window.removeEventListener('popstate', schedulePageSnapshotNotify, true);
            document.removeEventListener('visibilitychange', schedulePageSnapshotNotify, true);

            if (selectionRaf) {
                cancelAnimationFrame(selectionRaf);
                selectionRaf = 0;
            }
            if (pageSnapshotRaf) {
                cancelAnimationFrame(pageSnapshotRaf);
                pageSnapshotRaf = 0;
            }
            selectionWatchers.clear();

            await runtimeController.stop();
            pluginResources.cleanupAll();
        },
    };
}
