import { useEffect, useState } from 'react';
import { Download, NavArrowDown } from 'iconoir-react';
import {
    DESKTOP_DOWNLOADS,
    DESKTOP_RELEASES_URL,
    desktopDownloadUrl,
    detectDesktopDownload,
} from '../../platform/desktop-downloads.js';
import { t } from '../../utils/i18n.js';

export function DesktopDownload({ children }) {
    const [detected, setDetected] = useState({ platform: '', target: '' });
    const [selected, setSelected] = useState(null);
    useEffect(() => {
        let active = true;
        void detectDesktopDownload().then((result) => {
            if (active) setDetected(result);
        });
        return () => {
            active = false;
        };
    }, []);
    const target = selected ?? detected.target;
    const url = desktopDownloadUrl(target);
    return (
        <div className="sync-desktop-download">
            <div className="sync-download-select">
                <select
                    aria-label={t('desktop_download_platform')}
                    value={target}
                    onChange={(event) => setSelected(event.target.value)}
                >
                    <option value="" disabled>
                        {t(
                            detected.platform === 'mac'
                                ? 'desktop_download_mac_chip'
                                : 'desktop_download_platform'
                        )}
                    </option>
                    {DESKTOP_DOWNLOADS.map(({ id, label }) => (
                        <option key={id} value={id}>
                            {label}
                        </option>
                    ))}
                </select>
                <NavArrowDown aria-hidden="true" />
            </div>
            <div className="sync-row-actions">
                {url ? (
                    <a className="sync-button is-primary" href={url} download>
                        <Download aria-hidden="true" />
                        {t('desktop_download')}
                    </a>
                ) : (
                    <button className="sync-button is-primary" type="button" disabled>
                        <Download aria-hidden="true" />
                        {t('desktop_download')}
                    </button>
                )}
                {children}
            </div>
            <a className="sync-release-link" href={DESKTOP_RELEASES_URL} target="_blank" rel="noreferrer">
                {t('desktop_download_releases')}
            </a>
        </div>
    );
}
