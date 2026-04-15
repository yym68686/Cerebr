import { createPluginManager } from '../shared/plugin-manager.js';
import { isPluginEnabled, readPluginSettings, subscribePluginSettings } from '../shared/plugin-store.js';
import { getInstalledLocalScriptPlugins } from '../dev/local-plugin-service.js';
import { readDeveloperModePreference, subscribeDeveloperModePreference } from '../dev/developer-mode.js';
import { createScriptPluginCacheKey, loadScriptPluginModule } from '../dev/script-plugin-loader.js';
import { getBuiltinPagePluginEntries } from './page-plugin-registry.js';

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
        };
    }

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
            layer.appendChild(element);

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
    const pluginEntryMap = new Map(
        resolvedPluginEntries.map((entry) => [
            entry.plugin.id,
            {
                plugin: entry.plugin,
                manifest: entry.manifest || null,
            },
        ])
    );
    let started = false;
    let selectionRaf = 0;
    let unsubscribePluginSettings = null;
    let unsubscribeDeveloperMode = null;
    let pluginSyncPromise = Promise.resolve();
    let developerModeEnabled = false;
    const scriptPluginCache = new Map();

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

    const pageApi = {
        getSelection: createSelectionSnapshot,
        getSelectedText() {
            return createSelectionSnapshot().text;
        },
        watchSelection(callback) {
            if (typeof callback !== 'function') {
                return () => {};
            }

            selectionWatchers.add(callback);
            try {
                callback(createSelectionSnapshot());
            } catch (error) {
                console.error('[Cerebr] Selection watcher bootstrap failed', error);
            }

            return () => {
                selectionWatchers.delete(callback);
            };
        },
        clearSelection() {
            try {
                window.getSelection?.()?.removeAllRanges?.();
            } catch {
                // ignore
            }
        },
        getMessage(key, substitutions, fallback = '') {
            return getExtensionMessage(key, substitutions, fallback);
        },
    };

    const api = {
        page: pageApi,
        ui: overlayApi,
        shell: {
            isOpen: () => !!sidebar?.isVisible,
            open: () => sidebar?.open?.() ?? false,
            focusInput: () => sidebar?.sendPluginBridgeCommand?.('editor.focus'),
            setDraft: (text) => {
                sidebar?.open?.();
                return sidebar?.sendPluginBridgeCommand?.('editor.setDraft', { text }) ?? false;
            },
            insertText: (text, options = {}) => {
                sidebar?.open?.();
                return sidebar?.sendPluginBridgeCommand?.('editor.insertText', {
                    text,
                    options,
                }) ?? false;
            },
            importText: (text, options = {}) => {
                sidebar?.open?.();
                return sidebar?.sendPluginBridgeCommand?.('editor.importText', {
                    text,
                    focus: options.focus !== false,
                }) ?? false;
            },
        },
    };

    const pluginManager = createPluginManager({
        plugins: [],
        api,
        logger: console,
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

    const applyPluginSettings = async (settings) => {
        const activePluginIds = new Set(pluginManager.getActivePluginIds());
        const registeredPluginIds = getRegisteredPluginIds();

        for (const [pluginId, entry] of pluginEntryMap.entries()) {
            const shouldEnable = isPluginEnabled(settings, pluginId, entry.manifest?.defaultEnabled !== false);

            if (shouldEnable) {
                if (!activePluginIds.has(pluginId)) {
                    await pluginManager.register(entry.plugin);
                    activePluginIds.add(pluginId);
                    registeredPluginIds.add(pluginId);
                }
                continue;
            }

            if (registeredPluginIds.has(pluginId)) {
                await pluginManager.unregister(pluginId);
                activePluginIds.delete(pluginId);
                registeredPluginIds.delete(pluginId);
            }
        }

        const localScriptPlugins = developerModeEnabled
            ? await getInstalledLocalScriptPlugins({ scope: 'page' })
            : [];
        const desiredLocalPluginIds = new Set(
            localScriptPlugins.map((descriptor) => descriptor.id)
        );

        for (const descriptor of localScriptPlugins) {
            const shouldEnable = descriptor.compatible &&
                descriptor.runtimeSupported &&
                isPluginEnabled(settings, descriptor.id, descriptor.manifest?.defaultEnabled !== false);

            if (!shouldEnable) {
                if (registeredPluginIds.has(descriptor.id)) {
                    await pluginManager.unregister(descriptor.id);
                    activePluginIds.delete(descriptor.id);
                    registeredPluginIds.delete(descriptor.id);
                }
                continue;
            }

            try {
                const { plugin, changed } = await resolveScriptPlugin(descriptor);
                if (changed || !activePluginIds.has(descriptor.id)) {
                    await pluginManager.register(plugin);
                    activePluginIds.add(descriptor.id);
                    registeredPluginIds.add(descriptor.id);
                }
            } catch (error) {
                scriptPluginCache.delete(descriptor.id);
                if (registeredPluginIds.has(descriptor.id)) {
                    await pluginManager.unregister(descriptor.id);
                    activePluginIds.delete(descriptor.id);
                    registeredPluginIds.delete(descriptor.id);
                }
                console.error(`[Cerebr] Failed to load page script plugin "${descriptor.id}"`, error);
            }
        }

        for (const pluginId of [...scriptPluginCache.keys()]) {
            if (desiredLocalPluginIds.has(pluginId)) {
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

        await pluginManager.start();
        developerModeEnabled = await readDeveloperModePreference();
        await syncPlugins({ settings: await readPluginSettings(), developerMode: developerModeEnabled });
        unsubscribePluginSettings = subscribePluginSettings((settings) => {
            void syncPlugins({ settings });
        });
        unsubscribeDeveloperMode = subscribeDeveloperModePreference((enabled) => {
            void syncPlugins({ developerMode: enabled });
        });
        scheduleSelectionNotify();
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

        if (selectionRaf) {
            cancelAnimationFrame(selectionRaf);
            selectionRaf = 0;
        }

        unsubscribePluginSettings?.();
        unsubscribePluginSettings = null;
        unsubscribeDeveloperMode?.();
        unsubscribeDeveloperMode = null;
        selectionWatchers.clear();
        scriptPluginCache.clear();
        await pluginManager.stop();
    };

    return {
        start,
        stop,
        api,
        manager: pluginManager,
    };
}
