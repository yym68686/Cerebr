import { t } from '../../utils/i18n.js';
import { Icon } from './Icon.jsx';
export function DropFeedback({ phase }) {
    if (!phase) return null;
    return (
        <div className="chat-drop-feedback" role="status" aria-live="polite">
            <div className={`chat-drop-surface ${phase === 'reading' ? 'is-reading' : ''}`}>
                <span className="chat-drop-stack" aria-hidden="true">
                    <span />
                    <span />
                    <Icon name="upload" />
                </span>
                <strong>{t(phase === 'reading' ? 'drop_reading' : 'drop_title')}</strong>
                <span>{t('drop_hint')}</span>
            </div>
        </div>
    );
}
