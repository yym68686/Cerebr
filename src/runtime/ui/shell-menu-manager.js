import { pluginUiStore } from './plugin-ui-store.js';
import { uiStore } from '../../app/state/ui-store.js';
function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function normalizeNumber(value, fallback = 0) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizeMenuItemIconPlacement(value, fallback = 'leading') {
    const normalized = normalizeString(value, fallback).toLowerCase();
    return normalized === 'disclosure'
        ? 'disclosure'
        : 'leading';
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

export function createMenuItemSvgElement(source = '') {
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
        iconPlacement: normalizeMenuItemIconPlacement(item.iconPlacement),
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

    function render() {
        const menu = getRenderableRecords().flatMap(([pluginId, record]) => record.items.map(item => ({ pluginId, item, dispatch: element => { uiStore.set({ menu: false, webpageMenu: false }); dispatch(pluginId, item, element); } }))).sort((a,b) => a.item.order-b.item.order);
        pluginUiStore.set({ menu });
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
