import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { selectConfig } from '../state/api-configs.js';
import { notify, uiStore } from '../state/ui-store.js';
import { t } from '../../utils/i18n.js';
import { Icon } from './Icon.jsx';
import { configModelNames, getChatModelSelection } from '../../domain/chat/model-selection.js';

export function ComposerControls({ apis, chat, session, ui, draft, onSettings }) {
    const [open, setOpen] = useState(false);
    const [iconOnly, setIconOnly] = useState(false);
    const [query, setQuery] = useState('');
    const [activeOption, setActiveOption] = useState(-1);
    const root = useRef(null),
        button = useRef(null),
        label = useRef(null),
        search = useRef(null);
    const selection = getChatModelSelection(chat, apis);
    const model = selection?.modelName || t('composer_model_placeholder');
    const selectedConfig = apis.configs.findIndex((config) => config.id === selection?.configId);
    const modelOptions = apis.configs.flatMap((config, index) => {
        const names = configModelNames(config, apis);
        if (index === selectedConfig && selection?.modelName && !names.includes(selection.modelName))
            names.unshift(selection.modelName);
        return names.map((name) => ({ config, index, name }));
    });
    const filteredOptions = modelOptions.filter((option) =>
        option.name.toLowerCase().includes(query.trim().toLowerCase())
    );
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
        if (ui.menu || ui.page) {
            setOpen(false);
            setQuery('');
        }
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
        if (open) search.current?.focus({ preventScroll: true });
    }, [open]);
    useEffect(() => {
        setActiveOption(-1);
    }, [query, apis.modelLists]);
    const close = () => {
        setOpen(false);
        button.current?.focus({ preventScroll: true });
    };
    const choose = (index, name) => {
        void (session?.selectModel ? session.selectModel(index, name) : selectConfig(index, name)).catch(
            (error) => notify(error.message, { type: 'error' })
        );
        close();
    };
    return (
        <div
            className="composer-controls"
            ref={root}
            onKeyDown={(event) => {
                if (open && event.key === 'Escape' && !event.nativeEvent.isComposing) {
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
                aria-haspopup="dialog"
                aria-controls="composer-model-menu"
                title={model}
                onClick={() => {
                    uiStore.set({ menu: false, webpageMenu: false });
                    setQuery('');
                    setActiveOption(-1);
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
                    role="dialog"
                    aria-label={t('composer_choose_model')}
                    onKeyDown={(event) => {
                        if (
                            !event.target.matches('input') ||
                            event.nativeEvent.isComposing ||
                            event.keyCode === 229
                        )
                            return;
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            event.stopPropagation();
                            const exact =
                                filteredOptions.find(
                                    (option) =>
                                        option.index === selectedConfig &&
                                        option.name.toLowerCase() === query.trim().toLowerCase()
                                ) ||
                                filteredOptions.find(
                                    (option) => option.name.toLowerCase() === query.trim().toLowerCase()
                                );
                            const current = filteredOptions.find((option) => option.index === selectedConfig);
                            const choice =
                                filteredOptions[activeOption] || exact || current || filteredOptions[0];
                            const name = choice?.name || query.trim();
                            const index = choice?.index >= 0 ? choice.index : Math.max(0, selectedConfig);
                            if (name) {
                                choose(index, name);
                            }
                            return;
                        }
                        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
                        if (['Home', 'End'].includes(event.key) && activeOption < 0) return;
                        if (!filteredOptions.length) return;
                        event.preventDefault();
                        const next =
                            event.key === 'Home' || (activeOption < 0 && event.key === 'ArrowDown')
                                ? 0
                                : event.key === 'End' || (activeOption < 0 && event.key === 'ArrowUp')
                                  ? filteredOptions.length - 1
                                  : (activeOption +
                                        (event.key === 'ArrowDown' ? 1 : filteredOptions.length - 1)) %
                                    filteredOptions.length;
                        setActiveOption(next);
                        document
                            .getElementById(`composer-model-option-${next}`)
                            ?.scrollIntoView?.({ block: 'nearest' });
                    }}
                >
                    <input
                        ref={search}
                        id="composer-model-search"
                        className="composer-model-search"
                        type="text"
                        role="combobox"
                        aria-autocomplete={modelOptions.length ? 'list' : 'none'}
                        aria-expanded={filteredOptions.length > 0}
                        aria-controls={filteredOptions.length ? 'composer-model-options' : undefined}
                        aria-activedescendant={
                            filteredOptions[activeOption]
                                ? `composer-model-option-${activeOption}`
                                : undefined
                        }
                        aria-label={t('composer_choose_model')}
                        placeholder={t('composer_model_placeholder')}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        autoComplete="off"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                    />
                    {filteredOptions.length > 0 && (
                        <div
                            id="composer-model-options"
                            role="listbox"
                            aria-label={t('composer_choose_model')}
                        >
                            {filteredOptions.map(({ config, index, name }, optionIndex) => (
                                <button
                                    key={`${config.id}:${name}`}
                                    id={`composer-model-option-${optionIndex}`}
                                    type="button"
                                    role="option"
                                    aria-selected={index === selectedConfig && name === model}
                                    className={optionIndex === activeOption ? 'is-highlighted' : ''}
                                    onClick={() => choose(index, name)}
                                >
                                    <span>
                                        {name}
                                        {apis.configs.length > 1 && <small>{connectionLabel(config)}</small>}
                                    </span>
                                    {index === selectedConfig && name === model && <Icon name="check" />}
                                </button>
                            ))}
                        </div>
                    )}
                    {!query &&
                        apis.configs
                            .filter(
                                (config) =>
                                    !configModelNames(config, apis).length &&
                                    config.id !== selection?.configId
                            )
                            .map((config) => (
                                <button
                                    key={config.id}
                                    type="button"
                                    onClick={() => choose(apis.configs.indexOf(config))}
                                >
                                    <span>{connectionLabel(config)}</span>
                                </button>
                            ))}
                    <div className="composer-menu-divider" role="separator" />
                    <button
                        type="button"
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
                disabled={
                    !session ||
                    (!active && (draft.empty || draft.composing)) ||
                    (draft.readingFiles && (!!ui.editing || !active))
                }
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
                    if (draft.readingFiles && (ui.editing || !active)) return;
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

function connectionLabel(config) {
    try {
        return new URL(config.baseUrl).host;
    } catch {
        return config.modelName || t('api_new_connection');
    }
}
