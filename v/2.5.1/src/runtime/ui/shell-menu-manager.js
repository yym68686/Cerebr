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

const SVG_NS = 'http://www.w3.org/2000/svg';
const MENU_ITEM_SVG_ALLOWED_TAGS = new Set([
    'svg',
    'g',
    'path',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'rect',
]);
const MENU_ITEM_SVG_ALLOWED_ATTRS = new Set([
    'viewbox',
    'fill',
    'stroke',
    'stroke-width',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-miterlimit',
    'fill-rule',
    'clip-rule',
    'opacity',
    'transform',
    'rx',
    'ry',
    'cx',
    'cy',
    'r',
    'x',
    'y',
    'x1',
    'x2',
    'y1',
    'y2',
    'points',
    'd',
    'width',
    'height',
    'vector-effect',
    'preserveaspectratio',
]);

function isSafeMenuItemSvgAttrValue(value = '') {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
        return false;
    }

    return !/javascript:/i.test(normalized) && !/url\s*\(/i.test(normalized);
}

function cloneSafeMenuItemSvgNode(sourceNode, { isRoot = false } = {}) {
    if (!(sourceNode instanceof Element)) {
        return null;
    }

    const tagName = normalizeString(sourceNode.localName).toLowerCase();
    if (!MENU_ITEM_SVG_ALLOWED_TAGS.has(tagName)) {
        return null;
    }

    const targetNode = document.createElementNS(SVG_NS, tagName);

    sourceNode.getAttributeNames().forEach((attrName) => {
        const normalizedAttrName = String(attrName).toLowerCase();
        if (!MENU_ITEM_SVG_ALLOWED_ATTRS.has(normalizedAttrName)) {
            return;
        }

        const attrValue = sourceNode.getAttribute(attrName);
        if (!isSafeMenuItemSvgAttrValue(attrValue)) {
            return;
        }

        targetNode.setAttribute(attrName, attrValue);
    });

    if (isRoot) {
        targetNode.classList.add('cerebr-plugin-menu-item__icon-svg');
        targetNode.setAttribute('aria-hidden', 'true');
        targetNode.setAttribute('focusable', 'false');
    }

    Array.from(sourceNode.children).forEach((childNode) => {
        const clonedChild = cloneSafeMenuItemSvgNode(childNode);
        if (clonedChild) {
            targetNode.appendChild(clonedChild);
        }
    });

    return targetNode;
}

function createMenuItemSvgElement(source = '') {
    const normalizedSource = normalizeString(source);
    if (!normalizedSource || typeof DOMParser !== 'function' || typeof document === 'undefined') {
        return null;
    }

    try {
        const parsed = new DOMParser().parseFromString(normalizedSource, 'image/svg+xml');
        const rootNode = parsed?.documentElement;
        const hasParseError = normalizeString(rootNode?.localName).toLowerCase() === 'parsererror'
            || parsed?.getElementsByTagName?.('parsererror')?.length > 0;
        if (hasParseError || !(rootNode instanceof Element)) {
            return null;
        }

        return cloneSafeMenuItemSvgNode(rootNode, { isRoot: true });
    } catch {
        return null;
    }
}

function createMenuItemIconElement(item = {}) {
    const iconWrapper = document.createElement('span');
    iconWrapper.className = 'cerebr-plugin-menu-item__icon';
    iconWrapper.setAttribute('aria-hidden', 'true');

    const svgIcon = createMenuItemSvgElement(item.iconSvg);
    if (svgIcon) {
        iconWrapper.appendChild(svgIcon);
        return iconWrapper;
    }

    const iconText = normalizeString(item.icon);
    if (!iconText) {
        return null;
    }

    iconWrapper.classList.add('cerebr-plugin-menu-item__icon--text');
    iconWrapper.textContent = iconText;
    return iconWrapper;
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
        iconSvg: normalizeString(item.iconSvg),
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
        const icon = createMenuItemIconElement(item);
        if (icon) {
            label.appendChild(icon);
        }
        const text = document.createElement('span');
        text.className = 'cerebr-plugin-menu-item__text';
        text.textContent = item.label;
        label.appendChild(text);
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
