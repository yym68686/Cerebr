import { flushSync } from 'react-dom';
import { pluginUiStore } from './plugin-ui-store.js';
export function createShellModalManager() {
    const sessions = new Map();
    const publish = () =>
        flushSync(() =>
            pluginUiStore.set({ modals: [...sessions.values()].map((session) => ({ ...session })) })
        );
    function dismiss(pluginId) {
        if (!sessions.delete(pluginId)) return false;
        publish();
        return true;
    }
    const update = (pluginId, options = {}) => {
        const session = sessions.get(pluginId);
        if (!session) return null;
        session.options = { ...session.options, ...options };
        publish();
        return { element: session.panel, dismiss: () => dismiss(pluginId) };
    };
    return {
        present(pluginId, mountElement, options = {}) {
            if (!pluginId || !(mountElement instanceof HTMLElement))
                throw new Error('shell.showModal() requires a plugin id and a mounted shell addon element');
            let session = sessions.get(pluginId);
            if (session?.mountElement !== mountElement) {
                dismiss(pluginId);
                session = null;
            }
            session ||= { pluginId, mountElement, options: {}, panel: null };
            session.options = { ...session.options, ...options };
            session.setPanel = (node) => {
                session.panel = node;
            };
            sessions.set(pluginId, session);
            // The public modal API returns its panel element synchronously.
            publish();
            return {
                element: session.panel,
                update: (next) => update(pluginId, next),
                dismiss: () => dismiss(pluginId),
            };
        },
        update,
        dismiss,
        has: (id) => sessions.has(id),
    };
}
