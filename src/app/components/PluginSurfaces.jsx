import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { pluginUiStore } from '../../runtime/ui/plugin-ui-store.js';
import { createMenuItemSvgElement } from '../../runtime/ui/shell-menu-manager.js';
import { PluginPageView } from './PluginPageView.jsx';
import { Icon } from './Icon.jsx';
import { t } from '../../utils/i18n.js';

function usePluginUi() {
    return useSyncExternalStore(pluginUiStore.subscribe, pluginUiStore.getSnapshot);
}
export function PluginInputActions() {
    const { actions } = usePluginUi();
    return (
        <div id="plugin-input-actions" className="cerebr-plugin-input-actions" hidden={!actions.length}>
            {!!actions.length && (
                <div className="cerebr-plugin-input-actions__list">
                    {actions.map((record) => (
                        <div
                            className="cerebr-plugin-input-actions__group"
                            data-plugin-id={record.pluginId}
                            key={record.pluginId}
                        >
                            {record.actions.map((action) => (
                                <button
                                    key={action.id}
                                    type="button"
                                    className={`cerebr-plugin-input-action${action.iconOnly ? ' cerebr-plugin-input-action--icon-only' : ''}${action.background ? ' cerebr-plugin-input-action--custom-bg' : ''}${action.color ? ' cerebr-plugin-input-action--custom-text' : ''}`}
                                    data-plugin-id={record.pluginId}
                                    data-action-id={action.id}
                                    data-variant={action.variant}
                                    disabled={action.disabled}
                                    title={action.title}
                                    aria-label={action.title}
                                    style={{
                                        '--cerebr-plugin-input-action-bg-custom':
                                            action.background || undefined,
                                        '--cerebr-plugin-input-action-text-custom': action.color || undefined,
                                    }}
                                    onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        record.dispatch(action, e.currentTarget);
                                    }}
                                >
                                    {action.icon && (
                                        <span className="cerebr-plugin-input-action__icon">
                                            {action.icon}
                                        </span>
                                    )}
                                    {action.label && (
                                        <span className="cerebr-plugin-input-action__label">
                                            {action.label}
                                        </span>
                                    )}
                                </button>
                            ))}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
function MenuIcon({ item, disclosure = false }) {
    const svg = useMemo(() => createMenuItemSvgElement(item.iconSvg)?.outerHTML || '', [item.iconSvg]);
    if (!svg && !item.icon)
        return disclosure ? (
            <span className="cerebr-plugin-menu-item__chevron">
                <Icon name="chevron-right" />
            </span>
        ) : null;
    return (
        <span
            className={`cerebr-plugin-menu-item__icon${disclosure ? ' cerebr-plugin-menu-item__icon--disclosure' : ''}${!svg ? ' cerebr-plugin-menu-item__icon--text' : ''}`}
            aria-hidden="true"
        >
            {svg ? <span dangerouslySetInnerHTML={{ __html: svg }} /> : item.icon}
        </span>
    );
}
export function PluginMenuItems() {
    const { menu } = usePluginUi();
    return (
        <div id="plugin-menu-items" className="cerebr-plugin-menu-items" hidden={!menu.length}>
            {menu.map(({ pluginId, item, dispatch }) => (
                <div
                    key={`${pluginId}:${item.id}`}
                    className={`menu-item cerebr-plugin-menu-item${item.disabled ? ' is-disabled' : ''}`}
                    role="menuitem"
                    tabIndex={item.disabled ? -1 : 0}
                    aria-disabled={item.disabled}
                    title={item.title}
                    data-plugin-id={pluginId}
                    data-plugin-menu-item={item.id}
                    onClick={(e) => {
                        if (!item.disabled) {
                            e.stopPropagation();
                            dispatch(e.currentTarget);
                        }
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            if (!item.disabled) dispatch(e.currentTarget);
                        }
                    }}
                >
                    <span className="cerebr-plugin-menu-item__label">
                        {item.iconPlacement !== 'disclosure' && <MenuIcon item={item} />}
                        <span className="cerebr-plugin-menu-item__text">{item.label}</span>
                    </span>
                    {(item.disclosure || item.iconPlacement === 'disclosure') && (
                        <MenuIcon item={item.iconPlacement === 'disclosure' ? item : {}} disclosure />
                    )}
                </div>
            ))}
        </div>
    );
}
export function PluginSlashCommands() {
    const { commands } = usePluginUi();
    return (
        <div
            id="plugin-slash-commands"
            className="cerebr-plugin-slash-commands"
            hidden={!commands}
            data-open={!!commands}
        >
            {commands && (
                <div className="cerebr-plugin-slash-command">
                    {!commands.matches.length ? (
                        <div className="cerebr-plugin-slash-command__empty">{commands.emptyText}</div>
                    ) : (
                        <div className="cerebr-plugin-slash-command__list">
                            {commands.matches.map((record, index) => (
                                <button
                                    key={`${record.pluginId}:${record.command.id}`}
                                    className={`cerebr-plugin-slash-command__item${index === commands.activeIndex ? ' is-active' : ''}`}
                                    type="button"
                                    data-active={index === commands.activeIndex}
                                    onPointerDown={(e) => e.preventDefault()}
                                    onPointerEnter={() => commands.activate(index)}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        commands.select(record);
                                    }}
                                >
                                    <div className="cerebr-plugin-slash-command__token-row">
                                        <span className="cerebr-plugin-slash-command__token">
                                            /{record.command.name}
                                        </span>
                                        <span className="cerebr-plugin-slash-command__label">
                                            {record.command.label}
                                        </span>
                                    </div>
                                    {record.command.description && (
                                        <span className="cerebr-plugin-slash-command__description">
                                            {record.command.description}
                                        </span>
                                    )}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
// Arbitrary plugin nodes are a public SDK boundary. React owns the host surface;
// the plugin owns the node it supplies, including iframe and shadow DOM content.
function MountedPluginNode({ node, className = '' }) {
    const host = useRef(null);
    useLayoutEffect(() => {
        if (!node) return;
        const parent = node.parentNode,
            next = node.nextSibling;
        const classes = className.split(' ').filter(Boolean);
        node.classList.add(...classes);
        host.current.append(node);
        return () => {
            node.classList.remove(...classes);
            if (parent?.isConnected) parent.insertBefore(node, next?.parentNode === parent ? next : null);
            else node.remove();
        };
    }, [node, className]);
    return <div ref={host} className="cerebr-plugin-mount-boundary" style={{ display: 'contents' }} />;
}
export function PluginPage() {
    const { page } = usePluginUi();
    return (
        <div id="plugin-shell-page" className={page ? 'visible' : ''} hidden={!page}>
            <div className="settings-header">
                <button
                    className="back-button"
                    id="plugin-shell-page-back"
                    aria-label={t('aria_back')}
                    onClick={() => page?.dismiss('back')}
                >
                    <Icon name="back" />
                </button>
                <div className="plugin-shell-page__title-wrap">
                    <span className="settings-title" id="plugin-shell-page-title">
                        {page?.page.title || 'Plugin'}
                    </span>
                    <p
                        className="plugin-shell-page__subtitle"
                        id="plugin-shell-page-subtitle"
                        hidden={!page?.page.subtitle}
                    >
                        {page?.page.subtitle}
                    </p>
                </div>
            </div>
            <div className="plugin-shell-page__content">
                <div id="plugin-shell-page-body" className="plugin-shell-page__body">
                    {page &&
                        (page.view ? (
                            <PluginPageView key={`${page.pluginId}:${page.generation}`} session={page} />
                        ) : (
                            <MountedPluginNode
                                node={page.mountElement}
                                className="cerebr-plugin-slot-item--shell-input-addon-page"
                            />
                        ))}
                </div>
            </div>
        </div>
    );
}
const size = (value, fallback) =>
    typeof value === 'number'
        ? `${Math.max(0, Math.round(value))}px`
        : String(value ?? '').trim() || fallback;
const align = (value) =>
    ['start', 'top'].includes(value)
        ? 'flex-start'
        : ['end', 'bottom'].includes(value)
          ? 'flex-end'
          : 'center';
export function PluginModals() {
    const { modals } = usePluginUi();
    if (!modals.length) return null;
    return createPortal(
        <div id="cerebr-plugin-shell-modal-root" className="cerebr-plugin-shell-modal-root">
            {modals.map((session) => {
                const o = session.options;
                return (
                    <div
                        key={session.pluginId}
                        className="cerebr-plugin-shell-modal"
                        style={{
                            justifyContent: align(o.alignY),
                            alignItems: align(o.alignX),
                            padding: size(o.inset, '16px'),
                        }}
                    >
                        <div
                            className={`cerebr-plugin-shell-modal__backdrop${o.dimBackground ? ' cerebr-plugin-shell-modal__backdrop--visible' : ''}${o.blockBackground ? ' cerebr-plugin-shell-modal__backdrop--blocking' : ''}`}
                        />
                        <div
                            ref={session.setPanel}
                            className="cerebr-plugin-shell-modal__panel"
                            style={{
                                width: size(o.width, 'min(960px, calc(100vw - 32px))'),
                                maxWidth: size(o.maxWidth, 'calc(100vw - 32px)'),
                                minWidth: size(o.minWidth, '0'),
                                height: size(o.height, 'auto'),
                                maxHeight: size(o.maxHeight, 'calc(100vh - 32px)'),
                                minHeight: size(o.minHeight, '0'),
                                borderRadius: size(o.borderRadius, '24px'),
                                background: o.background ?? 'transparent',
                                boxShadow: o.boxShadow ?? 'none',
                            }}
                        >
                            <MountedPluginNode
                                node={session.mountElement}
                                className={`cerebr-plugin-slot-item--shell-input-addon-modal${o.fillHeight ? ' cerebr-plugin-slot-item--shell-input-addon-modal-fill' : ''}`}
                            />
                        </div>
                    </div>
                );
            })}
        </div>,
        document.body
    );
}
