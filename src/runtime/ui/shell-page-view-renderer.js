function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function normalizeNumber(value, fallback = 0) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizeBoolean(value, fallback = false) {
    if (typeof value === 'boolean') {
        return value;
    }
    if (value == null) {
        return fallback;
    }
    return !!value;
}

function normalizeTone(value, fallback = 'default') {
    const tone = normalizeString(value, fallback).toLowerCase();
    return ['default', 'primary', 'success', 'warning', 'danger', 'muted'].includes(tone)
        ? tone
        : fallback;
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

function measureAnchorRect(element) {
    const rect = element?.getBoundingClientRect?.();
    return rect ? cloneRect(rect) : null;
}

function createElement(tagName, className = '') {
    const element = document.createElement(tagName);
    if (className) {
        element.className = className;
    }
    return element;
}

function normalizeBadgeDescriptor(badge = {}, index = 0) {
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

function normalizeStatDescriptor(stat = {}, index = 0) {
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

function normalizeActionDescriptor(action = {}, index = 0) {
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

function normalizeFieldOption(option = {}, index = 0) {
    const value = option?.value == null ? '' : String(option.value);
    return {
        id: normalizeString(option?.id, `option-${index}`),
        value,
        label: normalizeString(option?.label, value),
    };
}

function normalizeFieldDescriptor(field = {}, index = 0) {
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
        options: Array.isArray(field?.options)
            ? field.options.map((option, optionIndex) => normalizeFieldOption(option, optionIndex))
            : [],
    };
}

function normalizeListItemDescriptor(item = {}, index = 0) {
    const id = normalizeString(item?.id, `item-${index}`);
    const title = normalizeString(item?.title);
    if (!title) {
        return null;
    }

    return {
        id,
        title,
        description: normalizeString(item?.description),
        meta: normalizeString(item?.meta),
        selected: !!item?.selected,
        badges: Array.isArray(item?.badges)
            ? item.badges.map((badge, badgeIndex) => normalizeBadgeDescriptor(badge, badgeIndex)).filter(Boolean)
            : [],
        actionId: normalizeString(item?.actionId),
        actions: Array.isArray(item?.actions)
            ? item.actions.map((action, actionIndex) => normalizeActionDescriptor(action, actionIndex)).filter(Boolean)
            : [],
    };
}

function normalizeContentDescriptor(node = {}, index = 0) {
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
        return {
            kind,
            id: normalizeString(node?.id, `list-${index}`),
            emptyText: normalizeString(node?.emptyText),
            items: Array.isArray(node?.items)
                ? node.items.map((item, itemIndex) => normalizeListItemDescriptor(item, itemIndex)).filter(Boolean)
                : [],
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

function normalizeCardDescriptor(card = {}, index = 0) {
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

function normalizeSectionDescriptor(section = {}, index = 0) {
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

function normalizeViewDescriptor(view = {}) {
    const sections = Array.isArray(view?.sections)
        ? view.sections.map((section, index) => normalizeSectionDescriptor(section, index)).filter(Boolean)
        : [];

    return {
        sections,
    };
}

function cloneValues(session) {
    const values = {};
    const activeFieldIds = session?.activeFieldIds instanceof Set
        ? session.activeFieldIds
        : new Set();

    activeFieldIds.forEach((fieldId) => {
        values[fieldId] = session?.fieldValues?.[fieldId];
    });

    return cloneValue(values, values) || values;
}

function updateFieldValue(session, fieldId, value) {
    if (!session.fieldValues || typeof session.fieldValues !== 'object') {
        session.fieldValues = {};
    }
    session.fieldValues[fieldId] = value;
}

function readFieldValue(session, field) {
    if (Object.prototype.hasOwnProperty.call(session?.fieldValues || {}, field.id)) {
        return session.fieldValues[field.id];
    }

    return field.value;
}

function dispatchInteraction({ session, dispatchEvent, payload }) {
    dispatchEvent({
        ...payload,
        page: { ...session.page },
    });
}

function createBadgeElement(badge) {
    const element = createElement('span', 'cerebr-plugin-page-badge');
    element.dataset.tone = badge.tone;
    element.textContent = badge.label;
    return element;
}

function createActionButton({
    action,
    session,
    dispatchEvent,
    logger,
}) {
    const button = createElement('button', 'cerebr-plugin-page-action');
    button.type = 'button';
    button.dataset.variant = action.variant;
    button.dataset.actionId = action.id;
    button.disabled = !!action.disabled;

    if (action.title) {
        button.title = action.title;
        button.setAttribute('aria-label', action.title);
    }

    if (action.icon) {
        const icon = createElement('span', 'cerebr-plugin-page-action__icon');
        icon.textContent = action.icon;
        button.appendChild(icon);
    }

    if (action.label) {
        const label = createElement('span', 'cerebr-plugin-page-action__label');
        label.textContent = action.label;
        button.appendChild(label);
    }

    if (!action.label && action.icon) {
        button.classList.add('cerebr-plugin-page-action--icon-only');
    }

    async function handleFileAction() {
        const input = document.createElement('input');
        input.type = 'file';
        input.hidden = true;
        if (action.accept) {
            input.accept = action.accept;
        }
        if (action.multiple) {
            input.multiple = true;
        }

        input.addEventListener('change', () => {
            const files = Array.from(input.files || []);
            void Promise.all(files.map(async (file) => {
                let text = '';
                try {
                    text = await file.text();
                } catch {
                    text = '';
                }
                return {
                    name: String(file.name || ''),
                    type: String(file.type || ''),
                    size: Number(file.size || 0),
                    text,
                };
            }))
                .then((filePayloads) => {
                    dispatchInteraction({
                        session,
                        dispatchEvent,
                        payload: {
                            type: 'action',
                            actionId: action.id,
                            action: { ...action },
                            values: cloneValues(session),
                            files: filePayloads,
                            anchorRect: measureAnchorRect(button),
                        },
                    });
                })
                .catch((error) => {
                    logger?.error?.('[Cerebr] Failed to read page action files', error);
                })
                .finally(() => {
                    input.remove();
                });
        }, { once: true });

        document.body.appendChild(input);
        input.click();
    }

    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (action.disabled) {
            return;
        }

        if (action.confirm && !window.confirm(action.confirm)) {
            return;
        }

        if (action.kind === 'file') {
            void handleFileAction();
            return;
        }

        dispatchInteraction({
            session,
            dispatchEvent,
            payload: {
                type: 'action',
                actionId: action.id,
                action: { ...action },
                values: cloneValues(session),
                anchorRect: measureAnchorRect(button),
            },
        });
    });

    return button;
}

function renderActionGroup({ actions, session, dispatchEvent, logger, align = 'start' }) {
    const group = createElement('div', 'cerebr-plugin-page-actions');
    group.dataset.align = ['start', 'center', 'end'].includes(align) ? align : 'start';

    actions.forEach((action) => {
        group.appendChild(createActionButton({
            action,
            session,
            dispatchEvent,
            logger,
        }));
    });

    return group;
}

function createFieldElement({
    field,
    session,
    dispatchEvent,
}) {
    const wrapper = createElement('label', 'cerebr-plugin-page-field');
    if (field.span === 2) {
        wrapper.classList.add('cerebr-plugin-page-field--span-2');
    }

    let control = null;
    const currentValue = readFieldValue(session, field);
    let colorValueElement = null;

    if (field.type === 'checkbox') {
        wrapper.classList.add('cerebr-plugin-page-field--toggle');
        const toggle = createElement('span', 'cerebr-plugin-page-switch');
        const copy = createElement('span', 'cerebr-plugin-page-switch__copy');
        const toggleTitle = createElement('span', 'cerebr-plugin-page-switch__title');
        toggleTitle.textContent = field.label;
        copy.appendChild(toggleTitle);
        if (field.description) {
            const toggleDescription = createElement('span', 'cerebr-plugin-page-switch__description');
            toggleDescription.textContent = field.description;
            copy.appendChild(toggleDescription);
        }
        toggle.appendChild(copy);
        control = document.createElement('input');
        control.className = 'cerebr-plugin-page-switch__input';
        control.type = 'checkbox';
        control.checked = !!currentValue;
        control.disabled = !!field.disabled;
        toggle.appendChild(control);
        const slider = createElement('span', 'cerebr-plugin-page-switch__slider');
        const thumb = createElement('span', 'cerebr-plugin-page-switch__thumb');
        slider.appendChild(thumb);
        toggle.appendChild(slider);
        wrapper.appendChild(toggle);
    } else if (field.type === 'textarea') {
        const label = createElement('span', 'cerebr-plugin-page-field__label');
        label.textContent = field.label;
        wrapper.appendChild(label);
        control = createElement('textarea', 'cerebr-plugin-page-input cerebr-plugin-page-input--textarea');
        control.rows = field.rows;
        control.value = String(currentValue ?? '');
        control.placeholder = field.placeholder;
        control.disabled = !!field.disabled;
        wrapper.appendChild(control);
    } else if (field.type === 'color') {
        const label = createElement('span', 'cerebr-plugin-page-field__label');
        label.textContent = field.label;
        wrapper.appendChild(label);
        const colorField = createElement('span', 'cerebr-plugin-page-color-field');
        control = createElement('input', 'cerebr-plugin-page-input cerebr-plugin-page-input--color');
        control.type = 'color';
        control.value = String(currentValue || '#000000');
        control.disabled = !!field.disabled;
        colorField.appendChild(control);
        colorValueElement = createElement('span', 'cerebr-plugin-page-color-field__value');
        colorValueElement.textContent = String(control.value || '#000000').toUpperCase();
        colorField.appendChild(colorValueElement);
        wrapper.appendChild(colorField);
    } else if (field.type === 'select') {
        const label = createElement('span', 'cerebr-plugin-page-field__label');
        label.textContent = field.label;
        wrapper.appendChild(label);
        const selectWrapper = createElement('span', 'cerebr-plugin-page-select');
        control = createElement('select', 'cerebr-plugin-page-input');
        field.options.forEach((option) => {
            const optionElement = document.createElement('option');
            optionElement.value = option.value;
            optionElement.textContent = option.label;
            optionElement.selected = String(currentValue ?? '') === option.value;
            control.appendChild(optionElement);
        });
        control.disabled = !!field.disabled;
        selectWrapper.appendChild(control);
        const chevron = createElement('span', 'cerebr-plugin-page-select__chevron');
        chevron.textContent = '⌄';
        selectWrapper.appendChild(chevron);
        wrapper.appendChild(selectWrapper);
    } else {
        const label = createElement('span', 'cerebr-plugin-page-field__label');
        label.textContent = field.label;
        wrapper.appendChild(label);
        control = createElement('input', 'cerebr-plugin-page-input');
        control.type = 'text';
        control.value = String(currentValue ?? '');
        control.placeholder = field.placeholder;
        control.disabled = !!field.disabled;
        wrapper.appendChild(control);
    }

    if (field.description && field.type !== 'checkbox') {
        const description = createElement('span', 'cerebr-plugin-page-field__description');
        description.textContent = field.description;
        wrapper.appendChild(description);
    }

    const emitChange = () => {
        const nextValue = field.type === 'checkbox'
            ? !!control.checked
            : control.value;

        if (colorValueElement) {
            colorValueElement.textContent = String(nextValue || '#000000').toUpperCase();
        }

        updateFieldValue(session, field.id, nextValue);
        dispatchInteraction({
            session,
            dispatchEvent,
            payload: {
                type: 'change',
                fieldId: field.id,
                value: cloneValue(nextValue, nextValue),
                values: cloneValues(session),
            },
        });
    };

    const eventName = field.type === 'checkbox' || field.type === 'select' || field.type === 'color'
        ? 'change'
        : 'input';
    control.addEventListener(eventName, emitChange);

    if (!Object.prototype.hasOwnProperty.call(session.fieldValues || {}, field.id)) {
        updateFieldValue(session, field.id, field.type === 'checkbox'
            ? !!control.checked
            : control.value);
    }

    session.activeFieldIds.add(field.id);
    return wrapper;
}

function renderList({
    descriptor,
    session,
    dispatchEvent,
    logger,
}) {
    const list = createElement('div', 'cerebr-plugin-page-list');
    if (descriptor.items.length === 0) {
        if (descriptor.emptyText) {
            const empty = createElement('p', 'cerebr-plugin-page-text');
            empty.dataset.tone = 'muted';
            empty.textContent = descriptor.emptyText;
            list.appendChild(empty);
        }
        return list;
    }

    descriptor.items.forEach((item) => {
        const row = createElement('div', 'cerebr-plugin-page-list__item');
        if (item.selected) {
            row.classList.add('is-selected');
        }

        const main = item.actionId
            ? createElement('button', 'cerebr-plugin-page-list__main')
            : createElement('div', 'cerebr-plugin-page-list__main');
        if (main instanceof HTMLButtonElement) {
            main.type = 'button';
            main.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                dispatchInteraction({
                    session,
                    dispatchEvent,
                    payload: {
                        type: 'action',
                        actionId: item.actionId,
                        itemId: item.id,
                        item: {
                            id: item.id,
                            title: item.title,
                        },
                        values: cloneValues(session),
                        anchorRect: measureAnchorRect(main),
                    },
                });
            });
        }

        const title = createElement('span', 'cerebr-plugin-page-list__title');
        title.textContent = item.title;
        main.appendChild(title);

        if (item.description) {
            const description = createElement('span', 'cerebr-plugin-page-list__description');
            description.textContent = item.description;
            main.appendChild(description);
        }

        if (item.meta) {
            const meta = createElement('span', 'cerebr-plugin-page-list__meta');
            meta.textContent = item.meta;
            main.appendChild(meta);
        }

        row.appendChild(main);

        if (item.badges.length > 0) {
            const badges = createElement('div', 'cerebr-plugin-page-badges');
            item.badges.forEach((badge) => badges.appendChild(createBadgeElement(badge)));
            row.appendChild(badges);
        }

        if (item.actions.length > 0) {
            row.appendChild(renderActionGroup({
                actions: item.actions,
                session,
                dispatchEvent,
                logger,
                align: 'end',
            }));
        }

        list.appendChild(row);
    });

    return list;
}

function renderContentNode({
    node,
    session,
    dispatchEvent,
    logger,
}) {
    if (node.kind === 'text') {
        const text = createElement('p', 'cerebr-plugin-page-text');
        text.dataset.tone = normalizeTone(node.tone, 'default');
        text.textContent = node.text;
        return text;
    }

    if (node.kind === 'note') {
        const note = createElement('div', 'cerebr-plugin-page-note');
        note.dataset.tone = normalizeTone(node.tone, 'default');

        if (node.icon) {
            const icon = createElement('span', 'cerebr-plugin-page-note__icon');
            icon.textContent = node.icon;
            note.appendChild(icon);
        }

        const copy = createElement('div', 'cerebr-plugin-page-note__copy');
        if (node.title) {
            const title = createElement('p', 'cerebr-plugin-page-note__title');
            title.textContent = node.title;
            copy.appendChild(title);
        }
        if (node.text) {
            const text = createElement('p', 'cerebr-plugin-page-note__text');
            text.textContent = node.text;
            copy.appendChild(text);
        }
        note.appendChild(copy);
        return note;
    }

    if (node.kind === 'stats') {
        const stats = createElement('div', 'cerebr-plugin-page-stats');
        node.items.forEach((item) => {
            const stat = createElement('div', 'cerebr-plugin-page-stat');
            stat.dataset.tone = item.tone;
            if (item.label) {
                const label = createElement('span', 'cerebr-plugin-page-stat__label');
                label.textContent = item.label;
                stat.appendChild(label);
            }
            const value = createElement('span', 'cerebr-plugin-page-stat__value');
            value.textContent = item.value;
            stat.appendChild(value);
            stats.appendChild(stat);
        });
        return stats;
    }

    if (node.kind === 'badges') {
        const group = createElement('div', 'cerebr-plugin-page-badges');
        node.items.forEach((badge) => group.appendChild(createBadgeElement(badge)));
        return group;
    }

    if (node.kind === 'actions') {
        return renderActionGroup({
            actions: node.actions,
            session,
            dispatchEvent,
            logger,
            align: node.align,
        });
    }

    if (node.kind === 'list') {
        return renderList({
            descriptor: node,
            session,
            dispatchEvent,
            logger,
        });
    }

    if (node.kind === 'form') {
        const form = createElement('div', 'cerebr-plugin-page-form');
        form.dataset.columns = String(node.columns);
        node.fields.forEach((field) => {
            form.appendChild(createFieldElement({
                field,
                session,
                dispatchEvent,
            }));
        });
        return form;
    }

    return null;
}

function renderCard({
    descriptor,
    session,
    dispatchEvent,
    logger,
}) {
    const card = createElement('section', 'cerebr-plugin-page-card');
    card.dataset.variant = normalizeString(descriptor.variant, 'default');

    if (descriptor.title || descriptor.description) {
        const header = createElement('div', 'cerebr-plugin-page-card__header');
        if (descriptor.title) {
            const title = createElement('h3', 'cerebr-plugin-page-card__title');
            title.textContent = descriptor.title;
            header.appendChild(title);
        }
        if (descriptor.description) {
            const description = createElement('p', 'cerebr-plugin-page-card__description');
            description.textContent = descriptor.description;
            header.appendChild(description);
        }
        card.appendChild(header);
    }

    descriptor.body.forEach((node) => {
        const content = renderContentNode({
            node,
            session,
            dispatchEvent,
            logger,
        });
        if (content) {
            card.appendChild(content);
        }
    });

    return card;
}

function renderHero({
    descriptor,
    session,
    dispatchEvent,
    logger,
}) {
    const hero = createElement('section', 'cerebr-plugin-page-hero');
    const matchesPageTitle = normalizeString(session?.page?.title).toLowerCase() === normalizeString(descriptor.title).toLowerCase();
    const matchesPageSubtitle = normalizeString(session?.page?.subtitle) && normalizeString(session?.page?.subtitle) === normalizeString(descriptor.description);
    const compact = !!descriptor.compact || matchesPageTitle || matchesPageSubtitle;
    if (compact) {
        hero.classList.add('cerebr-plugin-page-hero--compact');
    }
    const copy = createElement('div', 'cerebr-plugin-page-hero__copy');

    if (descriptor.eyebrow && !compact) {
        const eyebrow = createElement('p', 'cerebr-plugin-page-hero__eyebrow');
        eyebrow.textContent = descriptor.eyebrow;
        copy.appendChild(eyebrow);
    }
    if (descriptor.title && !matchesPageTitle) {
        const title = createElement('h2', 'cerebr-plugin-page-hero__title');
        title.textContent = descriptor.title;
        copy.appendChild(title);
    }
    if (descriptor.description && !matchesPageSubtitle) {
        const description = createElement('p', 'cerebr-plugin-page-hero__description');
        description.textContent = descriptor.description;
        copy.appendChild(description);
    }
    if (copy.childElementCount > 0) {
        hero.appendChild(copy);
    }

    const side = createElement('div', 'cerebr-plugin-page-hero__side');
    if (descriptor.badges.length > 0) {
        const badges = createElement('div', 'cerebr-plugin-page-badges');
        descriptor.badges.forEach((badge) => {
            badges.appendChild(createBadgeElement(badge));
        });
        side.appendChild(badges);
    }
    if (descriptor.actions.length > 0) {
        side.appendChild(renderActionGroup({
            actions: descriptor.actions,
            session,
            dispatchEvent,
            logger,
            align: 'end',
        }));
    }

    if (side.childElementCount > 0) {
        hero.appendChild(side);
    }

    if (hero.childElementCount === 0) {
        return null;
    }
    return hero;
}

function renderSection({
    section,
    root,
    session,
    dispatchEvent,
    logger,
}) {
    if (section.kind === 'hero') {
        const hero = renderHero({
            descriptor: section,
            session,
            dispatchEvent,
            logger,
        });
        if (hero) {
            root.appendChild(hero);
        }
        return;
    }

    if (section.kind === 'columns') {
        const columns = createElement('div', 'cerebr-plugin-page-columns');
        columns.dataset.count = String(section.columns.length);
        section.columns.forEach((column) => {
            const columnElement = createElement('div', 'cerebr-plugin-page-columns__column');
            column.blocks.forEach((card) => {
                columnElement.appendChild(renderCard({
                    descriptor: card,
                    session,
                    dispatchEvent,
                    logger,
                }));
            });
            columns.appendChild(columnElement);
        });
        root.appendChild(columns);
        return;
    }

    root.appendChild(renderCard({
        descriptor: section,
        session,
        dispatchEvent,
        logger,
    }));
}

export function renderShellPageView({
    bodyElement = null,
    session = {},
    dispatchEvent = () => {},
    logger = console,
} = {}) {
    if (!(bodyElement instanceof HTMLElement)) {
        return false;
    }

    const view = normalizeViewDescriptor(session?.view || {});
    session.activeFieldIds = new Set();

    bodyElement.replaceChildren();

    const root = createElement('div', 'cerebr-plugin-page-view');
    view.sections.forEach((section) => {
        renderSection({
            section,
            root,
            session,
            dispatchEvent,
            logger,
        });
    });

    bodyElement.appendChild(root);
    return true;
}
