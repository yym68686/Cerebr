import { flushSync } from 'react-dom';
import { pluginUiStore } from './plugin-ui-store.js';
import { uiStore } from '../../app/state/ui-store.js';
import {
    normalizeViewDescriptor,
    reconcileSessionFieldValues,
    collectViewFieldValues,
} from './page-view-model.js';
const text = (value, fallback = '') => String(value ?? '').trim() || fallback;
export function createShellPageManager({ logger = console } = {}) {
    const sessions = new Map(),
        listeners = new Map();
    let activeId = '';
    const notify = (id, event) =>
        listeners.get(id)?.forEach((listener) => {
            try {
                listener(structuredClone(event));
            } catch (error) {
                logger.error(error);
            }
        });
    const publish = (session) => {
        flushSync(() =>
            pluginUiStore.set({
                page: session
                    ? {
                          ...session,
                          dispatch: (payload) =>
                              notify(session.pluginId, { ...payload, page: { ...session.page } }),
                          dismiss: (reason) => dismiss(session.pluginId, reason),
                      }
                    : null,
            })
        );
        if (session) uiStore.set({ menu: false, webpageMenu: false });
    };
    const apply = (session, page) => {
        const next = { id: text(page.id), title: text(page.title, 'Plugin'), subtitle: text(page.subtitle) };
        const view =
            page.view && typeof page.view === 'object' && !Array.isArray(page.view)
                ? structuredClone(page.view)
                : null;
        const viewStateKey = text(page.viewStateKey);
        if (
            page.resetViewState ||
            session.page?.id !== next.id ||
            session.viewStateKey !== viewStateKey ||
            !!session.view !== !!view
        ) {
            session.fieldValues = {};
            session.renderedFieldValues = {};
            session.generation++;
        }
        Object.assign(session, { page: next, view, viewStateKey });
        if (view) {
            session.renderView = normalizeViewDescriptor(view);
            reconcileSessionFieldValues(session, session.renderView);
            session.activeFieldIds = new Set(Object.keys(collectViewFieldValues(session.renderView)));
        }
    };
    function dismiss(id, reason = 'programmatic') {
        const session = sessions.get(id);
        if (!session) return false;
        sessions.delete(id);
        if (activeId === id) {
            activeId = '';
            publish(null);
        }
        notify(id, { type: 'close', page: { ...session.page }, reason });
        return true;
    }
    return {
        present(pluginId, mountElement, page = {}) {
            const id = text(pluginId);
            if (!id) throw new Error('shell.openPage() requires a plugin id');
            if (!page.view && !(mountElement instanceof HTMLElement))
                throw new Error('shell.openPage() requires a mounted shell addon element or page.view');
            if (activeId && activeId !== id) dismiss(activeId, 'replaced');
            let session = sessions.get(id);
            if (session && !page.view && session.mountElement !== mountElement) {
                dismiss(id, 'replaced');
                session = null;
            }
            session ||= {
                pluginId: id,
                mountElement,
                page: {},
                fieldValues: {},
                renderedFieldValues: {},
                generation: 0,
            };
            if (mountElement && !session.mountElement) session.mountElement = mountElement;
            apply(session, page);
            sessions.set(id, session);
            activeId = id;
            publish(session);
            notify(id, { type: 'open', page: { ...session.page } });
            return { page: { ...session.page }, dismiss: (reason) => dismiss(id, reason) };
        },
        update(id, page = {}) {
            const session = sessions.get(text(id));
            if (!session) return null;
            apply(session, {
                ...session.page,
                view: session.view,
                viewStateKey: session.viewStateKey,
                ...page,
            });
            if (activeId === text(id)) publish(session);
            return { ...session.page };
        },
        dismiss,
        dismissActive: (reason) => (activeId ? dismiss(activeId, reason) : false),
        isOpen: (id) => (id ? sessions.has(text(id)) : !!activeId),
        getActivePluginId: () => activeId,
        addListener(id, listener) {
            id = text(id);
            if (!id || typeof listener !== 'function') return () => {};
            if (!listeners.has(id)) listeners.set(id, new Set());
            listeners.get(id).add(listener);
            return () => {
                listeners.get(id)?.delete(listener);
            };
        },
        removePlugin(id) {
            listeners.delete(text(id));
            return dismiss(text(id), 'plugin-stop');
        },
    };
}
