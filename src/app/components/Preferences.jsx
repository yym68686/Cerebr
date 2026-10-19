import { DesktopSyncSettings } from './DesktopSyncSettings.jsx';
import { useRef, useState, useSyncExternalStore } from 'react';
import { preferencesStore, changePreference } from '../state/preferences.js';
import { t } from '../../utils/i18n.js';
import {
    createDataBackupSnapshot,
    downloadDataBackup,
    parseDataBackupFile,
    restoreDataBackup,
} from '../../utils/data-transfer.js';
import { chatManager } from '../../domain/chat/chat-store.js';
import { saveApiConfigs } from '../state/api-configs.js';
import { notify } from '../state/ui-store.js';
import { SettingsPage } from './SettingsPage.jsx';
import { Icon } from './Icon.jsx';
import {
    selectionStore,
    loadSelectionSettings,
    setPageSelectionEnabled,
    subscribeSelectionSettings,
} from '../../runtime/selection/selection-store.js';
import { useEffect } from 'react';
export function Preferences({ visible, onBack, saveDraft }) {
    const selection = useSyncExternalStore(selectionStore.subscribe, selectionStore.getSnapshot);
    useEffect(() => {
        void loadSelectionSettings().catch((e) => notify(e.message, { type: 'error' }));
        return subscribeSelectionSettings();
    }, []);
    const values = useSyncExternalStore(preferencesStore.subscribe, preferencesStore.getSnapshot);
    const fileRef = useRef(null);
    const [busy, setBusy] = useState(false);
    const update = (key, value) =>
        void changePreference(key, value).catch((e) => notify(e.message, { type: 'error' }));
    async function exportData() {
        setBusy(true);
        try {
            await saveDraft();
            await chatManager.flushNow();
            await saveApiConfigs();
            downloadDataBackup(await createDataBackupSnapshot({ appVersion: __CEREBR_VERSION__ }));
        } catch (e) {
            notify(e.message, { type: 'error' });
        } finally {
            setBusy(false);
        }
    }
    async function importData(event) {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        setBusy(true);
        try {
            const backup = await parseDataBackupFile(file);
            if (!window.confirm(t('preferences_data_import_confirm'))) return;
            await restoreDataBackup(backup);
            location.reload();
        } catch (e) {
            notify(e.message, { type: 'error' });
        } finally {
            setBusy(false);
        }
    }
    return (
        <SettingsPage
            id="preferences-settings"
            visible={visible}
            onBack={onBack}
            title={t('title_preferences')}
            description={t('preferences_description')}
        >
            <DesktopSyncSettings />
            <section className="preferences-section">
                <div className="settings-section-heading">
                    <h2>{t('preferences_appearance')}</h2>
                </div>
                <div className="theme-choices" role="radiogroup" aria-label={t('preferences_theme_aria')}>
                    {['light', 'dark', 'system'].map((theme) => (
                        <button
                            type="button"
                            key={theme}
                            className={`theme-choice${values.theme === theme ? ' is-selected' : ''}`}
                            role="radio"
                            aria-checked={values.theme === theme}
                            onClick={() => update('theme', theme)}
                        >
                            <span className={`theme-preview theme-preview--${theme}`} aria-hidden="true">
                                <span className="theme-preview-sidebar" />
                                <span className="theme-preview-content">
                                    <i />
                                    <i />
                                    <i />
                                    <b />
                                </span>
                            </span>
                            <span className="theme-choice-label">
                                <Icon
                                    name={theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'monitor'}
                                />
                                {t(`theme_${theme}`)}
                                {values.theme === theme && <Icon name="check" />}
                            </span>
                        </button>
                    ))}
                </div>
                <div className="preference-setting-row">
                    <span id="preferences-font-label">{t('preferences_font_size')}</span>
                    <div className="settings-segmented" role="group" aria-labelledby="preferences-font-label">
                        {[
                            [0.9, 'font_size_small'],
                            [1, 'font_size_standard'],
                            [1.1, 'font_size_large'],
                            [1.2, 'font_size_xlarge'],
                        ].map(([scale, key]) => (
                            <button
                                key={scale}
                                type="button"
                                aria-pressed={values.fontScale === scale}
                                onClick={() => update('fontScale', scale)}
                            >
                                {t(key)}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="preference-setting-row">
                    <label htmlFor="preferences-language">{t('preferences_language_label')}</label>
                    <div className="settings-select-wrap">
                        <select
                            id="preferences-language"
                            className="settings-input"
                            value={values.language}
                            onChange={(e) => update('language', e.target.value)}
                            aria-label={t('preferences_language_aria')}
                        >
                            <option value="auto">{t('language_auto')}</option>
                            <option value="en">{t('language_en')}</option>
                            <option value="zh_CN">{t('language_zh_cn')}</option>
                            <option value="zh_TW">{t('language_zh_tw')}</option>
                        </select>
                        <Icon name="chevron-down" />
                    </div>
                </div>
            </section>
            <section className="preferences-section">
                <div className="settings-section-heading">
                    <h2>{t('preferences_extensions')}</h2>
                </div>
                <div className="preference-setting-row">
                    <div className="preference-setting-copy">
                        <label htmlFor="preferences-selection-actions">
                            {t('preferences_selection_actions')}
                        </label>
                        <p>{t('preferences_selection_actions_hint')}</p>
                    </div>
                    <label className="settings-toggle">
                        <input
                            type="checkbox"
                            id="preferences-selection-actions"
                            checked={selection.pageEnabled}
                            onChange={(event) =>
                                void setPageSelectionEnabled(event.target.checked).catch((e) =>
                                    notify(e.message, { type: 'error' })
                                )
                            }
                        />
                        <span aria-hidden="true" />
                    </label>
                </div>
                <div className="preference-setting-row">
                    <div className="preference-setting-copy">
                        <label htmlFor="preferences-developer-mode">
                            {t('preferences_developer_mode_label')}
                        </label>
                        <p>{t('preferences_developer_hint')}</p>
                    </div>
                    <label className="settings-toggle">
                        <input
                            type="checkbox"
                            id="preferences-developer-mode"
                            checked={values.developerMode}
                            onChange={(e) => update('developerMode', e.target.checked)}
                            aria-label={t('preferences_developer_mode_aria')}
                        />
                        <span aria-hidden="true" />
                    </label>
                </div>
            </section>
            <section className="preferences-section">
                <div className="settings-section-heading">
                    <h2>{t('preferences_data_management')}</h2>
                </div>
                <p className="settings-section-description">{t('preferences_data_description')}</p>
                <div className="settings-action-row">
                    <button
                        className="settings-button"
                        id="preferences-export-data"
                        disabled={busy}
                        onClick={exportData}
                        type="button"
                    >
                        <Icon name="download" />
                        {t('preferences_data_export')}
                    </button>
                    <button
                        className="settings-button"
                        id="preferences-import-data"
                        disabled={busy}
                        onClick={() => fileRef.current.click()}
                        type="button"
                    >
                        <Icon name="upload" />
                        {t('preferences_data_import')}
                    </button>
                </div>
                <input
                    id="preferences-import-file"
                    ref={fileRef}
                    onChange={importData}
                    type="file"
                    accept=".json,application/json"
                    hidden
                />
            </section>
            <footer className="preferences-about">
                <div className="preferences-version">
                    <strong>Cerebr</strong>
                    <span id="preferences-version">{__CEREBR_VERSION__}</span>
                </div>
                <div className="preferences-links">
                    {[
                        ['preferences-oss', 'preferences_open_source', 'https://github.com/yym68686/Cerebr'],
                        ['preferences-telegram', 'preferences_group', 'https://t.me/cerebr_chat'],
                        [
                            'preferences-feedback',
                            'preferences_feedback',
                            'https://github.com/yym68686/Cerebr/issues/new',
                        ],
                    ].map(([id, label, url]) => (
                        <a id={id} key={id} href={url} target="_blank" rel="noreferrer noopener">
                            {t(label)}
                            <Icon name="preferences-oss" />
                        </a>
                    ))}
                </div>
            </footer>
        </SettingsPage>
    );
}
