import { pluginUiStore } from './plugin-ui-store.js';
function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function normalizeNumber(value, fallback = 0) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : fallback;
}

function cloneRect(rect = null) {
    if (!rect || typeof rect !== 'object') {
        return null;
    }

    return {
        x: normalizeNumber(rect.x),
        y: normalizeNumber(rect.y),
        top: normalizeNumber(rect.top),
        right: normalizeNumber(rect.right),
        bottom: normalizeNumber(rect.bottom),
        left: normalizeNumber(rect.left),
        width: normalizeNumber(rect.width),
        height: normalizeNumber(rect.height),
    };
}

function measureAnchorRect(target) {
    const rect = target?.getBoundingClientRect?.();
    return rect ? cloneRect(rect) : null;
}

function normalizeActionDescriptor(action = {}, index = 0) {
    const id = normalizeString(action.id);
    if (!id) {
        return null;
    }

    const label = normalizeString(action.label);
    const icon = normalizeString(action.icon);
    if (!label && !icon) {
        return null;
    }
    const title = normalizeString(action.title, label || icon || id);
    const variant = normalizeString(
        action.variant,
        icon && !label ? 'ghost' : 'soft'
    ).toLowerCase();

    return {
        id,
        label,
        icon,
        title,
        variant: ['ghost', 'soft', 'solid'].includes(variant) ? variant : 'soft',
        disabled: !!action.disabled,
        background: normalizeString(action.background),
        color: normalizeString(action.color),
        order: normalizeNumber(action.order, index),
        iconOnly: !label && !!icon,
    };
}

function createPluginRecord() {
    return {
        actions: [],
        listeners: new Set(),
    };
}

function createActionPayload(action = {}, button = null) {
    return {
        actionId: action.id,
        action: { ...action },
        anchorRect: measureAnchorRect(button),
    };
}

export function createShellInputActionManager({
    container = null,
    logger = console,
} = {}) {
    const pluginRecords = new Map();

    function ensurePluginRecord(pluginId) {
        const normalizedPluginId = normalizeString(pluginId);
        if (!normalizedPluginId) {
            return null;
        }

        let record = pluginRecords.get(normalizedPluginId);
        if (!record) {
            record = createPluginRecord();
            pluginRecords.set(normalizedPluginId, record);
        }
        return record;
    }

    function prunePluginRecord(pluginId) {
        const normalizedPluginId = normalizeString(pluginId);
        if (!normalizedPluginId) {
            return false;
        }

        const record = pluginRecords.get(normalizedPluginId);
        if (!record) {
            return false;
        }

        if (record.actions.length > 0 || record.listeners.size > 0) {
            return false;
        }

        pluginRecords.delete(normalizedPluginId);
        return true;
    }

    function getRenderableRecords() {
        return Array.from(pluginRecords.entries())
            .filter(([, record]) => Array.isArray(record.actions) && record.actions.length > 0);
    }

    function dispatch(pluginId, action, button) {
        const normalizedPluginId = normalizeString(pluginId);
        const record = pluginRecords.get(normalizedPluginId);
        if (!record || record.listeners.size === 0) {
            return false;
        }

        const payload = createActionPayload(action, button);
        let dispatched = false;

        record.listeners.forEach((listener) => {
            try {
                listener(payload);
                dispatched = true;
            } catch (error) {
                logger?.error?.('[Cerebr] Failed to handle shell input action click', error);
            }
        });

        return dispatched;
    }

    function render() {
        pluginUiStore.set({ actions: getRenderableRecords().map(([pluginId, record]) => ({ pluginId, actions: [...record.actions].sort((a,b) => a.order-b.order), dispatch: (action, button) => dispatch(pluginId, action, button) })) });
        return true;
    }

    return {
        setActions(pluginId, actions = []) {
            const record = ensurePluginRecord(pluginId);
            if (!record) {
                return [];
            }

            record.actions = Array.isArray(actions)
                ? actions
                    .map((action, index) => normalizeActionDescriptor(action, index))
                    .filter(Boolean)
                : [];

            render();
            return record.actions.map((action) => ({ ...action }));
        },
        clearActions(pluginId) {
            const normalizedPluginId = normalizeString(pluginId);
            const record = pluginRecords.get(normalizedPluginId);
            if (!record) {
                return false;
            }

            record.actions = [];
            prunePluginRecord(normalizedPluginId);
            render();
            return true;
        },
        addListener(pluginId, listener) {
            if (typeof listener !== 'function') {
                return () => {};
            }

            const record = ensurePluginRecord(pluginId);
            if (!record) {
                return () => {};
            }

            record.listeners.add(listener);

            return () => {
                const normalizedPluginId = normalizeString(pluginId);
                const currentRecord = pluginRecords.get(normalizedPluginId);
                if (!currentRecord) {
                    return;
                }

                currentRecord.listeners.delete(listener);
                prunePluginRecord(normalizedPluginId);
            };
        },
        removePlugin(pluginId) {
            const normalizedPluginId = normalizeString(pluginId);
            if (!normalizedPluginId) {
                return false;
            }

            const deleted = pluginRecords.delete(normalizedPluginId);
            render();
            return deleted;
        },
    };
}
