function sanitizeSlotToken(value) {
    return String(value || '')
        .trim()
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function resolveMountResult(result) {
    if (result instanceof Node) {
        return {
            element: result,
            dispose: null,
        };
    }

    if (typeof result === 'string') {
        return {
            element: document.createTextNode(result),
            dispose: null,
        };
    }

    if (result && typeof result === 'object') {
        const element = result.element instanceof Node ? result.element : null;
        const dispose = typeof result.dispose === 'function' ? result.dispose : null;
        return {
            element,
            dispose,
        };
    }

    return {
        element: null,
        dispose: null,
    };
}

export function createSlotRegistry({
    slots = {},
    logger = console,
    itemClassName = 'cerebr-plugin-slot-item',
} = {}) {
    const slotMap = new Map(
        Object.entries(slots).filter(([, element]) => element instanceof Element)
    );
    const mounts = new Map();
    let nextMountId = 0;

    const disposeMount = (mountId) => {
        const existing = mounts.get(mountId);
        if (!existing) return false;

        mounts.delete(mountId);

        try {
            existing.dispose?.();
        } catch (error) {
            logger?.error?.('[Cerebr] Failed to dispose plugin slot mount', error);
        }
        existing.wrapper?.remove?.();
        return true;
    };

    const mount = (slotId, pluginId, renderer, options = {}) => {
        const container = slotMap.get(slotId);
        if (!container) {
            throw new Error(`Plugin slot "${slotId}" is not available`);
        }

        const mountId = `slot-mount-${++nextMountId}`;
        const wrapper = document.createElement('div');
        wrapper.className = itemClassName;
        wrapper.dataset.pluginId = String(pluginId || '');
        wrapper.dataset.pluginSlot = String(slotId || '');

        const slotToken = sanitizeSlotToken(slotId);
        if (slotToken) {
            wrapper.classList.add(`${itemClassName}--${slotToken}`);
        }
        if (options.className) {
            wrapper.classList.add(...String(options.className).split(/\s+/).filter(Boolean));
        }

        const renderIntoWrapper = (nextRenderer) => {
            const existing = mounts.get(mountId);
            if (existing?.dispose) {
                try {
                    existing.dispose();
                } catch (error) {
                    logger?.error?.('[Cerebr] Failed to dispose plugin slot content', error);
                }
            }

            wrapper.replaceChildren();

            const result = typeof nextRenderer === 'function'
                ? nextRenderer({
                    container: wrapper,
                    slotId,
                    pluginId,
                })
                : nextRenderer;
            const resolved = resolveMountResult(result);

            if (resolved.element) {
                wrapper.appendChild(resolved.element);
            }

            mounts.set(mountId, {
                pluginId,
                slotId,
                wrapper,
                dispose: resolved.dispose,
            });
        };

        container.appendChild(wrapper);
        renderIntoWrapper(renderer);

        return {
            element: wrapper,
            update(nextRenderer) {
                renderIntoWrapper(nextRenderer);
            },
            dispose() {
                disposeMount(mountId);
            },
        };
    };

    const unmountByPlugin = (pluginId) => {
        for (const [mountId, mountRecord] of mounts.entries()) {
            if (mountRecord.pluginId !== pluginId) continue;
            disposeMount(mountId);
        }
    };

    return {
        mount,
        hasSlot(slotId) {
            return slotMap.has(slotId);
        },
        getAvailableSlots() {
            return [...slotMap.keys()];
        },
        unmountByPlugin,
    };
}
