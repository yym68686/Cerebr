import { useState, useSyncExternalStore } from 'react';
import { Cloud, RefreshDouble, LogOut, CheckCircle } from 'iconoir-react';
import { cloudSyncStore, cloudSyncAction } from '../../runtime/sync/cloud-sync.js';
import { t } from '../../utils/i18n.js';

export function CloudSyncSettings() {
    const state = useSyncExternalStore(cloudSyncStore.subscribe, cloudSyncStore.getSnapshot);
    const [mode, setMode] = useState('login'),
        [username, setUsername] = useState(''),
        [password, setPassword] = useState(''),
        [error, setError] = useState(''),
        [busy, setBusy] = useState(false);
    const run = async (action, payload) => {
        setBusy(true);
        setError('');
        try {
            await cloudSyncAction(action, payload);
            setPassword('');
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };
    return (
        <section className="preferences-section" id="cloud-sync-settings">
            <div className="settings-section-heading">
                <h2>{t('sync_title')}</h2>
            </div>
            <div className="sync-card">
                <div className="sync-card-header">
                    <div className="sync-device-mark">
                        <Cloud />
                    </div>
                    <div className="sync-card-heading">
                        <h3>{t('cloud_sync_title')}</h3>
                        <p>{t('cloud_sync_description')}</p>
                    </div>
                    {state.user && (
                        <span
                            className={`sync-status${state.connected ? ' is-connected' : ''}`}
                            role="status"
                        >
                            <i />
                            {t(
                                state.connected
                                    ? 'desktop_sync_connected'
                                    : state.connecting
                                      ? 'cloud_sync_connecting'
                                      : 'desktop_sync_disconnected'
                            )}
                        </span>
                    )}
                </div>
                {state.user ? (
                    <>
                        <div className="cloud-account">
                            <div>
                                <strong>{state.user.username}</strong>
                                <small>{t('cloud_sync_local_first')}</small>
                            </div>
                            <button
                                type="button"
                                className="sync-button"
                                disabled={busy}
                                onClick={() => run('logout')}
                            >
                                <LogOut />
                                {t('cloud_sync_logout')}
                            </button>
                        </div>
                        <div className="sync-overview">
                            <div className="sync-stat">
                                <strong>{new Intl.NumberFormat().format(state.summary?.chats || 0)}</strong>
                                <span>{t('sync_chats')}</span>
                            </div>
                            <div className="sync-stat">
                                <strong>
                                    {new Intl.NumberFormat().format(state.summary?.messages || 0)}
                                </strong>
                                <span>{t('sync_messages')}</span>
                            </div>
                            <div className="sync-recency">
                                <span>{t('sync_last_update')}</span>
                                <time>
                                    {state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleTimeString() : '—'}
                                </time>
                            </div>
                        </div>
                        <div className="sync-actions">
                            <button
                                className="sync-button"
                                type="button"
                                disabled={busy || state.connecting}
                                onClick={() => run(state.connected ? 'verify' : 'connect')}
                            >
                                <RefreshDouble />
                                {t(state.connected ? 'desktop_sync_verify' : 'cloud_sync_reconnect')}
                            </button>
                            {state.verification && (
                                <span className="cloud-verification">
                                    <CheckCircle />
                                    {t(
                                        state.verification.matches
                                            ? 'sync_integrity_match'
                                            : 'sync_integrity_pending'
                                    )}
                                </span>
                            )}
                        </div>
                    </>
                ) : (
                    <form
                        className="cloud-auth-form"
                        onSubmit={(e) => {
                            e.preventDefault();
                            void run(mode, { username, password });
                        }}
                    >
                        <div className="cloud-auth-tabs" role="tablist" aria-label={t('cloud_sync_account')}>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={mode === 'login'}
                                onClick={() => {
                                    setMode('login');
                                    setError('');
                                }}
                            >
                                {t('cloud_sync_login')}
                            </button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={mode === 'register'}
                                onClick={() => {
                                    setMode('register');
                                    setError('');
                                }}
                            >
                                {t('cloud_sync_register')}
                            </button>
                        </div>
                        <div className="cloud-auth-fields">
                            <label>
                                {t('cloud_sync_username')}
                                <input
                                    className="settings-input"
                                    autoComplete="username"
                                    minLength={3}
                                    maxLength={32}
                                    required
                                    value={username}
                                    onChange={(e) => setUsername(e.target.value)}
                                />
                            </label>
                            <label>
                                {t('cloud_sync_password')}
                                <input
                                    className="settings-input"
                                    type="password"
                                    autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                                    minLength={10}
                                    maxLength={128}
                                    required
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                />
                            </label>
                        </div>
                        <button type="submit" className="sync-button is-primary" disabled={busy}>
                            {t(
                                busy
                                    ? 'cloud_sync_submitting'
                                    : mode === 'login'
                                      ? 'cloud_sync_login'
                                      : 'cloud_sync_register'
                            )}
                        </button>
                        <p className="cloud-auth-note">{t('cloud_sync_merge_note')}</p>
                    </form>
                )}
                {(error || state.error) && (
                    <div className="sync-error" role="alert">
                        {error || state.error}
                    </div>
                )}
                <div className="sync-local-note">
                    <CheckCircle />
                    <span>{t('cloud_sync_backup_note')}</span>
                </div>
            </div>
        </section>
    );
}
