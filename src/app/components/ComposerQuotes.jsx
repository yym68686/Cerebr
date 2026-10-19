import { t } from '../../utils/i18n.js';
import { Icon } from './Icon.jsx';
import { setDraftQuotes } from '../../runtime/input/draft-quotes.js';
export function ComposerQuotes({ quotes = [], inputRef }) {
    if (!quotes.length) return null;
    return (
        <div className="composer-quotes" aria-label={t('selection_quotes')}>
            {quotes.map((quote, index) => (
                <div className="composer-quote" key={index}>
                    <span className="composer-quote-mark" aria-hidden="true">
                        “
                    </span>
                    <span title={quote}>{quote}</span>
                    <button
                        type="button"
                        aria-label={t('selection_remove_quote', [index + 1])}
                        onClick={() =>
                            setDraftQuotes(
                                inputRef.current,
                                quotes.filter((_, i) => i !== index)
                            )
                        }
                    >
                        <Icon name="close" />
                    </button>
                </div>
            ))}
        </div>
    );
}
