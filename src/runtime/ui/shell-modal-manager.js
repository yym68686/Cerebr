const SHELL_MODAL_ROOT_ID = 'cerebr-plugin-shell-modal-root';

function normalizeCssSizeValue(value, fallback = '') {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return `${Math.max(0, Math.round(value))}px`;
    }

    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function normalizeAlign(value, fallback = 'center') {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'start' || normalized === 'top') return 'start';
    if (normalized === 'end' || normalized === 'bottom') return 'end';
    return fallback;
}

function resolveFlexAlign(value) {
    if (value === 'start') return 'flex-start';
    if (value === 'end') return 'flex-end';
    return 'center';
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

export function createShellModalManager({
    hostDocument = document,
} = {}) {
    const sessions = new Map();

    const ensureRoot = () => {
        if (!hostDocument?.body) {
            return null;
        }

        let root = hostDocument.getElementById(SHELL_MODAL_ROOT_ID);
        if (!root) {
            root = hostDocument.createElement('div');
            root.id = SHELL_MODAL_ROOT_ID;
            root.className = 'cerebr-plugin-shell-modal-root';
            hostDocument.body.appendChild(root);
        } else if (root.parentElement !== hostDocument.body) {
            hostDocument.body.appendChild(root);
        }

        return root;
    };

    const cleanupRoot = () => {
        const root = hostDocument.getElementById(SHELL_MODAL_ROOT_ID);
        if (root && root.childElementCount === 0) {
            root.remove();
        }
    };

    const applyOptions = (session, options = {}) => {
        const nextOptions = {
            ...session.options,
            ...(options && typeof options === 'object' ? options : {}),
        };
        session.options = nextOptions;

        const verticalAlign = normalizeAlign(nextOptions.alignY, 'center');
        const horizontalAlign = normalizeAlign(nextOptions.alignX, 'center');
        const blockBackground = !!nextOptions.blockBackground;
        const dimBackground = !!nextOptions.dimBackground;

        session.container.style.justifyContent = resolveFlexAlign(verticalAlign);
        session.container.style.alignItems = resolveFlexAlign(horizontalAlign);
        session.container.style.padding = normalizeCssSizeValue(nextOptions.inset, '16px');

        session.backdrop.classList.toggle(
            'cerebr-plugin-shell-modal__backdrop--visible',
            dimBackground
        );
        session.backdrop.classList.toggle(
            'cerebr-plugin-shell-modal__backdrop--blocking',
            blockBackground
        );

        session.panel.style.width = normalizeCssSizeValue(
            nextOptions.width,
            'min(960px, calc(100vw - 32px))'
        );
        session.panel.style.maxWidth = normalizeCssSizeValue(
            nextOptions.maxWidth,
            'calc(100vw - 32px)'
        );
        session.panel.style.minWidth = normalizeCssSizeValue(nextOptions.minWidth, '0');
        session.panel.style.height = normalizeCssSizeValue(nextOptions.height, 'auto');
        session.panel.style.maxHeight = normalizeCssSizeValue(
            nextOptions.maxHeight,
            'calc(100vh - 32px)'
        );
        session.panel.style.minHeight = normalizeCssSizeValue(nextOptions.minHeight, '0');
        session.panel.style.borderRadius = normalizeCssSizeValue(nextOptions.borderRadius, '24px');
        session.panel.style.background = String(nextOptions.background ?? 'transparent');
        session.panel.style.boxShadow = String(nextOptions.boxShadow ?? 'none');

        session.mountElement.classList.add('cerebr-plugin-slot-item--shell-input-addon-modal');
        if (nextOptions.fillHeight) {
            session.mountElement.classList.add('cerebr-plugin-slot-item--shell-input-addon-modal-fill');
        } else {
            session.mountElement.classList.remove('cerebr-plugin-slot-item--shell-input-addon-modal-fill');
        }
    };

    const present = (pluginId, mountElement, options = {}) => {
        if (!pluginId) {
            throw new Error('shell.showModal() requires a plugin id');
        }
        if (!(mountElement instanceof HTMLElement)) {
            throw new Error('shell.showModal() requires a mounted shell addon element');
        }

        let session = sessions.get(pluginId);
        if (session && session.mountElement !== mountElement) {
            dismiss(pluginId);
            session = null;
        }

        if (!session) {
            const root = ensureRoot();
            if (!root) {
                throw new Error('shell.showModal() could not create a modal root');
            }

            const container = hostDocument.createElement('div');
            container.className = 'cerebr-plugin-shell-modal';

            const backdrop = hostDocument.createElement('div');
            backdrop.className = 'cerebr-plugin-shell-modal__backdrop';

            const panel = hostDocument.createElement('div');
            panel.className = 'cerebr-plugin-shell-modal__panel';

            const restoreParent = mountElement.parentElement;
            const restoreNextSibling = mountElement.nextSibling;

            container.appendChild(backdrop);
            container.appendChild(panel);
            panel.appendChild(mountElement);
            root.appendChild(container);

            session = {
                pluginId,
                mountElement,
                restoreParent,
                restoreNextSibling,
                container,
                backdrop,
                panel,
                options: {},
            };

            sessions.set(pluginId, session);
        }

        applyOptions(session, options);

        return {
            element: session.panel,
            update(nextOptions = {}) {
                applyOptions(session, nextOptions);
            },
            dismiss() {
                dismiss(pluginId);
            },
        };
    };

    const update = (pluginId, options = {}) => {
        const session = sessions.get(pluginId);
        if (!session) {
            return null;
        }

        applyOptions(session, options);
        return {
            element: session.panel,
            dismiss() {
                dismiss(pluginId);
            },
        };
    };

    function dismiss(pluginId) {
        const session = sessions.get(pluginId);
        if (!session) {
            return false;
        }

        sessions.delete(pluginId);
        session.mountElement.classList.remove(
            'cerebr-plugin-slot-item--shell-input-addon-modal',
            'cerebr-plugin-slot-item--shell-input-addon-modal-fill'
        );
        restoreMount(session);
        session.container.remove();
        cleanupRoot();
        return true;
    }

    return {
        present,
        update,
        dismiss,
        has(pluginId) {
            return sessions.has(pluginId);
        },
    };
}
