import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../../utils/i18n.js';
import {
    getPluginMarketplaceModel,
    installMarketplaceItem,
    toggleInstalledPlugin,
    uninstallMarketplaceItem,
    updateMarketplaceItem,
} from '../../plugin/market/plugin-market-service.js';
import {
    getDeveloperPluginModel,
    installLocalScriptPluginFromDataTransfer,
    installLocalScriptPluginFromFileList,
    refreshLocalScriptPlugin,
    uninstallLocalScriptPlugin,
} from '../../plugin/dev/local-plugin-service.js';
import { subscribePluginState } from '../../plugin/shared/plugin-store.js';
import { browserAdapter, isExtensionEnvironment } from '../../utils/storage-adapter.js';
import {
    resolvePluginName,
    resolvePluginDescription,
    getScopeLabel,
    resolveRuntimeHostForScope,
    getKindLabel,
    getPermissionLabel,
    resolveAvailabilityReason,
    resolvePluginHomepageInfo,
    confirmInstall,
    getDiagnosticStateLabel,
    getDiagnosticStateBadgeModifier,
    formatTimestamp,
} from '../state/plugin-settings-model.js';
import { notify } from '../state/ui-store.js';
import { PanelHeader, Slot } from './common.jsx';
import { UserScriptPermission } from './UserScriptPermission.jsx';

function Badge({ children, modifier = '' }) {
    return <span className={`plugin-badge${modifier ? ` plugin-badge--${modifier}` : ''}`}>{children}</span>;
}
function PluginCard({ item, tab, busy, act, diagnostics }) {
    const name = resolvePluginName(item);
    const disabled =
        busy || item.availabilityStatus === 'disabled' || !item.compatible || !item.runtimeSupported;
    const homepage = resolvePluginHomepageInfo(item);
    const diagnostic = diagnostics.find((d) => d.id === item.id) || {
        state: !item.enabled ? 'disabled' : !item.runtimeSupported ? 'unavailable' : 'registered',
        host: resolveRuntimeHostForScope(item.scope),
    };
    const action = (kind, label, isDisabled = false) => (
        <button
            className="plugin-action-button"
            disabled={busy || isDisabled}
            onClick={() => act(kind, item)}
        >
            {t(label)}
        </button>
    );
    return (
        <article className="plugin-card" data-plugin-id={item.id} data-card-kind={tab}>
            <div className="plugin-card__header">
                <div className="plugin-card__content">
                    <div className="plugin-card__title-row">
                        <div className="plugin-card__title-wrap">
                            <h3 className="plugin-card__title">{name}</h3>
                            <div className="plugin-card__version">
                                {t('plugin_version_label')}:{' '}
                                {item.installedVersion || item.latestVersion || item.version || '-'}
                            </div>
                        </div>
                        {tab === 'marketplace' ? (
                            <div className="plugin-card__market-actions">
                                {action(
                                    item.updateAvailable ? 'update' : item.installed ? 'noop' : 'install',
                                    item.devModeOnly
                                        ? 'plugin_action_dev_mode_only'
                                        : !item.runtimeSupported ||
                                            !item.compatible ||
                                            item.availabilityStatus === 'disabled'
                                          ? 'plugin_action_unavailable'
                                          : item.kind === 'builtin' && item.installed && !item.canUninstall
                                            ? 'plugin_action_builtin'
                                            : item.updateAvailable
                                              ? 'plugin_action_update'
                                              : item.installed
                                                ? 'plugin_action_installed'
                                                : 'plugin_action_install',
                                    disabled || (item.installed && !item.updateAvailable) || item.devModeOnly
                                )}
                            </div>
                        ) : (
                            <label className="switch plugin-card__switch">
                                <input
                                    type="checkbox"
                                    checked={!!item.enabled}
                                    disabled={disabled}
                                    aria-label={t('plugin_toggle_enable_aria', [name])}
                                    onChange={() => act('toggle', item)}
                                />
                                <span className="slider" aria-hidden="true" />
                            </label>
                        )}
                    </div>
                    <p className="plugin-card__description">{resolvePluginDescription(item)}</p>
                    <div className="plugin-card__meta">
                        <Badge>
                            {t(
                                item.sourceType === 'builtin'
                                    ? 'plugin_source_builtin'
                                    : item.sourceType === 'developer'
                                      ? 'plugin_source_developer'
                                      : 'plugin_source_registry'
                            )}
                        </Badge>
                        <Badge>{getKindLabel(item.kind)}</Badge>
                        <Badge>{getScopeLabel(item.scope)}</Badge>
                        {item.requiresExtension && <Badge>{t('plugin_requires_extension')}</Badge>}
                        {item.permissions?.map((p) => (
                            <Badge key={p}>{getPermissionLabel(p)}</Badge>
                        ))}
                        {item.updateAvailable && (
                            <Badge modifier="highlight">{t('plugin_status_update_available')}</Badge>
                        )}
                        {!item.compatible && (
                            <Badge modifier="warning">{t('plugin_status_incompatible')}</Badge>
                        )}
                        {item.availabilityStatus === 'disabled' && (
                            <Badge modifier="warning">{t('plugin_status_disabled_remotely')}</Badge>
                        )}
                    </div>
                    {tab === 'developer' && (
                        <div className="plugin-card__field">
                            <span className="plugin-card__field-label">{t('plugin_dev_source_field')}</span>
                            <code className="plugin-card__source">
                                {item.sourceLabel || item.manifestUrl || '-'}
                            </code>
                        </div>
                    )}
                    {homepage && (
                        <div className="plugin-card__field">
                            <span className="plugin-card__field-label">{t('plugin_open_source_field')}</span>
                            {homepage.href ? (
                                <a
                                    className="plugin-card__link"
                                    href={homepage.href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    {homepage.label}
                                </a>
                            ) : (
                                <code className="plugin-card__source">{homepage.label}</code>
                            )}
                        </div>
                    )}
                    {tab !== 'marketplace' && (
                        <div className="plugin-card__field plugin-card__field--diagnostics">
                            <span className="plugin-card__field-label">{t('plugin_diag_runtime_field')}</span>
                            <div className="plugin-card__field-inline">
                                <Badge>{getScopeLabel(diagnostic.host)}</Badge>
                                <Badge modifier={getDiagnosticStateBadgeModifier(diagnostic.state)}>
                                    {getDiagnosticStateLabel(diagnostic.state)}
                                </Badge>
                            </div>
                            <div className="plugin-card__field-list">
                                {[
                                    [
                                        t('plugin_diag_activation_field'),
                                        diagnostic.activationEvents?.join(', '),
                                    ],
                                    [t('plugin_diag_last_event_field'), diagnostic.lastActivationEvent],
                                    [
                                        t('plugin_diag_last_activated_field'),
                                        diagnostic.lastActivatedAt &&
                                            formatTimestamp(diagnostic.lastActivatedAt),
                                    ],
                                    [t('plugin_diag_failures_field'), diagnostic.failures],
                                    [
                                        t('plugin_diag_error_field'),
                                        diagnostic.lastError?.message || diagnostic.error,
                                    ],
                                ]
                                    .filter(([, value]) => value)
                                    .map(([label, value]) => (
                                        <div className="plugin-card__field-item" key={label}>
                                            <span className="plugin-card__field-item-label">{label}</span>
                                            <span className="plugin-card__field-item-value">{value}</span>
                                        </div>
                                    ))}
                            </div>
                        </div>
                    )}
                    <code className="plugin-card__id">{item.id}</code>
                    {tab !== 'marketplace' && (
                        <div className="plugin-card__footer">
                            {item.updateAvailable && action('update', 'plugin_action_update', disabled)}
                            {tab === 'developer' &&
                                action('refresh-local', 'plugin_dev_action_refresh', !item.canRefresh)}
                            {(item.canUninstall || tab === 'developer') &&
                                action(
                                    tab === 'developer' ? 'uninstall-local' : 'uninstall',
                                    'plugin_action_uninstall'
                                )}
                        </div>
                    )}
                </div>
            </div>
            {(resolveAvailabilityReason(item) || (!item.runtimeSupported && item.requiresExtension)) && (
                <p className="plugin-card__footnote">
                    {resolveAvailabilityReason(item) || t('plugin_disabled_requires_extension')}
                </p>
            )}
        </article>
    );
}
export function PluginSettings({ visible, onBack, session }) {
    const [tab, setTab] = useState(new URLSearchParams(location.search).get('pluginTab') || 'installed');
    const [model, setModel] = useState({ installedItems: [], marketplaceItems: [], developerItems: [] });
    const [diagnostics, setDiagnostics] = useState([]);
    const [status, setStatus] = useState(''),
        [busy, setBusy] = useState(false),
        [drag, setDrag] = useState(false);
    const fileRef = useRef(null),
        generation = useRef(0);
    const refresh = useCallback(async () => {
        const token = ++generation.current;
        setStatus(t('plugin_market_loading'));
        try {
            const [market, dev] = await Promise.all([getPluginMarketplaceModel(), getDeveloperPluginModel()]);
            let all = (session?.runtime.getDiagnostics() || []).map((d) => ({ ...d, host: 'shell' }));
            if (isExtensionEnvironment) {
                try {
                    const data = await browserAdapter.sendMessage({ type: 'GET_PLUGIN_RUNTIME_DIAGNOSTICS' });
                    for (const host of ['page', 'background'])
                        all.push(...(data?.hosts?.[host]?.diagnostics || []).map((d) => ({ ...d, host })));
                } catch {}
            }
            if (token !== generation.current) return;
            setModel({ ...market, developerItems: dev.items || [] });
            setDiagnostics(all);
            const latestSource = market.sources
                ?.filter((source) => source.ok && source.generatedAt)
                .sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt))[0];
            setStatus(
                market.sources?.length && !market.sources.some((s) => s.ok)
                    ? t('plugin_market_sync_failed')
                    : latestSource
                      ? t('plugin_market_last_synced', [formatTimestamp(latestSource.generatedAt)])
                      : ''
            );
        } catch (error) {
            if (token === generation.current)
                setStatus(`${t('plugin_market_sync_failed')}: ${error.message}`);
        }
    }, [session]);
    useEffect(() => {
        if (!visible) return;
        void refresh();
        const stop = subscribePluginState(() => void refresh());
        return () => {
            stop();
            generation.current++;
        };
    }, [visible, refresh]);
    const run = async (fn) => {
        setBusy(true);
        try {
            await fn();
            await refresh();
        } catch (error) {
            if (error.name !== 'AbortError') notify(error.message, { type: 'error', durationMs: 4000 });
        } finally {
            setBusy(false);
            setDrag(false);
        }
    };
    const act = (action, item) => {
        if (action === 'install' && !confirmInstall(item)) return;
        if (
            action.startsWith('uninstall') &&
            !window.confirm(t('plugin_uninstall_confirm_title', [resolvePluginName(item)]))
        )
            return;
        void run(async () => {
            if (action === 'install') {
                await installMarketplaceItem(item);
                setTab('installed');
            }
            if (action === 'update') await updateMarketplaceItem(item);
            if (action === 'toggle') await toggleInstalledPlugin(item, !item.enabled);
            if (action === 'uninstall') await uninstallMarketplaceItem(item);
            if (action === 'uninstall-local') await uninstallLocalScriptPlugin(item.id);
            if (action === 'refresh-local') await refreshLocalScriptPlugin(item.id);
        });
    };
    return (
        <div id="plugin-settings" className={visible ? 'visible' : ''} hidden={!visible}>
            <PanelHeader title={t('title_plugins')} onBack={onBack} />
            <div className="plugin-settings-content">
                <p className="plugin-settings-intro">{t('plugins_manage_caption')}</p>
                {isExtensionEnvironment && <UserScriptPermission visible={visible} />}
                <Slot name="shell.settings.section" />
                <div className="plugin-settings-toolbar">
                    <div
                        className="plugin-settings-tabs"
                        role="tablist"
                        aria-label={t('plugin_tablist_aria')}
                    >
                        {['installed', 'marketplace', 'developer'].map((id) => (
                            <button
                                className={`plugin-settings-tab${id === tab ? ' is-active' : ''}`}
                                type="button"
                                role="tab"
                                aria-selected={id === tab}
                                data-plugin-tab={id}
                                key={id}
                                onClick={() => setTab(id)}
                            >
                                {t(`plugin_tab_${id}`)}
                            </button>
                        ))}
                    </div>
                    <div className="plugin-settings-status" id="plugin-settings-status">
                        {status}
                    </div>
                </div>
                {['installed', 'marketplace', 'developer'].map((id) => (
                    <section
                        key={id}
                        className={`plugin-settings-panel${id === tab ? ' visible' : ''}`}
                        data-plugin-panel={id}
                        hidden={id !== tab}
                    >
                        {id === 'developer' && (
                            <div className="plugin-dev-import">
                                <div className="plugin-dev-import__copy">
                                    <div className="plugin-dev-import__label">
                                        {t('plugin_dev_guest_title')}
                                    </div>
                                    <p className="plugin-dev-import__hint">{t('plugin_dev_guest_hint')}</p>
                                </div>
                                <div
                                    className={`plugin-dev-dropzone${drag ? ' is-dragover' : ''}`}
                                    id="developer-plugin-dropzone"
                                    tabIndex={0}
                                    onClick={() => fileRef.current.click()}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') fileRef.current.click();
                                    }}
                                    onDragOver={(e) => {
                                        e.preventDefault();
                                        setDrag(true);
                                    }}
                                    onDragLeave={() => setDrag(false)}
                                    onDrop={(e) => {
                                        e.preventDefault();
                                        const data = e.dataTransfer;
                                        void run(() => installLocalScriptPluginFromDataTransfer(data));
                                    }}
                                >
                                    <div className="plugin-dev-dropzone__title">
                                        {t('plugin_dev_drop_title')}
                                    </div>
                                    <button
                                        className="plugin-action-button"
                                        disabled={busy}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            fileRef.current.click();
                                        }}
                                    >
                                        {t('plugin_dev_action_pick_folder')}
                                    </button>
                                </div>
                                <input
                                    type="file"
                                    ref={fileRef}
                                    id="developer-plugin-folder-input"
                                    webkitdirectory=""
                                    directory=""
                                    multiple
                                    hidden
                                    onChange={(e) => {
                                        const files = [...e.target.files];
                                        e.target.value = '';
                                        if (files.length)
                                            void run(() => installLocalScriptPluginFromFileList(files));
                                    }}
                                />
                            </div>
                        )}
                        <div className="plugin-list" id={`${id}-plugin-list`}>
                            {model[`${id}Items`]?.map((item) => (
                                <PluginCard
                                    key={item.id}
                                    item={item}
                                    tab={id}
                                    act={act}
                                    busy={busy}
                                    diagnostics={diagnostics}
                                />
                            ))}
                        </div>
                        {!model[`${id}Items`]?.length && (
                            <div className="plugin-settings-empty">{t(`plugins_${id}_empty`)}</div>
                        )}
                    </section>
                ))}
            </div>
        </div>
    );
}
