import { t } from '../../utils/i18n.js';
import { Icon } from './Icon.jsx';

export function SettingsPage({ id, visible, title, description, onBack, children }) {
    return (
        <section
            id={id}
            className={`settings-page${visible ? ' visible' : ''}`}
            inert={!visible}
            aria-label={title}
        >
            <header className="settings-page-header">
                <button
                    type="button"
                    className="settings-icon-button"
                    onClick={onBack}
                    aria-label={t('aria_back')}
                >
                    <Icon name="back" />
                </button>
                <span>{t('settings_page_label')}</span>
                <span className="settings-breadcrumb" aria-hidden="true">
                    /
                </span>
                <span>{title}</span>
            </header>
            <div className="settings-page-scroll">
                <div className="settings-page-content">
                    <div className="settings-page-intro">
                        <h1>{title}</h1>
                        <p>{description}</p>
                    </div>
                    {children}
                </div>
            </div>
        </section>
    );
}
