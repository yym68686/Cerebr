import { useRef, useState } from 'react';
import { t } from '../../utils/i18n.js';

export function ModelNameInput({ id, value, models, onChange, onBlur }) {
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(-1);
    const input = useRef(null);
    const matches = models.filter((model) => model.toLowerCase().includes(value.trim().toLowerCase()));
    const expanded = open && matches.length > 0;
    const choose = (model) => {
        onChange(model);
        setOpen(false);
        setActive(-1);
    };
    return (
        <div className="model-name-input">
            <input
                ref={input}
                id={id}
                name="modelName"
                className="settings-input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder={t('model_name_placeholder')}
                value={value}
                role={models.length ? 'combobox' : undefined}
                aria-autocomplete={models.length ? 'list' : undefined}
                aria-expanded={models.length ? expanded : undefined}
                aria-controls={expanded ? `${id}-options` : undefined}
                aria-activedescendant={expanded && matches[active] ? `${id}-option-${active}` : undefined}
                onFocus={() => setOpen(true)}
                onChange={(event) => {
                    onChange(event.target.value);
                    setOpen(true);
                    setActive(-1);
                }}
                onBlur={(event) => {
                    setOpen(false);
                    setActive(-1);
                    onBlur(event);
                }}
                onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                    if (matches.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
                        event.preventDefault();
                        setOpen(true);
                        const next =
                            event.key === 'ArrowDown'
                                ? active + 1
                                : active < 0
                                  ? matches.length - 1
                                  : active - 1;
                        const index = (next + matches.length) % matches.length;
                        setActive(index);
                        document
                            .getElementById(`${id}-option-${index}`)
                            ?.scrollIntoView?.({ block: 'nearest' });
                    } else if (expanded && matches[active] && event.key === 'Enter') {
                        event.preventDefault();
                        choose(matches[active]);
                    } else if (expanded && event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        setOpen(false);
                    }
                }}
            />
            {expanded && (
                <div
                    id={`${id}-options`}
                    className="model-name-options"
                    role="listbox"
                    aria-label={t('model_name_label')}
                >
                    {matches.map((model, index) => (
                        <button
                            type="button"
                            key={model}
                            id={`${id}-option-${index}`}
                            role="option"
                            aria-selected={index === active}
                            tabIndex={-1}
                            onPointerDown={(event) => event.preventDefault()}
                            onClick={() => {
                                choose(model);
                                input.current?.focus();
                            }}
                        >
                            {model}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
