import { t } from '../../utils/i18n.js';
import { Icon } from './Icon.jsx';
export function DropFeedback({ phase }) {
    if (phase !== 'ready') return null;
    return (
        <div className="chat-drop-feedback" role="status" aria-live="polite">
            <div className="chat-drop-surface">
                <span className="chat-drop-stack" aria-hidden="true">
                    <span />
                    <span />
                    <Icon name="upload" />
                </span>
                <strong>{t('drop_title')}</strong>
                <span>{t('drop_hint')}</span>
            </div>
        </div>
    );
}
