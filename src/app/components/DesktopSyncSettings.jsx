import { useEffect, useState, useSyncExternalStore } from 'react';
import {
    Computer,
    Internet,
    CheckCircle,
    Copy,
    RefreshDouble,
    Plus,
    NavArrowDown,
    WarningCircle,
    ShieldCheck,
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

export function DesktopSyncSettings() {
    const state = useSyncExternalStore(desktopSyncStore.subscribe, desktopSyncStore.getSnapshot);
    const [code, setCode] = useState(''),
        [error, setError] = useState(''),
        [busy, setBusy] = useState(false),
        [pairingOpen, setPairingOpen] = useState(false),
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
    const counts = isDesktop ? state : state.summary;
    const format = (value) => new Intl.NumberFormat().format(value || 0);
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
    return (
        <section className="preferences-section" id="desktop-sync-settings">
            <div className="settings-section-heading">
                <h2>{t('desktop_sync_title')}</h2>
            </div>
            <div className="sync-card">
                <div className="sync-card-header">
                    <div className="sync-device-mark" aria-hidden="true">
                        <Computer />
                        <span>
                            <Internet />
                        </span>
                    </div>
                    <div className="sync-card-heading">
                        <h3>
                            {t(
                                online
                                    ? 'sync_connection_ready'
                                    : isDesktop
                                      ? 'sync_connect_browser'
                                      : 'sync_connect_desktop'
                            )}
                        </h3>
                        <p>{t(online ? 'sync_connection_subtitle' : 'sync_pairing_subtitle')}</p>
                    </div>
                    <span className={`sync-status${online ? ' is-connected' : ''}`} role="status">
                        <i />
                        {t(online ? 'desktop_sync_connected' : 'desktop_sync_disconnected')}
                    </span>
                </div>
                {online && (
                    <>
                        <div className="sync-overview">
                            <div className="sync-stat">
                                <strong>{format(counts?.chats)}</strong>
                                <span>{t('sync_chats')}</span>
                            </div>
                            <div className="sync-stat">
                                <strong>{format(counts?.messages)}</strong>
                                <span>{t('sync_messages')}</span>
                            </div>
                            <div className="sync-recency">
                                <span>{t('sync_last_update')}</span>
                                <time>
                                    {state.lastSyncAt
                                        ? new Date(state.lastSyncAt).toLocaleTimeString()
                                        : t('sync_preparing')}
                                </time>
                            </div>
                        </div>
                        <div className="sync-capabilities">
                            <span>
                                <CheckCircle />
                                {t('sync_history_and_api')}
                            </span>
                            {(!isDesktop || state.browserSession) && (
                                <span>
                                    <Internet />
                                    {t('sync_webpage_qa')}
                                </span>
                            )}
                        </div>
                    </>
                )}
                {(!online || pairingOpen) && (
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
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    void run(() => pairDesktop(code));
                                }}
                            >
                                <label htmlFor="desktop-pairing-code">{t('desktop_sync_code')}</label>
                                <div className="sync-pairing-row">
                                    <input
                                        id="desktop-pairing-code"
                                        className="settings-input"
                                        autoComplete="off"
                                        spellCheck={false}
                                        maxLength={10}
                                        placeholder="XXXXX XXXXX"
                                        value={code}
                                        onChange={(event) =>
                                            setCode(
                                                event.target.value.replace(/[^a-f0-9]/gi, '').toUpperCase()
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
                        {isDesktop ? (
                            <button
                                type="button"
                                className="sync-button"
                                aria-expanded={pairingOpen}
                                onClick={() => {
                                    setPairingOpen(!pairingOpen);
                                    if (!pairingOpen) void run(refreshDesktopPairing);
                                }}
                            >
                                <Plus />
                                {t('sync_pair_another')}
                            </button>
                        ) : (
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
                                {t(verification.matches ? 'sync_integrity_match' : 'sync_integrity_pending')}
                            </span>
                            <time>{new Date(verification.checkedAt).toLocaleTimeString()}</time>
                            <NavArrowDown />
                        </summary>
                        <div className="sync-verification-details">
                            <p>
                                {t(verification.matches ? 'desktop_sync_verified' : 'desktop_sync_mismatch')}
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
                {(error || state.error) && (
                    <div className="sync-error" role="alert">
                        <WarningCircle />
                        <span>{error || state.error}</span>
                    </div>
                )}
                <div className="sync-local-note">
                    <ShieldCheck />
                    <span>{t('sync_local_note')}</span>
                </div>
            </div>
        </section>
    );
}
