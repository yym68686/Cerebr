import { useState, useSyncExternalStore } from 'react';
import { Cloud, RefreshDouble, LogOut, CheckCircle, NavArrowDown } from 'iconoir-react';
import { cloudSyncStore, cloudSyncAction } from '../../runtime/sync/cloud-sync.js';
import { t } from '../../utils/i18n.js';

export function CloudSyncSettings() {
    const state = useSyncExternalStore(cloudSyncStore.subscribe, cloudSyncStore.getSnapshot);
    const [mode, setMode] = useState('login'),
        [expanded, setExpanded] = useState(false),
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
    const status = state.syncing
        ? 'cloud_sync_syncing'
        : state.connected
          ? 'desktop_sync_connected'
          : state.connecting
            ? 'cloud_sync_connecting'
            : 'desktop_sync_disconnected';
    return (
        <div className="sync-channel" id="cloud-sync-settings">
            <div className="sync-channel-row">
                <Cloud className="sync-channel-icon" aria-hidden="true" />
                <div className="sync-channel-heading">
                    <h3>
                        {t('cloud_sync_channel')}
                        {state.user && (
                            <span
                                className={`sync-status${state.connected ? ' is-connected' : ''}`}
                                role="status"
                            >
                                <i />
                                {t(status)}
                            </span>
                        )}
                    </h3>
                    <p>{state.user ? state.user.username : t('cloud_sync_description')}</p>
                </div>
                {state.user ? (
                    <div className="sync-row-actions sync-actions">
                        <button
                            className="sync-button"
                            type="button"
                            disabled={busy || state.connecting}
                            onClick={() => run(state.connected ? 'verify' : 'connect')}
                        >
                            <RefreshDouble className={busy || state.syncing ? 'is-spinning' : ''} />
                            {t(
                                busy
                                    ? 'cloud_sync_syncing'
                                    : state.connected
                                      ? 'cloud_sync_now'
                                      : 'cloud_sync_reconnect'
                            )}
                        </button>
                        <button
                            type="button"
                            className="sync-icon-button"
                            disabled={busy}
                            title={t('cloud_sync_logout')}
                            aria-label={t('cloud_sync_logout')}
                            onClick={() => run('logout')}
                        >
                            <LogOut />
                        </button>
                    </div>
                ) : (
                    <button
                        className="sync-button"
                        type="button"
                        aria-expanded={expanded}
                        aria-controls="cloud-sync-auth"
                        onClick={() => setExpanded(!expanded)}
                    >
                        {t('cloud_sync_login')}
                        <NavArrowDown className={expanded ? 'is-expanded' : ''} />
                    </button>
                )}
            </div>
            {state.user ? (
                <div className="sync-channel-meta">
                    <span>
                        {t('sync_last_update')}{' '}
                        <time>
                            {state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleTimeString() : '—'}
                        </time>
                    </span>
                    {state.verification && (
                        <span className="cloud-verification">
                            {state.verification.matches ? <CheckCircle /> : <RefreshDouble />}
                            {t(
                                state.verification.matches ? 'sync_integrity_match' : 'sync_integrity_pending'
                            )}
                        </span>
                    )}
                </div>
            ) : (
                expanded && (
                    <form
                        className="cloud-auth-form sync-channel-detail"
                        id="cloud-sync-auth"
                        onSubmit={(e) => {
                            e.preventDefault();
                            void run(mode, { username, password });
                        }}
                    >
                        <div className="cloud-auth-tabs" role="tablist" aria-label={t('cloud_sync_account')}>
                            {['login', 'register'].map((value) => (
                                <button
                                    key={value}
                                    type="button"
                                    role="tab"
                                    aria-selected={mode === value}
                                    onClick={() => {
                                        setMode(value);
                                        setError('');
                                    }}
                                >
                                    {t(`cloud_sync_${value}`)}
                                </button>
                            ))}
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
                            {t(busy ? 'cloud_sync_submitting' : `cloud_sync_${mode}`)}
                        </button>
                        <p className="cloud-auth-note">{t('cloud_sync_merge_note')}</p>
                    </form>
                )
            )}
            {(error || state.error) && (
                <div className="sync-error" role="alert">
                    {error || state.error}
                </div>
            )}
        </div>
    );
}
