import { useState, useSyncExternalStore } from 'react';
import { Download, RefreshDouble, CheckCircle, WarningCircle } from 'iconoir-react';
import { desktopUpdateStore } from '../../platform/desktop-updates.js';
import { t } from '../../utils/i18n.js';

export function DesktopUpdateSettings() {
    const status = useSyncExternalStore(desktopUpdateStore.subscribe, desktopUpdateStore.getSnapshot);
    const [requestError, setRequestError] = useState(false);
    const api = globalThis.cerebrDesktop?.updates;
    if (!api) return null;
    const busy = ['checking', 'downloading', 'waiting', 'installing'].includes(status.phase);
    const error = requestError ? 'download' : status.error;
    const check = async () => {
        setRequestError(false);
        try {
            await api.check();
        } catch {
            setRequestError(true);
        }
    };
    return (
        <section className="preferences-section" id="desktop-update-settings">
            <div className="settings-section-heading">
                <h2>{t('update_title')}</h2>
            </div>
            <div className="desktop-update-content">
                <div className="desktop-update-heading">
                    <span className="desktop-update-icon" aria-hidden="true">
                        {error ? (
                            <WarningCircle />
                        ) : status.phase === 'current' ? (
                            <CheckCircle />
                        ) : (
                            <Download />
                        )}
                    </span>
                    <div>
                        <h3>
                            Cerebr{' '}
                            <span className="desktop-update-version">
                                {status.currentVersion || __CEREBR_VERSION__}
                            </span>
                        </h3>
                        <p role="status">
                            {error
                                ? t(`update_error_${error}`)
                                : t(`update_${status.phase}`, [status.version || '', status.progress || 0])}
                        </p>
                    </div>
                    <button type="button" className="settings-button" disabled={busy} onClick={check}>
                        {status.phase === 'downloaded' ? (
                            <RefreshDouble />
                        ) : (
                            <Download className={status.phase === 'checking' ? 'is-spinning' : ''} />
                        )}
                        {t(
                            status.phase === 'downloaded'
                                ? 'update_restart'
                                : status.phase === 'paused'
                                  ? 'update_resume'
                                  : busy
                                    ? 'update_in_progress'
                                    : 'update_check'
                        )}
                    </button>
                </div>
                {['downloading', 'paused'].includes(status.phase) && (
                    <progress max="100" value={status.progress || 0} aria-label={t('update_progress')} />
                )}
                <p className="desktop-update-note">{t('update_note')}</p>
            </div>
        </section>
    );
}
