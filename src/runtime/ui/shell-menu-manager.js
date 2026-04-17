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

function normalizeMenuItemDescriptor(item = {}, index = 0) {
    const id = normalizeString(item.id);
    const label = normalizeString(item.label);
    if (!id || !label) {
        return null;
    }

    return {
        id,
        label,
        icon: normalizeString(item.icon),
        title: normalizeString(item.title, label),
        order: normalizeNumber(item.order, index),
        disclosure: item.disclosure !== false,
        disabled: !!item.disabled,
    };
}

function createPluginRecord() {
    return {
        items: [],
        listeners: new Set(),
    };
}

function createMenuActionPayload(item = {}, element = null) {
    return {
        itemId: item.id,
        item: { ...item },
        anchorRect: measureAnchorRect(element),
    };
}

export function createShellMenuManager({
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
        const record = pluginRecords.get(normalizedPluginId);
        if (!record) {
            return false;
        }

        if (record.items.length > 0 || record.listeners.size > 0) {
            return false;
        }

        pluginRecords.delete(normalizedPluginId);
        return true;
    }

    function getRenderableRecords() {
        return Array.from(pluginRecords.entries())
            .filter(([, record]) => Array.isArray(record.items) && record.items.length > 0);
    }

    function closeHostSettingsMenu() {
        const menu = container?.closest?.('#settings-menu');
        if (menu instanceof HTMLElement) {
            menu.classList.remove('visible');
        }
    }

    function dispatch(pluginId, item, element) {
        const normalizedPluginId = normalizeString(pluginId);
        const record = pluginRecords.get(normalizedPluginId);
        if (!record || record.listeners.size === 0) {
            return false;
        }

        const payload = createMenuActionPayload(item, element);
        let dispatched = false;

        record.listeners.forEach((listener) => {
            try {
                listener(payload);
                dispatched = true;
            } catch (error) {
                logger?.error?.('[Cerebr] Failed to handle shell menu action', error);
            }
        });

        return dispatched;
    }

    function createMenuItemElement(pluginId, item) {
        const element = document.createElement('div');
        element.className = 'menu-item cerebr-plugin-menu-item';
        element.role = 'menuitem';
        element.tabIndex = item.disabled ? -1 : 0;
        element.dataset.pluginId = normalizeString(pluginId);
        element.dataset.pluginMenuItem = item.id;
        element.setAttribute('aria-disabled', item.disabled ? 'true' : 'false');

        if (item.title) {
            element.title = item.title;
        }

        const label = document.createElement('span');
        label.className = 'cerebr-plugin-menu-item__label';
        label.textContent = item.icon ? `${item.icon} ${item.label}` : item.label;
        element.appendChild(label);

        if (item.disclosure) {
            const chevron = document.createElement('span');
            chevron.className = 'cerebr-plugin-menu-item__chevron';
            chevron.setAttribute('aria-hidden', 'true');
            chevron.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 12L10 8L6 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
            element.appendChild(chevron);
        }

        const activate = (event) => {
            if (item.disabled) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            closeHostSettingsMenu();
            dispatch(pluginId, item, element);
        };

        element.addEventListener('click', activate);
        element.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                activate(event);
            }
        });

        return element;
    }

    function render() {
        if (!(container instanceof Element)) {
            return false;
        }

        const records = getRenderableRecords();
        container.replaceChildren();
        container.hidden = records.length === 0;

        if (records.length === 0) {
            return true;
        }

        const items = [];
        records.forEach(([pluginId, record]) => {
            record.items.forEach((item) => {
                items.push({
                    pluginId,
                    item,
                });
            });
        });

        items
            .sort((left, right) => left.item.order - right.item.order)
            .forEach(({ pluginId, item }) => {
                container.appendChild(createMenuItemElement(pluginId, item));
            });

        return true;
    }

    return {
        setItems(pluginId, items = []) {
            const record = ensurePluginRecord(pluginId);
            if (!record) {
                return [];
            }

            record.items = Array.isArray(items)
                ? items
                    .map((item, index) => normalizeMenuItemDescriptor(item, index))
                    .filter(Boolean)
                : [];

            render();
            return record.items.map((item) => ({ ...item }));
        },
        clearItems(pluginId) {
            const normalizedPluginId = normalizeString(pluginId);
            const record = pluginRecords.get(normalizedPluginId);
            if (!record) {
                return false;
            }

            record.items = [];
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
                record.listeners.delete(listener);
                prunePluginRecord(pluginId);
            };
        },
        removePlugin(pluginId) {
            const normalizedPluginId = normalizeString(pluginId);
            const record = pluginRecords.get(normalizedPluginId);
            if (!record) {
                return false;
            }

            record.items = [];
            record.listeners.clear();
            pluginRecords.delete(normalizedPluginId);
            render();
            return true;
        },
        render,
    };
}
