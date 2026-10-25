import { useSyncExternalStore } from 'react';
import { ShieldCheck } from 'iconoir-react';
import { cloudSyncStore } from '../../runtime/sync/cloud-sync.js';
import { desktopSyncStore } from '../../runtime/sync/ui-sync.js';
import { CloudSyncSettings } from './CloudSyncSettings.jsx';
import { DesktopSyncSettings } from './DesktopSyncSettings.jsx';
import { t } from '../../utils/i18n.js';

export function SyncSettings() {
    const cloud = useSyncExternalStore(cloudSyncStore.subscribe, cloudSyncStore.getSnapshot);
    const local = useSyncExternalStore(desktopSyncStore.subscribe, desktopSyncStore.getSnapshot);
    const counts = cloud.localSummary ?? local.localSummary ?? cloud.summary ?? local.summary;
    return (
        <section className="preferences-section sync-settings" id="sync-settings">
            <div className="settings-section-heading">
                <h2>{t('sync_title')}</h2>
            </div>
            <p className="sync-section-description">{t('sync_description')}</p>
            {counts && (
                <div className="sync-library" aria-live="polite" aria-atomic="true">
                    <div className="sync-library-heading">
                        <ShieldCheck aria-hidden="true" />
                        <span>{t('sync_library')}</span>
                    </div>
                    <div className="sync-stat">
                        <strong>{new Intl.NumberFormat().format(counts.chats || 0)}</strong>
                        <span>{t('sync_chats')}</span>
                    </div>
                    <div className="sync-stat">
                        <strong>{new Intl.NumberFormat().format(counts.messages || 0)}</strong>
                        <span>{t('sync_messages')}</span>
                    </div>
                </div>
            )}
            <div className="sync-channels">
                <CloudSyncSettings />
                <DesktopSyncSettings />
            </div>
            <p className="sync-section-note">
                <ShieldCheck />
                {t('cloud_sync_backup_note')}
            </p>
        </section>
    );
}
