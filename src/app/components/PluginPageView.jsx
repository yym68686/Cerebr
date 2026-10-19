import { createContext, useContext, useEffect, useReducer, useRef, useState } from 'react';
import {
    cloneValues,
    measureAnchorRect,
    moveListItems,
    describeListReorder,
} from '../../runtime/ui/page-view-model.js';
import { notify } from '../state/ui-store.js';

const ViewContext = createContext(null);
function useView() {
    return useContext(ViewContext);
}
function Badges({ items }) {
    return (
        <div className="cerebr-plugin-page-badges">
            {items.map((b) => (
                <span className="cerebr-plugin-page-badge" data-tone={b.tone} key={b.id}>
                    {b.label}
                </span>
            ))}
        </div>
    );
}
function Action({ action, inline = false }) {
    const { emit } = useView();
    const file = useRef(null),
        button = useRef(null);
    const dispatch = (extras) =>
        emit({
            type: 'action',
            actionId: action.id,
            action: { ...action },
            anchorRect: measureAnchorRect(button.current),
            ...extras,
        });
    return (
        <>
            <button
                ref={button}
                type="button"
                className={`cerebr-plugin-page-action${!action.label && action.icon ? ' cerebr-plugin-page-action--icon-only' : ''}${inline ? ' cerebr-plugin-page-action--field-inline' : ''}`}
                data-variant={action.variant}
                data-action-id={action.id}
                disabled={action.disabled}
                title={action.title}
                aria-label={action.title}
                onClick={(event) => {
                    event.stopPropagation();
                    if (action.confirm && !window.confirm(action.confirm)) return;
                    if (action.kind === 'file') file.current.click();
                    else dispatch({});
                }}
            >
                {action.icon && <span className="cerebr-plugin-page-action__icon">{action.icon}</span>}
                {action.label && <span className="cerebr-plugin-page-action__label">{action.label}</span>}
            </button>
            {action.kind === 'file' && (
                <input
                    ref={file}
                    type="file"
                    hidden
                    accept={action.accept}
                    multiple={action.multiple}
                    onChange={async (e) => {
                        const files = [...e.target.files];
                        e.target.value = '';
                        try {
                            dispatch({
                                files: await Promise.all(
                                    files.map(async (f) => ({
                                        name: f.name,
                                        type: f.type,
                                        size: f.size,
                                        text: await f.text().catch(() => ''),
                                    }))
                                ),
                            });
                        } catch (error) {
                            notify(error.message, { type: 'error' });
                        }
                    }}
                />
            )}
        </>
    );
}
function Actions({ actions, align = 'start' }) {
    return (
        <div className="cerebr-plugin-page-actions" data-align={align}>
            {actions.map((action) => (
                <Action key={action.id} action={action} />
            ))}
        </div>
    );
}
function Field({ field }) {
    const { session, change } = useView();
    const value = session.fieldValues[field.id] ?? field.value;
    const id = `cerebr-plugin-page-field-${field.id.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
    session.activeFieldIds.add(field.id);
    if (!(field.id in session.fieldValues)) session.fieldValues[field.id] = value;
    const props = {
        id,
        'data-cerebr-field-id': field.id,
        disabled: field.disabled,
        placeholder: field.placeholder,
        value: String(value ?? ''),
        onChange: (e) => change(field.id, e.target.value),
        className: 'cerebr-plugin-page-input',
    };
    let control;
    if (field.type === 'checkbox')
        return (
            <div className="cerebr-plugin-page-field cerebr-plugin-page-field--toggle">
                <label className="cerebr-plugin-page-switch">
                    <span className="cerebr-plugin-page-switch__copy">
                        <span className="cerebr-plugin-page-switch__title">{field.label}</span>
                        {field.description && (
                            <span className="cerebr-plugin-page-switch__description">
                                {field.description}
                            </span>
                        )}
                    </span>
                    <input
                        id={id}
                        data-cerebr-field-id={field.id}
                        className="cerebr-plugin-page-switch__input"
                        type="checkbox"
                        checked={!!value}
                        disabled={field.disabled}
                        onChange={(e) => change(field.id, e.target.checked)}
                    />
                    <span className="cerebr-plugin-page-switch__slider">
                        <span className="cerebr-plugin-page-switch__thumb" />
                    </span>
                </label>
            </div>
        );
    if (field.type === 'select')
        control = (
            <span className="cerebr-plugin-page-select">
                <select {...props}>
                    {field.options.map((o) => (
                        <option key={o.id} value={o.value}>
                            {o.label}
                        </option>
                    ))}
                </select>
                <span className="cerebr-plugin-page-select__chevron">⌄</span>
            </span>
        );
    else if (field.type === 'textarea')
        control = (
            <textarea
                {...props}
                className={`${props.className} cerebr-plugin-page-input--textarea`}
                rows={field.rows}
            />
        );
    else if (field.type === 'color')
        control = (
            <span className="cerebr-plugin-page-color-field">
                <input
                    {...props}
                    className={`${props.className} cerebr-plugin-page-input--color`}
                    type="color"
                />
                <span className="cerebr-plugin-page-color-field__value">
                    {String(value || '#000000').toUpperCase()}
                </span>
            </span>
        );
    else control = <input {...props} type="text" />;
    return (
        <div
            className={`cerebr-plugin-page-field${field.span === 2 ? ' cerebr-plugin-page-field--span-2' : ''}`}
        >
            <label className="cerebr-plugin-page-field__label" htmlFor={id}>
                {field.label}
            </label>
            {field.action && ['text', 'select'].includes(field.type) ? (
                <div className="cerebr-plugin-page-field__row">
                    <div className="cerebr-plugin-page-field__control">{control}</div>
                    <Action action={field.action} inline />
                </div>
            ) : (
                control
            )}
            {field.description && (
                <span className="cerebr-plugin-page-field__description">{field.description}</span>
            )}
        </div>
    );
}
function SortableList({ node }) {
    const { emit } = useView();
    const list = useRef(null),
        drag = useRef(null),
        orderRef = useRef(node.items.map((i) => i.id));
    const [order, setOrder] = useState(orderRef.current),
        [dragging, setDragging] = useState('');
    const [dropMarker, setDropMarker] = useState(null);
    const signature = node.items.map((i) => i.id).join('\u0000');
    useEffect(() => {
        orderRef.current = node.items.map((i) => i.id);
        setOrder(orderRef.current);
    }, [signature]);
    const updateOrder = (ids) => {
        orderRef.current = ids;
        setOrder(ids);
    };
    const finish = (commit) => {
        const state = drag.current;
        drag.current = null;
        setDragging('');
        setDropMarker(null);
        if (!state) return;
        const result = describeListReorder(state.initial, orderRef.current, state.id);
        if (commit && result && state.target)
            emit({
                type: 'reorder',
                listId: node.id,
                itemId: state.id,
                targetItemId: state.target,
                beforeTarget: state.before,
                ...result,
            });
        else updateOrder(state.initial);
    };
    useEffect(() => {
        const cancel = () => finish(false);
        window.addEventListener('blur', cancel);
        return () => window.removeEventListener('blur', cancel);
    }, []);
    const begin = (event, item) => {
        drag.current = {
            id: item.id,
            pointer: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            initial: [...orderRef.current],
            active: false,
        };
        if (node.dragPreview !== 'native') {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
        }
    };
    const move = (event) => {
        const state = drag.current;
        if (!state) return;
        if (!state.active && Math.hypot(event.clientX - state.x, event.clientY - state.y) < 4) return;
        state.active = true;
        setDragging(state.id);
        event.preventDefault();
        const rows = [...list.current.querySelectorAll(':scope > .cerebr-plugin-page-list__item')].filter(
            (row) => row.dataset.itemId !== state.id
        );
        const row =
            rows.find((row) => {
                const box = row.getBoundingClientRect();
                return event.clientY < box.bottom;
            }) || rows.at(-1);
        if (!row) return;
        const box = row.getBoundingClientRect();
        state.target = row.dataset.itemId;
        state.before = event.clientY < box.top + box.height / 2;
        if (node.dropIndicator === 'line') setDropMarker({ id: state.target, before: state.before });
        const next = moveListItems(orderRef.current, state.id, state.target, state.before);
        if (next) updateOrder(next.orderedItemIds);
    };
    const classes = [
        'cerebr-plugin-page-list',
        node.sortable && 'cerebr-plugin-page-list--sortable',
        node.sortable && `cerebr-plugin-page-list--drag-handle-${node.dragHandle}`,
        node.sortable && node.dragPreview !== 'native' && 'cerebr-plugin-page-list--drag-preview-inline',
        node.sortingStyle === 'emphasized' && 'cerebr-plugin-page-list--sorting-emphasized',
        node.dropIndicator === 'none' && 'cerebr-plugin-page-list--drop-indicator-none',
        dragging && 'is-sorting',
    ]
        .filter(Boolean)
        .join(' ');
    const byId = new Map(node.items.map((item) => [item.id, item]));
    const items = order.map((id) => byId.get(id)).filter(Boolean);
    return (
        <div
            className={classes}
            ref={list}
            onDragOver={node.sortable ? move : undefined}
            onDrop={(e) => {
                e.preventDefault();
                finish(true);
            }}
        >
            {!items.length && node.emptyText && (
                <p className="cerebr-plugin-page-text" data-tone="muted">
                    {node.emptyText}
                </p>
            )}
            {items.map((item) => {
                const Main = item.actionId ? 'button' : 'div';
                const structured = node.sortable || item.body.length || item.token;
                const row = (
                    <>
                        {node.sortable && (
                            <button
                                type="button"
                                className="cerebr-plugin-page-list__drag-handle"
                                data-variant={node.dragHandle}
                                title="Drag to reorder"
                                aria-label="Drag to reorder"
                                onPointerDown={(e) => begin(e, item)}
                                onPointerMove={node.dragPreview !== 'native' ? move : undefined}
                                onPointerUp={() => {
                                    if (node.dragPreview !== 'native') finish(true);
                                }}
                                onPointerCancel={() => finish(false)}
                                onKeyDown={(e) => {
                                    if (!['ArrowUp', 'ArrowDown'].includes(e.key)) return;
                                    e.preventDefault();
                                    const index = orderRef.current.indexOf(item.id),
                                        target = orderRef.current[index + (e.key === 'ArrowUp' ? -1 : 1)];
                                    const next = moveListItems(
                                        orderRef.current,
                                        item.id,
                                        target,
                                        e.key === 'ArrowUp'
                                    );
                                    if (next) {
                                        updateOrder(next.orderedItemIds);
                                        emit({
                                            type: 'reorder',
                                            listId: node.id,
                                            itemId: item.id,
                                            targetItemId: target,
                                            beforeTarget: e.key === 'ArrowUp',
                                            ...next,
                                        });
                                    }
                                }}
                            >
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    {[6, 12, 18].flatMap((y) =>
                                        [9, 15].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5" />)
                                    )}
                                </svg>
                            </button>
                        )}
                        <Main
                            className="cerebr-plugin-page-list__main"
                            type={item.actionId ? 'button' : undefined}
                            onClick={
                                item.actionId
                                    ? (e) =>
                                          emit({
                                              type: 'action',
                                              actionId: item.actionId,
                                              itemId: item.id,
                                              item: { id: item.id, title: item.title },
                                              anchorRect: measureAnchorRect(e.currentTarget),
                                          })
                                    : undefined
                            }
                        >
                            <div className="cerebr-plugin-page-list__title-row">
                                {item.token && (
                                    <span className="cerebr-plugin-page-list__token">{item.token}</span>
                                )}
                                <span className="cerebr-plugin-page-list__title">{item.title}</span>
                            </div>
                            {item.description && (
                                <span className="cerebr-plugin-page-list__description">
                                    {item.description}
                                </span>
                            )}
                            {item.meta && <span className="cerebr-plugin-page-list__meta">{item.meta}</span>}
                        </Main>
                        {!!item.badges.length && <Badges items={item.badges} />}{' '}
                        {!!item.actions.length && <Actions actions={item.actions} align="end" />}
                    </>
                );
                return (
                    <div
                        key={item.id}
                        className={`cerebr-plugin-page-list__item${item.selected ? ' is-selected' : ''}${item.body.length ? ' cerebr-plugin-page-list__item--with-body' : ''}${dragging === item.id ? ' is-dragging' : ''}${dropMarker?.id === item.id ? (dropMarker.before ? ' drop-before' : ' drop-after') : ''}`}
                        data-item-id={item.id}
                        draggable={node.sortable && node.dragPreview === 'native'}
                        onDragStart={(e) => {
                            if (drag.current?.id !== item.id) {
                                e.preventDefault();
                                return;
                            }
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('application/x-cerebr-sortable-item', item.id);
                            setDragging(item.id);
                        }}
                        onDragEnd={() => finish(false)}
                    >
                        {structured ? <div className="cerebr-plugin-page-list__row">{row}</div> : row}
                        {!!item.body.length && (
                            <div className="cerebr-plugin-page-list__body">
                                {item.body.map((child) => (
                                    <Content key={child.id} node={child} />
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
function PaginationControl({ control }) {
    const { session, change } = useView();
    const value = String(session.fieldValues[control.fieldId] ?? control.value ?? '');
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);
    session.activeFieldIds.add(control.fieldId);
    const isNumber = control.type === 'number';
    const commit = () => {
        let next = Number(draft);
        if (!Number.isFinite(next) || !draft.trim()) next = Number(value) || control.min || 1;
        next = Math.max(control.min || 1, Math.floor(next));
        if (control.max > 0) next = Math.min(control.max, next);
        setDraft(String(next));
        if (String(next) !== value) change(control.fieldId, String(next));
    };
    const width = Math.max(
        2,
        String(control.max || control.value || '').length,
        ...(control.options || []).map((o) => o.label.length)
    );
    return (
        <div className="cerebr-plugin-page-pagination__control">
            <div className="cerebr-plugin-page-pagination__control-shell">
                {control.label && (
                    <span className="cerebr-plugin-page-pagination__control-label">{control.label}</span>
                )}
                <span
                    className={`cerebr-plugin-page-pagination__${isNumber ? 'number' : 'select'}`}
                    style={{ '--cerebr-plugin-page-pagination-field-ch': width }}
                >
                    {isNumber ? (
                        <input
                            className="cerebr-plugin-page-pagination__number-input"
                            data-cerebr-field-id={control.fieldId}
                            type="number"
                            inputMode="numeric"
                            min={control.min}
                            max={control.max || undefined}
                            step={control.step}
                            value={draft}
                            disabled={control.disabled}
                            placeholder={control.placeholder}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={commit}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    commit();
                                    e.currentTarget.blur();
                                }
                            }}
                        />
                    ) : (
                        <select
                            className="cerebr-plugin-page-pagination__select-input"
                            data-cerebr-field-id={control.fieldId}
                            value={value}
                            disabled={control.disabled}
                            onChange={(e) => change(control.fieldId, e.target.value)}
                        >
                            {control.options.map((o) => (
                                <option value={o.value} key={o.id}>
                                    {o.label}
                                </option>
                            ))}
                        </select>
                    )}
                </span>
                {control.suffix && (
                    <span className="cerebr-plugin-page-pagination__control-suffix">{control.suffix}</span>
                )}
            </div>
        </div>
    );
}
function Pagination({ node }) {
    const { emit } = useView();
    const button = (b, arrow = false) => {
        if (!b) return null;
        const interactive = b.actionId && !b.disabled,
            Tag = interactive ? 'button' : 'span';
        return (
            <Tag
                key={b.id}
                type={interactive ? 'button' : undefined}
                className={`cerebr-plugin-page-pagination__button${arrow ? ' cerebr-plugin-page-pagination__button--arrow' : ''}${b.selected ? ' is-selected' : ''}${!interactive ? ' is-static' : ''}`}
                title={b.title}
                aria-label={b.title}
                aria-current={b.selected ? 'page' : undefined}
                onClick={
                    interactive
                        ? (e) =>
                              emit({
                                  type: 'action',
                                  actionId: b.actionId,
                                  anchorRect: measureAnchorRect(e.currentTarget),
                              })
                        : undefined
                }
            >
                {b.label}
            </Tag>
        );
    };
    return (
        <div className="cerebr-plugin-page-pagination">
            {node.pageSize && (
                <div className="cerebr-plugin-page-pagination__group cerebr-plugin-page-pagination__group--start">
                    <PaginationControl control={node.pageSize} />
                </div>
            )}
            <div className="cerebr-plugin-page-pagination__group cerebr-plugin-page-pagination__group--center">
                <div className="cerebr-plugin-page-pagination__strip">
                    {button(node.previousAction, true)}
                    {node.pages.map((b) => button(b))}
                    {button(node.nextAction, true)}
                </div>
            </div>
            {node.jump && (
                <div className="cerebr-plugin-page-pagination__group cerebr-plugin-page-pagination__group--end">
                    <PaginationControl control={node.jump} />
                </div>
            )}
        </div>
    );
}
function Content({ node }) {
    switch (node.kind) {
        case 'text':
            return (
                <p className="cerebr-plugin-page-text" data-tone={node.tone}>
                    {node.text}
                </p>
            );
        case 'note':
            return (
                <div className="cerebr-plugin-page-note" data-tone={node.tone}>
                    {node.icon && <span className="cerebr-plugin-page-note__icon">{node.icon}</span>}
                    <div className="cerebr-plugin-page-note__copy">
                        {node.title && <p className="cerebr-plugin-page-note__title">{node.title}</p>}
                        {node.text && <p className="cerebr-plugin-page-note__text">{node.text}</p>}
                    </div>
                </div>
            );
        case 'stats':
            return (
                <div className="cerebr-plugin-page-stats">
                    {node.items.map((item) => (
                        <div className="cerebr-plugin-page-stat" data-tone={item.tone} key={item.id}>
                            {item.label && (
                                <span className="cerebr-plugin-page-stat__label">{item.label}</span>
                            )}
                            <span className="cerebr-plugin-page-stat__value">{item.value}</span>
                        </div>
                    ))}
                </div>
            );
        case 'badges':
            return <Badges items={node.items} />;
        case 'actions':
            return <Actions actions={node.actions} align={node.align} />;
        case 'form':
            return (
                <div className="cerebr-plugin-page-form" data-columns={node.columns}>
                    {node.fields.map((field) => (
                        <Field key={field.id} field={field} />
                    ))}
                </div>
            );
        case 'list':
            return <SortableList node={node} />;
        case 'pagination':
            return <Pagination node={node} />;
        default:
            return null;
    }
}
function Card({ card }) {
    return (
        <section className="cerebr-plugin-page-card" data-variant={card.variant}>
            {(card.title || card.description) && (
                <div className="cerebr-plugin-page-card__header">
                    {card.title && <h3 className="cerebr-plugin-page-card__title">{card.title}</h3>}
                    {card.description && (
                        <p className="cerebr-plugin-page-card__description">{card.description}</p>
                    )}
                </div>
            )}
            {card.body.map((node) => (
                <Content key={node.id} node={node} />
            ))}
        </section>
    );
}
function Section({ section }) {
    const { session } = useView();
    if (section.kind === 'columns')
        return (
            <div className="cerebr-plugin-page-columns" data-count={section.columns.length}>
                {section.columns.map((column) => (
                    <div className="cerebr-plugin-page-columns__column" key={column.id}>
                        {column.blocks.map((card) => (
                            <Card key={card.id} card={card} />
                        ))}
                    </div>
                ))}
            </div>
        );
    if (section.kind !== 'hero') return <Card card={section} />;
    const matchesTitle = session.page.title.toLowerCase() === section.title.toLowerCase();
    const matchesSubtitle = !!session.page.subtitle && session.page.subtitle === section.description;
    const compact = section.compact || matchesTitle || matchesSubtitle;
    const hasCopy =
        (section.eyebrow && !compact) ||
        (section.title && !matchesTitle) ||
        (section.description && !matchesSubtitle);
    if (!hasCopy && !section.badges.length && !section.actions.length) return null;
    return (
        <section className={`cerebr-plugin-page-hero${compact ? ' cerebr-plugin-page-hero--compact' : ''}`}>
            {hasCopy && (
                <div className="cerebr-plugin-page-hero__copy">
                    {section.eyebrow && !compact && (
                        <p className="cerebr-plugin-page-hero__eyebrow">{section.eyebrow}</p>
                    )}
                    {section.title && !matchesTitle && (
                        <h2 className="cerebr-plugin-page-hero__title">{section.title}</h2>
                    )}
                    {section.description && !matchesSubtitle && (
                        <p className="cerebr-plugin-page-hero__description">{section.description}</p>
                    )}
                </div>
            )}
            {(!!section.badges.length || !!section.actions.length) && (
                <div className="cerebr-plugin-page-hero__side">
                    {!!section.badges.length && <Badges items={section.badges} />}{' '}
                    {!!section.actions.length && <Actions actions={section.actions} align="end" />}
                </div>
            )}
        </section>
    );
}
export function PluginPageView({ session }) {
    const [, redraw] = useReducer((n) => n + 1, 0);
    const emit = (payload) => session.dispatch({ ...payload, values: cloneValues(session) });
    const change = (fieldId, value) => {
        session.fieldValues[fieldId] = value;
        redraw();
        emit({ type: 'change', fieldId, value });
    };
    return (
        <ViewContext.Provider value={{ session, emit, change }}>
            <div className="cerebr-plugin-page-view">
                {session.renderView.sections.map((section) => (
                    <Section key={section.id} section={section} />
                ))}
            </div>
        </ViewContext.Provider>
    );
}
