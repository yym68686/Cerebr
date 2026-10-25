import { useEffect, useState, useSyncExternalStore } from 'react';
import {
    Computer,
    Internet,
    CheckCircle,
    Copy,
    RefreshDouble,
    NavArrowDown,
    WarningCircle,
} from 'iconoir-react';
import { isExtensionEnvironment } from '../../utils/storage-adapter.js';
import {
    desktopSyncStore,
    isDesktop,
    pairDesktop,
    refreshDesktopPairing,
    verifyDesktopSync,
    disconnectDesktopSync,
} from '../../runtime/sync/ui-sync.js';
import { t } from '../../utils/i18n.js';
import { DesktopDownload } from './DesktopDownload.jsx';

export function DesktopSyncSettings() {
    const state = useSyncExternalStore(desktopSyncStore.subscribe, desktopSyncStore.getSnapshot);
    const [code, setCode] = useState(''),
        [error, setError] = useState(''),
        [busy, setBusy] = useState(false),
        [expanded, setExpanded] = useState(false),
        [copied, setCopied] = useState(false);
    const online = state.connected && (!isDesktop || state.peers > 0);
    useEffect(() => {
        if (online) setCode('');
    }, [online]);
    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), 1600);
        return () => clearTimeout(timer);
    }, [copied]);
    if (!isDesktop && !isExtensionEnvironment) return null;
    const run = async (operation) => {
        setError('');
        setBusy(true);
        try {
            await operation();
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };
    const verification = state.verification;
    // Older extension backgrounds may still have this transport error in storage.
    // An unavailable desktop app is an ordinary disconnected state.
    const visibleError =
        error || (state.error === '无法连接桌面应用，请确认 Cerebr 已启动。' ? '' : state.error);
    const connectionButton = (
        <button
            type="button"
            className="sync-button"
            aria-expanded={expanded}
            aria-controls="local-sync-detail"
            onClick={() => {
                setExpanded(!expanded);
                if (isDesktop && !expanded) void run(refreshDesktopPairing);
            }}
        >
            {t(online ? 'sync_manage_connection' : 'desktop_sync_connect')}
            <NavArrowDown className={expanded ? 'is-expanded' : ''} />
        </button>
    );
    return (
        <div className="sync-channel" id="desktop-sync-settings">
            <div className="sync-channel-row">
                <Computer className="sync-channel-icon" aria-hidden="true" />
                <h3>{t('local_sync_title')}</h3>
                <span className={`sync-status${online ? ' is-connected' : ''}`} role="status">
                    <i />
                    {t(online ? 'desktop_sync_connected' : 'desktop_sync_disconnected')}
                </span>
            </div>
            <p className="sync-channel-description">
                {t(
                    online
                        ? 'sync_connection_ready'
                        : isDesktop
                          ? 'sync_connect_browser'
                          : 'sync_desktop_description'
                )}
            </p>
            <div className="sync-channel-toolbar">
                {!isDesktop && !online ? (
                    <DesktopDownload>{connectionButton}</DesktopDownload>
                ) : (
                    connectionButton
                )}
            </div>
            {online && (
                <div className="sync-channel-meta">
                    <span>
                        {t('sync_last_update')}{' '}
                        <time>
                            {state.lastSyncAt
                                ? new Date(state.lastSyncAt).toLocaleTimeString()
                                : t('sync_preparing')}
                        </time>
                    </span>
                    {(!isDesktop || state.browserSession) && (
                        <span>
                            <Internet />
                            {t('sync_webpage_qa')}
                        </span>
                    )}
                </div>
            )}
            {expanded && (
                <div className="sync-channel-detail" id="local-sync-detail">
                    {(isDesktop || !online) && (
                        <div className="sync-pairing">
                            {isDesktop ? (
                                <>
                                    <p>{t('sync_code_instruction')}</p>
                                    <div className="sync-pairing-row">
                                        <code className="sync-pairing-code">
                                            {state.pairingCode
                                                ? `${state.pairingCode.slice(0, 5)} ${state.pairingCode.slice(5)}`
                                                : '••••• •••••'}
                                        </code>
                                        <button
                                            type="button"
                                            className="sync-icon-button"
                                            disabled={!state.pairingCode}
                                            title={t(copied ? 'sync_copied' : 'sync_copy_code')}
                                            aria-label={t(copied ? 'sync_copied' : 'sync_copy_code')}
                                            onClick={() =>
                                                void run(async () => {
                                                    await navigator.clipboard.writeText(state.pairingCode);
                                                    setCopied(true);
                                                })
                                            }
                                        >
                                            {copied ? <CheckCircle /> : <Copy />}
                                        </button>
                                        <button
                                            type="button"
                                            className="sync-icon-button"
                                            disabled={busy || !state.connected}
                                            title={t('desktop_sync_pairing_code')}
                                            aria-label={t('desktop_sync_pairing_code')}
                                            onClick={() => void run(refreshDesktopPairing)}
                                        >
                                            <RefreshDouble />
                                        </button>
                                    </div>
                                    <small>{t('sync_code_expiry')}</small>
                                </>
                            ) : (
                                <form
                                    onSubmit={(e) => {
                                        e.preventDefault();
                                        void run(() => pairDesktop(code));
                                    }}
                                >
                                    <p className="sync-pairing-instruction">
                                        {t('sync_desktop_pair_instruction')}
                                    </p>
                                    <label htmlFor="desktop-pairing-code">{t('desktop_sync_code')}</label>
                                    <div className="sync-pairing-row">
                                        <input
                                            id="desktop-pairing-code"
                                            className="settings-input"
                                            autoComplete="off"
                                            spellCheck={false}
                                            maxLength={11}
                                            placeholder="XXXXX XXXXX"
                                            value={code}
                                            onChange={(e) =>
                                                setCode(
                                                    e.target.value
                                                        .replace(/[^a-f0-9]/gi, '')
                                                        .slice(0, 10)
                                                        .toUpperCase()
                                                )
                                            }
                                        />
                                        <button
                                            className="sync-button is-primary"
                                            type="submit"
                                            disabled={busy || code.length !== 10}
                                        >
                                            {t('desktop_sync_connect')}
                                        </button>
                                    </div>
                                </form>
                            )}
                        </div>
                    )}
                    {online && (
                        <div className="sync-actions">
                            <button
                                type="button"
                                className="sync-button"
                                disabled={busy}
                                onClick={() => void run(verifyDesktopSync)}
                            >
                                <RefreshDouble className={busy ? 'is-spinning' : ''} />
                                {t(busy ? 'desktop_sync_verifying' : 'desktop_sync_verify')}
                            </button>
                            {!isDesktop && (
                                <button
                                    type="button"
                                    className="sync-button sync-disconnect"
                                    disabled={busy}
                                    onClick={() => void run(disconnectDesktopSync)}
                                >
                                    {t('desktop_sync_disconnect')}
                                </button>
                            )}
                        </div>
                    )}
                    {verification && (
                        <details className="sync-verification">
                            <summary>
                                {verification.matches ? (
                                    <CheckCircle className="sync-success-icon" />
                                ) : (
                                    <WarningCircle />
                                )}
                                <span>
                                    {t(
                                        verification.matches
                                            ? 'sync_integrity_match'
                                            : 'sync_integrity_pending'
                                    )}
                                </span>
                                <time>{new Date(verification.checkedAt).toLocaleTimeString()}</time>
                                <NavArrowDown />
                            </summary>
                            <div className="sync-verification-details">
                                <p>
                                    {t(
                                        verification.matches
                                            ? 'desktop_sync_verified'
                                            : 'desktop_sync_mismatch'
                                    )}
                                </p>
                                <dl>
                                    <dt>{t('sync_this_device')}</dt>
                                    <dd>
                                        <code>{verification.local.digest}</code>
                                    </dd>
                                    <dt>{t('sync_shared_copy')}</dt>
                                    <dd>
                                        <code>{verification.remote.digest || '—'}</code>
                                    </dd>
                                </dl>
                            </div>
                        </details>
                    )}
                </div>
            )}
            {visibleError && (
                <div className="sync-error" role="alert">
                    <WarningCircle />
                    <span>{visibleError}</span>
                </div>
            )}
        </div>
    );
}
