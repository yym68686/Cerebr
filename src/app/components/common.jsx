import { t } from '../../utils/i18n.js';
import { Icon } from './Icon.jsx';
export function PanelHeader({ title, onBack, children }) {
    return (
        <div className="settings-header">
            <button className="back-button" aria-label={t('aria_back')} onClick={onBack}>
                <Icon name="back" />
            </button>
            <span className="settings-title">{title}</span>
            {children}
        </div>
    );
}
export function Slot({ name }) {
    return (
        <div
            className={`cerebr-plugin-slot cerebr-plugin-slot--${name.replaceAll('.', '-')}`}
            data-plugin-slot={name}
        />
    );
}
export function MenuItem({
    id,
    label,
    description,
    trailing,
    onClick,
    hidden = false,
    disabled = false,
    children,
    ...props
}) {
    return (
        <button
            type="button"
            className="menu-item"
            id={id}
            role="menuitem"
            tabIndex={0}
            hidden={hidden}
            disabled={disabled}
            aria-disabled={disabled || undefined}
            onClick={onClick}
            {...props}
        >
            {children || <Icon name={id} />}
            <span className="composer-menu-copy">
                <span className="composer-menu-title">{label}</span>
                {description && (
                    <span className="composer-menu-description" title={description}>
                        {description}
                    </span>
                )}
            </span>
            {trailing && <span className="composer-menu-trailing">{trailing}</span>}
        </button>
    );
}
