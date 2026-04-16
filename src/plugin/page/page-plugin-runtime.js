import { createPluginManager } from '../shared/plugin-manager.js';
import { isPluginEnabled, isPluginInstalled, readPluginSettings, subscribePluginSettings } from '../shared/plugin-store.js';
import { getInstalledScriptPlugins } from '../dev/local-plugin-service.js';
import { readDeveloperModePreference, subscribeDeveloperModePreference } from '../dev/developer-mode.js';
import { createScriptPluginCacheKey, loadScriptPluginModule } from '../dev/script-plugin-loader.js';
import { getBuiltinPagePluginEntries } from './page-plugin-registry.js';
import { createSlotRegistry } from '../../runtime/ui/slot-registry.js';
import { isExtensionEnvironment } from '../../utils/storage-adapter.js';

function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function normalizeStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => normalizeString(item)).filter(Boolean);
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
    const resolvedPluginEntries = Array.isArray(pluginEntries)
        ? pluginEntries
            .map((entry) => (entry?.plugin ? entry : { plugin: entry, manifest: null }))
            .filter((entry) => entry?.plugin?.id)
        : [];
    const builtinEntryMap = new Map(
        resolvedPluginEntries.map((entry) => [
            entry.plugin.id,
            {
                plugin: entry.plugin,
                manifest: entry.manifest || null,
            },
        ])
    );
    const pluginResources = new Map();
    const scriptPluginCache = new Map();
    let started = false;
    let selectionRaf = 0;
    let pageSnapshotRaf = 0;
    let unsubscribePluginSettings = null;
    let unsubscribeDeveloperMode = null;
    let pluginSyncPromise = Promise.resolve();
    let developerModeEnabled = false;

    const ensurePluginResources = (pluginId) => {
        const normalizedPluginId = normalizeString(pluginId);
        if (!pluginResources.has(normalizedPluginId)) {
            pluginResources.set(normalizedPluginId, {
                disposers: new Set(),
            });
        }
        return pluginResources.get(normalizedPluginId);
    };

    const registerPluginDisposer = (pluginId, disposer) => {
        if (typeof disposer !== 'function') return () => {};
        const resources = ensurePluginResources(pluginId);
        resources.disposers.add(disposer);
        return () => {
            resources.disposers.delete(disposer);
        };
    };

    const cleanupPluginResources = (pluginId) => {
        const normalizedPluginId = normalizeString(pluginId);
        const resources = pluginResources.get(normalizedPluginId);
        if (resources) {
            resources.disposers.forEach((dispose) => {
                try {
                    dispose();
                } catch (error) {
                    console.error(`[Cerebr] Failed to clean up page plugin resources for "${normalizedPluginId}"`, error);
                }
            });
            resources.disposers.clear();
            pluginResources.delete(normalizedPluginId);
        }
        overlayApi.unmountByPlugin(normalizedPluginId);
    };

    const isPluginBuiltin = (entry = {}) => {
        return entry?.manifest?.kind === 'builtin' || String(entry?.plugin?.id || '').startsWith('builtin.');
    };

    const hasPermission = (entry = {}, permission, aliases = []) => {
        if (!permission || isPluginBuiltin(entry)) {
            return true;
        }

        const allowed = new Set(normalizeStringArray(entry?.manifest?.permissions));
        if (allowed.has(permission)) return true;
        return aliases.some((alias) => allowed.has(alias));
    };

    const assertPermission = (entry, permission, aliases = []) => {
        if (!hasPermission(entry, permission, aliases)) {
            throw new Error(`Plugin "${entry?.plugin?.id || ''}" requires permission "${permission}"`);
        }
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

    const createPageApi = (entry) => ({
        getSelection() {
            assertPermission(entry, 'page:selection');
            return createSelectionSnapshot();
        },
        getSelectedText() {
            assertPermission(entry, 'page:selection');
            return createSelectionSnapshot().text;
        },
        watchSelection(callback) {
            assertPermission(entry, 'page:selection');
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
            registerPluginDisposer(entry?.plugin?.id, dispose);
            return dispose;
        },
        clearSelection() {
            assertPermission(entry, 'page:selection');
            try {
                window.getSelection?.()?.removeAllRanges?.();
            } catch {
                // ignore
            }
        },
        getSnapshot(options = {}) {
            assertPermission(entry, 'page:read');
            return createPageSnapshot(options);
        },
        watchSelectors(selectors, callback, options = {}) {
            assertPermission(entry, 'page:observe');
            const dispose = createSelectorWatcher(selectors, callback, options);
            registerPluginDisposer(entry?.plugin?.id, dispose);
            return dispose;
        },
        query(selector) {
            assertPermission(entry, 'page:read');
            const normalizedSelector = normalizeString(selector);
            return normalizedSelector ? document.querySelector(normalizedSelector) : null;
        },
        queryAll(selector) {
            assertPermission(entry, 'page:read');
            const normalizedSelector = normalizeString(selector);
            return normalizedSelector ? Array.from(document.querySelectorAll(normalizedSelector)) : [];
        },
        getMessage(key, substitutions, fallback = '') {
            return getExtensionMessage(key, substitutions, fallback);
        },
    });

    const createSiteApi = (entry) => ({
        query(selector) {
            assertPermission(entry, 'site:read');
            const normalizedSelector = normalizeString(selector);
            return normalizedSelector ? document.querySelector(normalizedSelector) : null;
        },
        queryAll(selector) {
            assertPermission(entry, 'site:read');
            const normalizedSelector = normalizeString(selector);
            return normalizedSelector ? Array.from(document.querySelectorAll(normalizedSelector)) : [];
        },
        fill(selector, value) {
            assertPermission(entry, 'site:write');
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
            assertPermission(entry, 'site:click');
            const normalizedSelector = normalizeString(selector);
            const target = normalizedSelector ? document.querySelector(normalizedSelector) : null;
            if (!target || typeof target.click !== 'function') {
                return false;
            }

            target.click();
            return true;
        },
        observe(selector, callback, options = {}) {
            assertPermission(entry, 'site:observe');
            const dispose = createSelectorWatcher([selector], (payload) => {
                const firstMatch = payload.matches[0] || { selector: normalizeString(selector), elements: [] };
                callback?.({
                    selector: firstMatch.selector,
                    elements: firstMatch.elements,
                    snapshot: payload.snapshot,
                });
            }, options);
            registerPluginDisposer(entry?.plugin?.id, dispose);
            return dispose;
        },
    });

    const createUiApi = (entry) => ({
        showAnchoredAction(config) {
            assertPermission(entry, 'ui:mount');
            const handle = overlayApi.showAnchoredAction(config);
            registerPluginDisposer(entry?.plugin?.id, () => handle.dispose());
            return handle;
        },
        mountSlot(slotId, renderer, options = {}) {
            assertPermission(entry, 'ui:mount');
            const handle = overlayApi.mountSlot(slotId, entry?.plugin?.id, renderer, options);
            registerPluginDisposer(entry?.plugin?.id, () => handle.dispose());
            return handle;
        },
        getAvailableSlots() {
            return overlayApi.getAvailableSlots();
        },
    });

    const createShellApi = (entry) => ({
        isOpen: () => !!sidebar?.isVisible,
        open: () => {
            assertPermission(entry, 'shell:input');
            return sidebar?.open?.() ?? false;
        },
        toggle: () => {
            assertPermission(entry, 'shell:input');
            return sidebar?.toggle?.() ?? false;
        },
        focusInput: () => {
            assertPermission(entry, 'shell:input');
            return sidebar?.sendPluginBridgeCommand?.('editor.focus') ?? false;
        },
        setDraft: (text) => {
            assertPermission(entry, 'shell:input');
            sidebar?.open?.();
            return sidebar?.sendPluginBridgeCommand?.('editor.setDraft', { text }) ?? false;
        },
        insertText: (text, options = {}) => {
            assertPermission(entry, 'shell:input');
            sidebar?.open?.();
            return sidebar?.sendPluginBridgeCommand?.('editor.insertText', {
                text,
                options,
            }) ?? false;
        },
        importText: (text, options = {}) => {
            assertPermission(entry, 'shell:input');
            sidebar?.open?.();
            return sidebar?.sendPluginBridgeCommand?.('editor.importText', {
                text,
                focus: options.focus !== false,
                separator: options.separator || '\n\n',
            }) ?? false;
        },
    });

    const pluginManager = createPluginManager({
        plugins: [],
        createApi(entry) {
            return {
                page: createPageApi(entry),
                site: createSiteApi(entry),
                ui: createUiApi(entry),
                shell: createShellApi(entry),
            };
        },
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

    const notifyPageSnapshotHooks = () => {
        pageSnapshotRaf = 0;
        const snapshot = createPageSnapshot({ includeText: false });
        void pluginManager.invokeHook('onPageSnapshot', [snapshot, {
            runtime: {
                host: 'page',
                isExtension: isExtensionEnvironment,
            },
        }], {
            timeoutMs: 320,
        });
    };

    const schedulePageSnapshotNotify = () => {
        if (pageSnapshotRaf) return;
        pageSnapshotRaf = requestAnimationFrame(notifyPageSnapshotHooks);
    };

    const applyPluginSettings = async (settings) => {
        const activePluginIds = new Set(pluginManager.getActivePluginIds());
        const registeredPluginIds = getRegisteredPluginIds();
        const desiredScriptPluginIds = new Set();

        for (const [pluginId, entry] of builtinEntryMap.entries()) {
            const shouldInstall = isPluginInstalled(settings, pluginId, entry.manifest?.defaultInstalled !== false);
            const shouldEnable = shouldInstall &&
                isPluginEnabled(settings, pluginId, entry.manifest?.defaultEnabled !== false);

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

        const installedScriptPlugins = await getInstalledScriptPlugins({ scope: 'page' });
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
                console.error(`[Cerebr] Failed to load page script plugin "${descriptor.id}"`, error);
            }
        }

        for (const pluginId of [...scriptPluginCache.keys()]) {
            if (desiredScriptPluginIds.has(pluginId)) {
                continue;
            }

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
                console.error('[Cerebr] Failed to sync page plugins', error);
            });

        return pluginSyncPromise;
    };

    const start = async () => {
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

        await pluginManager.start();
        developerModeEnabled = await readDeveloperModePreference();
        await syncPlugins({
            settings: await readPluginSettings(),
            developerMode: developerModeEnabled,
        });
        scheduleSelectionNotify();
        schedulePageSnapshotNotify();
        unsubscribePluginSettings = subscribePluginSettings((settings) => {
            void syncPlugins({ settings });
        });
        unsubscribeDeveloperMode = subscribeDeveloperModePreference((enabled) => {
            void syncPlugins({ developerMode: enabled });
        });
    };

    const stop = async () => {
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
    };

    return {
        start,
        stop,
    };
}
