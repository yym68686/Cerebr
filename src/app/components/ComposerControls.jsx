import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { selectConfig } from '../state/api-configs.js';
import { notify, uiStore } from '../state/ui-store.js';
import { t } from '../../utils/i18n.js';
import { Icon } from './Icon.jsx';

export function ComposerControls({ apis, session, ui, draft, onSettings }) {
    const [open, setOpen] = useState(false);
    const [iconOnly, setIconOnly] = useState(false);
    const root = useRef(null),
        button = useRef(null),
        label = useRef(null),
        menu = useRef(null);
    const model = apis.configs[apis.selected]?.modelName || 'gpt-4o';
    const active = ui.phase !== 'idle';
    useLayoutEffect(() => {
        const element = button.current;
        const measure = () => {
            const style = getComputedStyle(element);
            const limit = parseFloat(style.maxWidth);
            const needed =
                label.current.getBoundingClientRect().width +
                (parseFloat(style.paddingLeft) || 0) +
                (parseFloat(style.paddingRight) || 0);
            // Measure the full label even in icon mode, so growing the composer
            // can restore it without toggling between two different widths.
            setIconOnly(Number.isFinite(limit) && needed > limit);
        };
        const sizes = new ResizeObserver(measure);
        sizes.observe(element.closest('.input-container-main-row') || root.current);
        sizes.observe(label.current);
        measure();
        return () => sizes.disconnect();
    }, [model]);
    useEffect(() => {
        if (ui.menu || ui.page) setOpen(false);
    }, [ui.menu, ui.page]);
    useEffect(() => {
        if (!open) return;
        const dismiss = (event) => {
            if (!root.current?.contains(event.target)) setOpen(false);
        };
        document.addEventListener('pointerdown', dismiss);
        return () => document.removeEventListener('pointerdown', dismiss);
    }, [open]);
    useLayoutEffect(() => {
        if (open) menu.current?.focus({ preventScroll: true });
    }, [open]);
    const close = () => {
        setOpen(false);
        button.current?.focus({ preventScroll: true });
    };
    return (
        <div
            className="composer-controls"
            ref={root}
            onKeyDown={(event) => {
                if (open && event.key === 'Escape') {
                    event.stopPropagation();
                    event.preventDefault();
                    close();
                }
            }}
        >
            <button
                ref={button}
                type="button"
                className={`composer-model${iconOnly ? ' is-icon-only' : ''}`}
                aria-label={`${t('composer_choose_model')}: ${model}`}
                aria-expanded={open}
                aria-haspopup="menu"
                aria-controls="composer-model-menu"
                title={model}
                onClick={() => {
                    uiStore.set({ menu: false, webpageMenu: false });
                    setOpen((value) => !value);
                }}
            >
                <span ref={label} className="composer-model-label" aria-hidden="true">
                    <span>{model}</span>
                    <Icon name="chevron-down" />
                </span>
                <span className="composer-model-icon" aria-hidden="true">
                    <Icon name="brain" />
                </span>
            </button>
            {open && (
                <div
                    id="composer-model-menu"
                    className="composer-model-menu"
                    role="menu"
                    ref={menu}
                    tabIndex={-1}
                    aria-label={t('composer_choose_model')}
                    onKeyDown={(event) => {
                        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
                        event.preventDefault();
                        const items = [...event.currentTarget.querySelectorAll('[role^="menuitem"]')];
                        const index = items.indexOf(document.activeElement);
                        const next =
                            event.key === 'Home' || (index < 0 && event.key === 'ArrowDown')
                                ? 0
                                : event.key === 'End' || (index < 0 && event.key === 'ArrowUp')
                                  ? items.length - 1
                                  : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) %
                                    items.length;
                        items[next]?.focus();
                    }}
                >
                    {apis.configs.map((config, index) => (
                        <button
                            key={config.id}
                            type="button"
                            role="menuitemradio"
                            aria-checked={index === apis.selected}
                            onClick={() => {
                                void selectConfig(index).catch((error) =>
                                    notify(error.message, { type: 'error' })
                                );
                                close();
                            }}
                        >
                            <span>{config.modelName || 'gpt-4o'}</span>
                            {index === apis.selected && <Icon name="check" />}
                        </button>
                    ))}
                    <div className="composer-menu-divider" role="separator" />
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                            setOpen(false);
                            onSettings();
                        }}
                    >
                        {t('settings_api_settings')}
                    </button>
                </div>
            )}
            <button
                id={ui.editing ? 'confirm-edit-button' : 'send-message-button'}
                type="button"
                className={`composer-send${active && !ui.editing ? ' is-stopping' : ''}`}
                disabled={!session || (!active && (draft.empty || draft.composing))}
                aria-label={t(
                    ui.editing
                        ? 'message_edit_confirm_aria'
                        : active
                          ? 'context_stop_update'
                          : 'composer_send'
                )}
                title={t(
                    ui.editing
                        ? 'message_edit_confirm_aria'
                        : active
                          ? 'context_stop_update'
                          : 'composer_send'
                )}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                    if (draft.composing && !active) return;
                    if (ui.editing) void session?.confirmEdit();
                    else if (active) void session?.pipeline.abortActiveReply();
                    else void session?.pipeline.sendMessage();
                }}
            >
                <Icon name={ui.editing ? 'check' : active ? 'stop-update' : 'send-arrow'} />
            </button>
        </div>
    );
}
