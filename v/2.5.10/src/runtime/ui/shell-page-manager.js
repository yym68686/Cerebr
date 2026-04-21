import { renderShellPageView } from './shell-page-view-renderer.js';

function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function cloneValue(value, fallback = null) {
    if (value == null) {
        return fallback;
    }

    try {
        if (typeof structuredClone === 'function') {
            return structuredClone(value);
        }
        return JSON.parse(JSON.stringify(value));
    } catch {
        return fallback;
    }
}

function restoreMount(session) {
    const mountElement = session?.mountElement instanceof HTMLElement
        ? session.mountElement
        : null;
    const restoreParent = session?.restoreParent instanceof Node
        ? session.restoreParent
        : null;

    if (!mountElement || !restoreParent) {
        return;
    }

    if (session.restoreNextSibling?.parentNode === restoreParent) {
        restoreParent.insertBefore(mountElement, session.restoreNextSibling);
        return;
    }

    restoreParent.appendChild(mountElement);
}

function createSessionPage(page = {}) {
    return {
        id: normalizeString(page.id),
        title: normalizeString(page.title, 'Plugin'),
        subtitle: normalizeString(page.subtitle),
    };
}

function createSessionEvent(type, page, extras = {}) {
    return {
        type,
        page: { ...page },
        ...extras,
    };
}

function normalizeViewStateKey(page = {}) {
    return normalizeString(page?.viewStateKey);
}

function shouldUseViewMode(page = {}) {
    return !!(page && typeof page.view === 'object' && !Array.isArray(page.view));
}

export function createShellPageManager({
    root = null,
    titleElement = null,
    subtitleElement = null,
    bodyElement = null,
    backButton = null,
    logger = console,
} = {}) {
    const pluginListeners = new Map();
    const sessions = new Map();
    let activePluginId = '';

    function notify(pluginId, event) {
        const listeners = pluginListeners.get(pluginId);
        if (!listeners || listeners.size === 0) {
            return;
        }

        listeners.forEach((listener) => {
            try {
                listener(cloneValue(event, event) || event);
            } catch (error) {
                logger?.error?.('[Cerebr] Failed to notify shell page listener', error);
            }
        });
    }

    function hideRoot() {
        if (!(root instanceof HTMLElement)) {
            return;
        }

        root.classList.remove('visible');
        root.hidden = true;
    }

    function showRoot() {
        if (!(root instanceof HTMLElement)) {
            return;
        }

        root.hidden = false;
        root.classList.add('visible');
    }

    function ensureSession(pluginId, mountElement = null) {
        const normalizedPluginId = normalizeString(pluginId);
        if (!normalizedPluginId) {
            return null;
        }

        let session = sessions.get(normalizedPluginId);
        if (session) {
            return session;
        }

        session = {
            pluginId: normalizedPluginId,
            mountElement: mountElement instanceof HTMLElement ? mountElement : null,
            restoreParent: mountElement instanceof HTMLElement ? mountElement.parentElement : null,
            restoreNextSibling: mountElement instanceof HTMLElement ? mountElement.nextSibling : null,
            page: createSessionPage({}),
            view: null,
            viewStateKey: '',
            renderMode: '',
            fieldValues: {},
            renderedFieldValues: {},
            activeFieldIds: new Set(),
        };
        sessions.set(normalizedPluginId, session);
        return session;
    }

    function teardownRenderedContent(session) {
        if (bodyElement instanceof HTMLElement) {
            bodyElement.replaceChildren();
        }

        if (session?.renderMode === 'mount') {
            session.mountElement?.classList?.remove?.('cerebr-plugin-slot-item--shell-input-addon-page');
            restoreMount(session);
        }

        session.renderMode = '';
    }

    function dispatchInteraction(pluginId, session, payload = {}) {
        notify(pluginId, {
            ...payload,
            page: { ...session.page },
        });
    }

    function renderSession(session) {
        if (!(bodyElement instanceof HTMLElement)) {
            throw new Error('shell.openPage() requires a page body element');
        }

        teardownRenderedContent(session);

        if (session.view) {
            renderShellPageView({
                bodyElement,
                session,
                dispatchEvent: (payload) => dispatchInteraction(session.pluginId, session, payload),
                logger,
            });
            session.renderMode = 'view';
            return;
        }

        if (!(session.mountElement instanceof HTMLElement)) {
            throw new Error('shell.openPage() requires a mounted shell addon element when page.view is not provided');
        }

        session.mountElement.classList.add('cerebr-plugin-slot-item--shell-input-addon-page');
        bodyElement.replaceChildren(session.mountElement);
        session.renderMode = 'mount';
    }

    function applyPageDescriptor(session, page = {}) {
        const nextPage = createSessionPage(page);
        const nextView = shouldUseViewMode(page)
            ? cloneValue(page.view, {}) || {}
            : null;
        const nextViewStateKey = normalizeViewStateKey(page);
        const nextRenderMode = nextView ? 'view' : 'mount';
        const shouldResetViewState = !!page?.resetViewState
            || session.page?.id !== nextPage.id
            || session.viewStateKey !== nextViewStateKey
            || session.renderMode !== nextRenderMode;

        session.page = nextPage;
        session.view = nextView;
        session.viewStateKey = nextViewStateKey;

        if (shouldResetViewState) {
            session.fieldValues = {};
            session.renderedFieldValues = {};
        }

        if (titleElement instanceof HTMLElement) {
            titleElement.textContent = nextPage.title;
        }

        if (subtitleElement instanceof HTMLElement) {
            subtitleElement.textContent = nextPage.subtitle;
            subtitleElement.hidden = !nextPage.subtitle;
        }
    }

    function present(pluginId, mountElement, page = {}) {
        const normalizedPluginId = normalizeString(pluginId);
        if (!normalizedPluginId) {
            throw new Error('shell.openPage() requires a plugin id');
        }

        const viewMode = shouldUseViewMode(page);
        if (!viewMode && !(mountElement instanceof HTMLElement)) {
            throw new Error('shell.openPage() requires a mounted shell addon element');
        }

        if (activePluginId && activePluginId !== normalizedPluginId) {
            dismiss(activePluginId, 'replaced');
        }

        const session = ensureSession(normalizedPluginId, mountElement);
        if (!session) {
            throw new Error('shell.openPage() requires a plugin id');
        }

        if (mountElement instanceof HTMLElement && !session.mountElement) {
            session.mountElement = mountElement;
            session.restoreParent = mountElement.parentElement;
            session.restoreNextSibling = mountElement.nextSibling;
        } else if (!viewMode && session.mountElement !== mountElement) {
            dismiss(normalizedPluginId, 'replaced');
            return present(normalizedPluginId, mountElement, page);
        }

        applyPageDescriptor(session, page);
        renderSession(session);
        activePluginId = normalizedPluginId;
        showRoot();
        notify(normalizedPluginId, createSessionEvent('open', session.page));

        return {
            page: { ...session.page },
            dismiss(reason = 'programmatic') {
                dismiss(normalizedPluginId, reason);
            },
        };
    }

    function update(pluginId, page = {}) {
        const normalizedPluginId = normalizeString(pluginId);
        const session = sessions.get(normalizedPluginId);
        if (!session) {
            return null;
        }

        applyPageDescriptor(session, {
            ...session.page,
            view: session.view,
            viewStateKey: session.viewStateKey,
            ...(page && typeof page === 'object' ? page : {}),
        });
        renderSession(session);
        if (activePluginId === normalizedPluginId) {
            showRoot();
        }
        return { ...session.page };
    }

    function dismiss(pluginId, reason = 'programmatic') {
        const normalizedPluginId = normalizeString(pluginId);
        const session = sessions.get(normalizedPluginId);
        if (!session) {
            return false;
        }

        sessions.delete(normalizedPluginId);
        teardownRenderedContent(session);

        if (activePluginId === normalizedPluginId) {
            activePluginId = '';
            hideRoot();
        }

        notify(normalizedPluginId, createSessionEvent('close', session.page, { reason }));
        return true;
    }

    function dismissActive(reason = 'programmatic') {
        if (!activePluginId) {
            return false;
        }

        return dismiss(activePluginId, reason);
    }

    if (backButton instanceof HTMLElement) {
        backButton.addEventListener('click', () => {
            dismissActive('back');
        });
    }

    hideRoot();

    return {
        present,
        update,
        dismiss,
        dismissActive,
        addListener(pluginId, listener) {
            const normalizedPluginId = normalizeString(pluginId);
            if (!normalizedPluginId || typeof listener !== 'function') {
                return () => {};
            }

            let listeners = pluginListeners.get(normalizedPluginId);
            if (!listeners) {
                listeners = new Set();
                pluginListeners.set(normalizedPluginId, listeners);
            }

            listeners.add(listener);
            return () => {
                listeners.delete(listener);
                if (listeners.size === 0) {
                    pluginListeners.delete(normalizedPluginId);
                }
            };
        },
        removePlugin(pluginId) {
            const normalizedPluginId = normalizeString(pluginId);
            pluginListeners.delete(normalizedPluginId);
            return dismiss(normalizedPluginId, 'plugin-stop');
        },
        isOpen(pluginId = '') {
            if (pluginId) {
                return sessions.has(normalizeString(pluginId));
            }
            return !!activePluginId;
        },
        getActivePluginId() {
            return activePluginId;
        },
    };
}
