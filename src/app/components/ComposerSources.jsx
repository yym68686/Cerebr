import { t } from '../../utils/i18n.js';
import { Icon } from './Icon.jsx';
import { WebpageIcon } from './WebpageIcon.jsx';

export function ComposerSources({ sources, onManage }) {
    if (!sources.selected.length) return null;
    return (
        <div className="composer-sources" aria-label={t('composer_sources')}>
            <div className="composer-source-tags">
                {sources.selected.map((tab) => (
                    <div className="composer-source-tag" key={tab.id}>
                        <button
                            type="button"
                            className="composer-source-title"
                            onClick={onManage}
                            title={tab.title || tab.url}
                            aria-label={t('composer_manage_source', [tab.title || tab.url])}
                        >
                            <WebpageIcon tab={tab} />
                            <span>{tab.title || tab.url}</span>
                        </button>
                        <button
                            type="button"
                            className="composer-source-remove"
                            onClick={() => void sources.toggle([tab], false)}
                            aria-label={t('composer_remove_source', [tab.title || tab.url])}
                        >
                            <Icon name="close" />
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}
