import { t } from '../../utils/i18n.js';

export function DesktopTitlebar() {
    const desktop = globalThis.cerebrDesktop;
    // macOS already supplies native window controls. A full-width renderer
    // titlebar would cover scrolled messages in this frameless window.
    if (!desktop || desktop.platform === 'darwin') return null;
    return (
        <div className="desktop-window-controls">
            <button
                type="button"
                aria-label={t('desktop_window_minimize')}
                onClick={() => desktop.windowAction('minimize')}
            >
                <svg viewBox="0 0 12 12">
                    <path d="M2 6h8" />
                </svg>
            </button>
            <button
                type="button"
                aria-label={t('desktop_window_maximize')}
                onClick={() => desktop.windowAction('maximize')}
            >
                <svg viewBox="0 0 12 12">
                    <rect x="2.5" y="2.5" width="7" height="7" rx=".5" />
                </svg>
            </button>
            <button
                type="button"
                className="desktop-window-close"
                aria-label={t('desktop_window_close')}
                onClick={() => desktop.windowAction('close')}
            >
                <svg viewBox="0 0 12 12">
                    <path d="m2.5 2.5 7 7m0-7-7 7" />
                </svg>
            </button>
        </div>
    );
}
