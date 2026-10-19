export function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

export function normalizeNumber(value, fallback = 0) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : fallback;
}

export function normalizeBoolean(value, fallback = false) {
    if (typeof value === 'boolean') {
        return value;
    }
    if (value == null) {
        return fallback;
    }
    return !!value;
}

export function normalizeTone(value, fallback = 'default') {
    const tone = normalizeString(value, fallback).toLowerCase();
    return ['default', 'primary', 'success', 'warning', 'danger', 'muted'].includes(tone)
        ? tone
        : fallback;
}

export function cloneValue(value, fallback = null) {
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

export function valuesEqual(left, right) {
    return Object.is(left, right);
}

export function cloneRect(rect = null) {
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

export function measureAnchorRect(element) {
    const rect = element?.getBoundingClientRect?.();
    return rect ? cloneRect(rect) : null;
}

const SORTABLE_LIST_DRAG_DATA_TYPE = 'application/x-cerebr-sortable-item';
const SORTABLE_POINTER_ACTIVATION_DISTANCE = 4;

export function normalizeListDragPreview(value, sortable = false) {
    if (!sortable) {
        return '';
    }

    const preview = normalizeString(value, 'inline').toLowerCase();
    return preview === 'native' ? 'native' : 'inline';
}

export function normalizeListDragHandle(value, sortable = false) {
    if (!sortable) {
        return '';
    }

    const handle = normalizeString(value, 'comfortable').toLowerCase();
    return handle === 'compact' ? 'compact' : 'comfortable';
}

export function normalizeListSortingStyle(value, sortable = false, dragPreview = '') {
    if (!sortable) {
        return '';
    }

    const fallback = dragPreview === 'inline' ? 'emphasized' : 'default';
    const style = normalizeString(value, fallback).toLowerCase();
    return style === 'emphasized' ? 'emphasized' : 'default';
}

export function normalizeListDropIndicator(value, sortable = false, dragPreview = '') {
    if (!sortable) {
        return '';
    }

    const fallback = dragPreview === 'inline' ? 'none' : 'line';
    const indicator = normalizeString(value, fallback).toLowerCase();
    return indicator === 'line' ? 'line' : 'none';
}

export function normalizeBadgeDescriptor(badge = {}, index = 0) {
    if (typeof badge === 'string' || typeof badge === 'number') {
        return {
            id: `badge-${index}`,
            label: String(badge),
            tone: 'default',
        };
    }

    const label = normalizeString(badge?.label);
    if (!label) {
        return null;
    }

    return {
        id: normalizeString(badge?.id, `badge-${index}`),
        label,
        tone: normalizeTone(badge?.tone, 'default'),
    };
}

export function normalizeStatDescriptor(stat = {}, index = 0) {
    if (typeof stat === 'string' || typeof stat === 'number') {
        return {
            id: `stat-${index}`,
            label: '',
            value: String(stat),
            tone: 'default',
        };
    }

    const value = stat?.value == null ? '' : String(stat.value);
    if (!value) {
        return null;
    }

    return {
        id: normalizeString(stat?.id, `stat-${index}`),
        label: normalizeString(stat?.label),
        value,
        tone: normalizeTone(stat?.tone, 'default'),
    };
}

export function normalizeActionDescriptor(action = {}, index = 0) {
    const id = normalizeString(action?.id);
    if (!id) {
        return null;
    }

    const label = normalizeString(action?.label);
    const icon = normalizeString(action?.icon);
    if (!label && !icon) {
        return null;
    }

    const variant = normalizeString(
        action?.variant,
        icon && !label ? 'ghost' : 'secondary'
    ).toLowerCase();
    const kind = normalizeString(action?.kind, 'button').toLowerCase();

    return {
        id,
        label,
        icon,
        title: normalizeString(action?.title, label || icon || id),
        variant: ['primary', 'secondary', 'ghost', 'success', 'warning', 'danger'].includes(variant)
            ? variant
            : 'secondary',
        kind: ['button', 'file'].includes(kind) ? kind : 'button',
        disabled: !!action?.disabled,
        confirm: normalizeString(action?.confirm),
        accept: normalizeString(action?.accept),
        multiple: !!action?.multiple,
        data: cloneValue(action?.data, null),
    };
}

export function normalizeFieldOption(option = {}, index = 0) {
    const value = option?.value == null ? '' : String(option.value);
    return {
        id: normalizeString(option?.id, `option-${index}`),
        value,
        label: normalizeString(option?.label, value),
    };
}

export function normalizeFieldDescriptor(field = {}, index = 0) {
    const id = normalizeString(field?.id, `field-${index}`);
    const type = normalizeString(field?.type, 'text').toLowerCase();
    if (!['text', 'textarea', 'color', 'checkbox', 'select'].includes(type)) {
        return null;
    }

    return {
        id,
        label: normalizeString(field?.label, id),
        type,
        value: type === 'checkbox'
            ? normalizeBoolean(field?.value)
            : (field?.value == null ? '' : String(field.value)),
        placeholder: normalizeString(field?.placeholder),
        description: normalizeString(field?.description),
        disabled: !!field?.disabled,
        span: field?.span === 2 || field?.span === 'full' ? 2 : 1,
        rows: Math.max(2, normalizeNumber(field?.rows, 4)),
        action: type === 'checkbox'
            ? null
            : normalizeActionDescriptor(field?.action, index),
        options: Array.isArray(field?.options)
            ? field.options.map((option, optionIndex) => normalizeFieldOption(option, optionIndex))
            : [],
    };
}

export function measureTextLength(value = '') {
    return Array.from(String(value ?? '')).length;
}

export function normalizePaginationControlDescriptor(control = {}, index = 0) {
    const fieldId = normalizeString(control?.fieldId, `pagination-field-${index}`);
    const type = normalizeString(control?.type, 'select').toLowerCase();

    if (!fieldId) {
        return null;
    }

    const baseDescriptor = {
        fieldId,
        type: type === 'input' ? 'number' : type,
        label: normalizeString(control?.label),
        value: control?.value == null ? '' : String(control.value),
        disabled: !!control?.disabled,
        suffix: normalizeString(control?.suffix),
    };

    if (baseDescriptor.type === 'number') {
        const min = Math.max(1, Math.floor(normalizeNumber(control?.min, 1)));
        const normalizedMax = Math.floor(normalizeNumber(control?.max, 0));
        return {
            ...baseDescriptor,
            min,
            max: normalizedMax > 0 ? Math.max(min, normalizedMax) : 0,
            step: Math.max(1, Math.floor(normalizeNumber(control?.step, 1))),
            placeholder: normalizeString(control?.placeholder),
        };
    }

    const options = Array.isArray(control?.options)
        ? control.options.map((option, optionIndex) => normalizeFieldOption(option, optionIndex))
        : [];

    if (options.length === 0) {
        return null;
    }

    return {
        ...baseDescriptor,
        options,
    };
}

export function normalizePaginationButtonDescriptor(button = {}, index = 0) {
    const label = normalizeString(button?.label);
    if (!label) {
        return null;
    }

    return {
        id: normalizeString(button?.id, `pagination-button-${index}`),
        label,
        title: normalizeString(button?.title, label),
        actionId: normalizeString(button?.actionId),
        selected: !!button?.selected,
        disabled: !!button?.disabled,
    };
}

export function normalizeListItemDescriptor(item = {}, index = 0) {
    const id = normalizeString(item?.id, `item-${index}`);
    const title = normalizeString(item?.title);
    if (!title) {
        return null;
    }

    return {
        id,
        title,
        token: normalizeString(item?.token),
        description: normalizeString(item?.description),
        meta: normalizeString(item?.meta),
        selected: !!item?.selected,
        badges: Array.isArray(item?.badges)
            ? item.badges.map((badge, badgeIndex) => normalizeBadgeDescriptor(badge, badgeIndex)).filter(Boolean)
            : [],
        body: Array.isArray(item?.body)
            ? item.body.map((node, nodeIndex) => normalizeContentDescriptor(node, nodeIndex)).filter(Boolean)
            : [],
        actionId: normalizeString(item?.actionId),
        actions: Array.isArray(item?.actions)
            ? item.actions.map((action, actionIndex) => normalizeActionDescriptor(action, actionIndex)).filter(Boolean)
            : [],
    };
}

export function normalizeContentDescriptor(node = {}, index = 0) {
    const kind = normalizeString(node?.kind, 'text').toLowerCase();

    if (kind === 'text') {
        const text = normalizeString(node?.text);
        if (!text) {
            return null;
        }

        return {
            kind,
            id: normalizeString(node?.id, `text-${index}`),
            text,
            tone: normalizeTone(node?.tone, 'default'),
        };
    }

    if (kind === 'note') {
        const text = normalizeString(node?.text);
        const title = normalizeString(node?.title);
        if (!title && !text) {
            return null;
        }

        return {
            kind,
            id: normalizeString(node?.id, `note-${index}`),
            title,
            text,
            icon: normalizeString(node?.icon),
            tone: normalizeTone(node?.tone, 'default'),
        };
    }

    if (kind === 'stats') {
        const items = Array.isArray(node?.items)
            ? node.items.map((stat, statIndex) => normalizeStatDescriptor(stat, statIndex)).filter(Boolean)
            : [];
        if (items.length === 0) {
            return null;
        }

        return {
            kind,
            id: normalizeString(node?.id, `stats-${index}`),
            items,
        };
    }

    if (kind === 'actions') {
        const actions = Array.isArray(node?.actions)
            ? node.actions.map((action, actionIndex) => normalizeActionDescriptor(action, actionIndex)).filter(Boolean)
            : [];
        if (actions.length === 0) {
            return null;
        }

        return {
            kind,
            id: normalizeString(node?.id, `actions-${index}`),
            actions,
            align: normalizeString(node?.align, 'start'),
        };
    }

    if (kind === 'form') {
        const fields = Array.isArray(node?.fields)
            ? node.fields.map((field, fieldIndex) => normalizeFieldDescriptor(field, fieldIndex)).filter(Boolean)
            : [];
        if (fields.length === 0) {
            return null;
        }

        return {
            kind,
            id: normalizeString(node?.id, `form-${index}`),
            columns: node?.columns === 1 ? 1 : 2,
            fields,
        };
    }

    if (kind === 'list') {
        const sortable = !!node?.sortable;
        const dragPreview = normalizeListDragPreview(node?.dragPreview, sortable);
        return {
            kind,
            id: normalizeString(node?.id, `list-${index}`),
            emptyText: normalizeString(node?.emptyText),
            sortable,
            dragPreview,
            dragHandle: normalizeListDragHandle(node?.dragHandle, sortable),
            sortingStyle: normalizeListSortingStyle(node?.sortingStyle, sortable, dragPreview),
            dropIndicator: normalizeListDropIndicator(node?.dropIndicator, sortable, dragPreview),
            items: Array.isArray(node?.items)
                ? node.items.map((item, itemIndex) => normalizeListItemDescriptor(item, itemIndex)).filter(Boolean)
                : [],
        };
    }

    if (kind === 'pagination') {
        const pages = Array.isArray(node?.pages)
            ? node.pages.map((page, pageIndex) => normalizePaginationButtonDescriptor(page, pageIndex)).filter(Boolean)
            : [];
        const previousAction = normalizePaginationButtonDescriptor(node?.previousAction, 0);
        const nextAction = normalizePaginationButtonDescriptor(node?.nextAction, 1);
        const pageSize = normalizePaginationControlDescriptor(node?.pageSize, 0);
        const jump = normalizePaginationControlDescriptor(node?.jump, 1);

        if (!pages.length && !previousAction && !nextAction && !pageSize && !jump) {
            return null;
        }

        return {
            kind,
            id: normalizeString(node?.id, `pagination-${index}`),
            pages,
            previousAction,
            nextAction,
            pageSize,
            jump,
        };
    }

    if (kind === 'badges') {
        const badges = Array.isArray(node?.items)
            ? node.items.map((badge, badgeIndex) => normalizeBadgeDescriptor(badge, badgeIndex)).filter(Boolean)
            : [];
        if (badges.length === 0) {
            return null;
        }

        return {
            kind,
            id: normalizeString(node?.id, `badges-${index}`),
            items: badges,
        };
    }

    return null;
}

export function normalizeCardDescriptor(card = {}, index = 0) {
    const body = Array.isArray(card?.body)
        ? card.body.map((node, nodeIndex) => normalizeContentDescriptor(node, nodeIndex)).filter(Boolean)
        : [];
    const variant = normalizeString(card?.variant, 'default').toLowerCase();

    return {
        kind: 'card',
        id: normalizeString(card?.id, `card-${index}`),
        title: normalizeString(card?.title),
        description: normalizeString(card?.description),
        variant: ['default', 'highlight', 'subtle', 'danger'].includes(variant)
            ? variant
            : 'default',
        body,
    };
}

export function normalizeSectionDescriptor(section = {}, index = 0) {
    const kind = normalizeString(section?.kind, 'card').toLowerCase();

    if (kind === 'hero') {
        const actions = Array.isArray(section?.actions)
            ? section.actions.map((action, actionIndex) => normalizeActionDescriptor(action, actionIndex)).filter(Boolean)
            : [];
        const badges = Array.isArray(section?.badges)
            ? section.badges.map((badge, badgeIndex) => normalizeBadgeDescriptor(badge, badgeIndex)).filter(Boolean)
            : [];
        return {
            kind,
            id: normalizeString(section?.id, `hero-${index}`),
            eyebrow: normalizeString(section?.eyebrow),
            title: normalizeString(section?.title),
            description: normalizeString(section?.description),
            compact: !!section?.compact,
            actions,
            badges,
        };
    }

    if (kind === 'columns') {
        const columns = Array.isArray(section?.columns)
            ? section.columns.map((column, columnIndex) => ({
                id: `column-${columnIndex}`,
                blocks: Array.isArray(column)
                    ? column.map((card, cardIndex) => normalizeCardDescriptor(card, cardIndex)).filter(Boolean)
                    : [],
            }))
            : [];
        if (columns.length === 0) {
            return null;
        }

        return {
            kind,
            id: normalizeString(section?.id, `columns-${index}`),
            columns,
        };
    }

    return normalizeCardDescriptor(section, index);
}

export function normalizeViewDescriptor(view = {}) {
    const sections = Array.isArray(view?.sections)
        ? view.sections.map((section, index) => normalizeSectionDescriptor(section, index)).filter(Boolean)
        : [];

    return {
        sections,
    };
}

export function cloneValues(session) {
    const values = {};
    const activeFieldIds = session?.activeFieldIds instanceof Set
        ? session.activeFieldIds
        : new Set();

    activeFieldIds.forEach((fieldId) => {
        values[fieldId] = session?.fieldValues?.[fieldId];
    });

    return cloneValue(values, values) || values;
}

export function updateFieldValue(session, fieldId, value) {
    if (!session.fieldValues || typeof session.fieldValues !== 'object') {
        session.fieldValues = {};
    }
    session.fieldValues[fieldId] = value;
}

export function collectViewFieldValues(view = {}) {
    const values = {};

    function assignFieldValue(fieldId, value) {
        const normalizedFieldId = normalizeString(fieldId);
        if (!normalizedFieldId) {
            return;
        }
        values[normalizedFieldId] = cloneValue(value, value);
    }

    function visitContentNode(node = {}) {
        if (!node || typeof node !== 'object') {
            return;
        }

        if (node.kind === 'form' && Array.isArray(node.fields)) {
            node.fields.forEach((field) => {
                assignFieldValue(field?.id, field?.value);
            });
            return;
        }

        if (node.kind === 'pagination') {
            assignFieldValue(node?.pageSize?.fieldId, node?.pageSize?.value);
            assignFieldValue(node?.jump?.fieldId, node?.jump?.value);
            return;
        }
    }

    function visitCard(card = {}) {
        if (!card || typeof card !== 'object' || !Array.isArray(card.body)) {
            return;
        }
        card.body.forEach(visitContentNode);
    }

    if (!Array.isArray(view?.sections)) {
        return values;
    }

    view.sections.forEach((section) => {
        if (!section || typeof section !== 'object') {
            return;
        }

        if (section.kind === 'columns' && Array.isArray(section.columns)) {
            section.columns.forEach((column) => {
                if (!Array.isArray(column?.blocks)) {
                    return;
                }
                column.blocks.forEach(visitCard);
            });
            return;
        }

        visitCard(section);
    });

    return values;
}

export function reconcileSessionFieldValues(session, view) {
    if (!session || typeof session !== 'object') {
        return;
    }

    if (!session.fieldValues || typeof session.fieldValues !== 'object') {
        session.fieldValues = {};
    }

    const nextRenderedFieldValues = collectViewFieldValues(view);
    const previousRenderedFieldValues = session.renderedFieldValues && typeof session.renderedFieldValues === 'object'
        ? session.renderedFieldValues
        : {};

    Object.entries(nextRenderedFieldValues).forEach(([fieldId, nextValue]) => {
        const hasPreviousRenderedValue = Object.prototype.hasOwnProperty.call(previousRenderedFieldValues, fieldId);
        const hasSessionValue = Object.prototype.hasOwnProperty.call(session.fieldValues, fieldId);
        const previousRenderedValue = previousRenderedFieldValues[fieldId];
        if (!hasSessionValue || !hasPreviousRenderedValue || !valuesEqual(previousRenderedValue, nextValue)) {
            session.fieldValues[fieldId] = cloneValue(nextValue, nextValue);
        }
    });

    session.renderedFieldValues = nextRenderedFieldValues;
}

export function readFieldValue(session, field) {
    if (Object.prototype.hasOwnProperty.call(session?.fieldValues || {}, field.id)) {
        return session.fieldValues[field.id];
    }

    return field.value;
}

export function dispatchInteraction({ session, dispatchEvent, payload }) {
    dispatchEvent({
        ...payload,
        page: { ...session.page },
    });
}

export function moveListItems(items = [], draggedId = '', targetId = '', beforeTarget = false) {
    const orderedItemIds = Array.isArray(items)
        ? items.map((item) => normalizeString(typeof item === 'string' ? item : item?.id)).filter(Boolean)
        : [];
    const fromIndex = orderedItemIds.indexOf(normalizeString(draggedId));
    const targetIndex = orderedItemIds.indexOf(normalizeString(targetId));

    if (fromIndex === -1 || targetIndex === -1 || fromIndex === targetIndex) {
        return null;
    }

    let insertionIndex = targetIndex;
    if (beforeTarget) {
        insertionIndex = targetIndex > fromIndex ? targetIndex - 1 : targetIndex;
    } else {
        insertionIndex = targetIndex > fromIndex ? targetIndex : targetIndex + 1;
    }

    if (insertionIndex === fromIndex) {
        return null;
    }

    const nextOrderedItemIds = orderedItemIds.slice();
    const [movedId] = nextOrderedItemIds.splice(fromIndex, 1);
    nextOrderedItemIds.splice(insertionIndex, 0, movedId);

    return {
        orderedItemIds: nextOrderedItemIds,
        fromIndex,
        toIndex: insertionIndex,
    };
}

export function describeListReorder(items = [], orderedItemIds = [], movedItemId = '') {
    const initialOrderedItemIds = Array.isArray(items)
        ? items.map((item) => normalizeString(typeof item === 'string' ? item : item?.id)).filter(Boolean)
        : [];
    const nextOrderedItemIds = Array.isArray(orderedItemIds)
        ? orderedItemIds.map((itemId) => normalizeString(itemId)).filter(Boolean)
        : [];
    const normalizedMovedItemId = normalizeString(movedItemId);

    if (
        initialOrderedItemIds.length === 0
        || initialOrderedItemIds.length !== nextOrderedItemIds.length
        || !normalizedMovedItemId
    ) {
        return null;
    }

    const missingIds = initialOrderedItemIds.some((itemId) => !nextOrderedItemIds.includes(itemId));
    if (missingIds) {
        return null;
    }

    const fromIndex = initialOrderedItemIds.indexOf(normalizedMovedItemId);
    const toIndex = nextOrderedItemIds.indexOf(normalizedMovedItemId);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
        return null;
    }

    return {
        orderedItemIds: nextOrderedItemIds,
        fromIndex,
        toIndex,
    };
}
