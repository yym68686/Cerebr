import { useRef, useState, useSyncExternalStore } from 'react';
import {
    apiStore,
    changeConfig,
    selectConfig,
    duplicateConfig,
    deleteConfig,
    addConfig,
    saveApiConfigs,
} from '../state/api-configs.js';
import { t } from '../../utils/i18n.js';
import { modelSupportsReasoningEffort } from '../../utils/reasoning-effort.js';
import { normalizeChatCompletionsUrl } from '../../utils/api-url.js';
import { notify } from '../state/ui-store.js';
import { SettingsPage } from './SettingsPage.jsx';
import { Icon } from './Icon.jsx';
import { getChatModelSelection } from '../../domain/chat/model-selection.js';
import { ModelNameInput } from './ModelNameInput.jsx';

const report = (error) => notify(error.message, { type: 'error' });
const endpointLabel = (value) => {
    try {
        return new URL(value).host;
    } catch {
        return t('api_endpoint_empty');
    }
};

function ConnectionEditor({
    config,
    models,
    selectedModel,
    index,
    selected,
    canDelete,
    onDuplicate,
    onDelete,
    onSelect,
}) {
    const [showKey, setShowKey] = useState(false);
    const modelEdited = useRef(false);
    const advanced = config.advancedSettings;
    const change = (patch) => changeConfig(config.id, patch);
    return (
        <div className="connection-editor">
            <div className="connection-editor-heading">
                <div>
                    <h2>{config.modelName || endpointLabel(config.baseUrl)}</h2>
                    <span>{t('api_connection_details')}</span>
                </div>
                <div className="connection-actions">
                    <button
                        type="button"
                        className="settings-icon-button"
                        title={t('api_duplicate_config_aria')}
                        aria-label={t('api_duplicate_config_aria')}
                        onClick={onDuplicate}
                    >
                        <Icon name="copy-message" />
                    </button>
                    <button
                        type="button"
                        className="settings-icon-button is-destructive"
                        title={t('api_delete_config_aria')}
                        aria-label={t('api_delete_config_aria')}
                        disabled={!canDelete}
                        onClick={onDelete}
                    >
                        <Icon name="delete-message" />
                    </button>
                </div>
            </div>
            <div className="connection-fields">
                {[
                    ['baseUrl', 'base_url_label', 'base_url_placeholder'],
                    ['apiKey', 'api_key_label', 'api_key_placeholder'],
                ].map(([key, label, placeholder]) => (
                    <div className="settings-field" key={key}>
                        <label htmlFor={`${config.id}-${key}`}>{t(label)}</label>
                        <div className={key === 'apiKey' ? 'settings-secret-field' : undefined}>
                            <input
                                id={`${config.id}-${key}`}
                                name={key}
                                className="settings-input"
                                type={key === 'apiKey' && !showKey ? 'password' : 'text'}
                                autoComplete="off"
                                spellCheck={false}
                                autoCapitalize="off"
                                inputMode={key === 'baseUrl' ? 'url' : undefined}
                                placeholder={t(placeholder)}
                                value={config[key]}
                                onChange={(e) => change({ [key]: e.target.value })}
                                onBlur={(e) => {
                                    if (key === 'baseUrl')
                                        change({ baseUrl: normalizeChatCompletionsUrl(e.target.value) });
                                    void saveApiConfigs().catch(report);
                                }}
                            />
                            {key === 'apiKey' && (
                                <button
                                    type="button"
                                    className="settings-icon-button"
                                    aria-label={t(showKey ? 'api_hide_key' : 'api_show_key')}
                                    onClick={() => setShowKey(!showKey)}
                                >
                                    <Icon name={showKey ? 'eye-off' : 'eye'} />
                                </button>
                            )}
                        </div>
                    </div>
                ))}
            </div>
            <div className="connection-advanced">
                <button
                    className="connection-disclosure"
                    type="button"
                    aria-expanded={advanced.isExpanded}
                    aria-controls={`${config.id}-advanced`}
                    onClick={() => change({ advancedSettings: { isExpanded: !advanced.isExpanded } })}
                >
                    <Icon name="chevron-right" />
                    <span>{t('api_advanced_settings')}</span>
                    <small>{t('api_advanced_settings_summary')}</small>
                </button>
                <div
                    id={`${config.id}-advanced`}
                    hidden={!advanced.isExpanded}
                    className="connection-advanced-fields"
                >
                    <div className="settings-field">
                        <label htmlFor={`${config.id}-modelName`}>{t('model_name_label')}</label>
                        <ModelNameInput
                            id={`${config.id}-modelName`}
                            value={config.modelName}
                            models={models}
                            onChange={(modelName) => {
                                modelEdited.current = true;
                                change({ modelName });
                            }}
                            onBlur={(e) => {
                                void saveApiConfigs().catch(report);
                                if (modelEdited.current && selected)
                                    void onSelect(index, e.target.value).catch(report);
                                modelEdited.current = false;
                            }}
                        />
                    </div>
                    <div className="settings-field">
                        <label htmlFor={`${config.id}-prompt`}>{t('api_system_prompt_label')}</label>
                        <p>{t('api_system_prompt_hint')}</p>
                        <textarea
                            id={`${config.id}-prompt`}
                            name="systemPrompt"
                            className="settings-input"
                            rows={5}
                            value={advanced.systemPrompt}
                            onChange={(e) => change({ advancedSettings: { systemPrompt: e.target.value } })}
                            onBlur={() => void saveApiConfigs().catch(report)}
                        />
                    </div>
                    {modelSupportsReasoningEffort(config.modelName || selectedModel || models[0]) && (
                        <div className="settings-field">
                            <label htmlFor={`${config.id}-reasoning`}>
                                {t('api_reasoning_effort_label')}
                            </label>
                            <p>{t('api_reasoning_effort_hint')}</p>
                            <select
                                id={`${config.id}-reasoning`}
                                name="reasoningEffort"
                                className="settings-input"
                                value={advanced.reasoningEffort}
                                onChange={(e) =>
                                    change({ advancedSettings: { reasoningEffort: e.target.value } })
                                }
                            >
                                {['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((v) => (
                                    <option key={v}>{v}</option>
                                ))}
                            </select>
                        </div>
                    )}
                </div>
            </div>
            <div className="connection-editor-footer">
                <span>{t('settings_auto_save')}</span>
                <button
                    type="button"
                    className={`settings-button${selected ? ' is-current' : ' is-primary'}`}
                    disabled={selected}
                    onClick={() => void onSelect(index).catch(report)}
                >
                    <Icon name={selected ? 'check' : 'brain'} />
                    {t(selected ? 'api_in_use' : 'api_use_connection')}
                </button>
            </div>
        </div>
    );
}

export function ApiSettings({ visible, onBack, chat, onSelectConfig = selectConfig }) {
    const state = useSyncExternalStore(apiStore.subscribe, apiStore.getSnapshot);
    const selection = getChatModelSelection(chat, state);
    const selected = state.configs.findIndex((config) => config.id === selection?.configId);
    const [editingId, setEditingId] = useState(null);
    const editing =
        state.configs.find((config) => config.id === editingId) ||
        state.configs[selected] ||
        state.configs[0];
    const index = state.configs.indexOf(editing);
    const run = (callback) => {
        void Promise.resolve().then(callback).catch(report);
    };
    return (
        <SettingsPage
            id="api-settings"
            visible={visible}
            onBack={onBack}
            title={t('title_api_settings')}
            description={t('api_settings_description')}
        >
            <div className="connections-workspace">
                <div className="connections-list">
                    <div className="settings-section-heading">
                        <h2>{t('api_connections')}</h2>
                        <span>{state.configs.length}</span>
                        <button
                            type="button"
                            className="settings-icon-button"
                            aria-label={t('api_add_connection')}
                            title={t('api_add_connection')}
                            onClick={() => run(async () => setEditingId(await addConfig()))}
                        >
                            <Icon name="settings-button" />
                        </button>
                    </div>
                    <div className="connections-items" role="group" aria-label={t('api_connections')}>
                        {state.configs.map((config, i) => (
                            <button
                                type="button"
                                key={config.id}
                                className={`connection-item${config.id === editing?.id ? ' is-editing' : ''}`}
                                aria-pressed={config.id === editing?.id}
                                onClick={() => setEditingId(config.id)}
                            >
                                <span className="connection-item-icon">
                                    <Icon name="brain" />
                                </span>
                                <span className="connection-item-copy">
                                    <strong>{config.modelName || endpointLabel(config.baseUrl)}</strong>
                                    <small>{endpointLabel(config.baseUrl)}</small>
                                </span>
                                {i === selected && (
                                    <span
                                        className="connection-active-dot"
                                        title={t('api_in_use')}
                                        aria-label={t('api_in_use')}
                                    />
                                )}
                            </button>
                        ))}
                    </div>
                </div>
                {editing && (
                    <ConnectionEditor
                        key={editing.id}
                        config={editing}
                        models={state.modelLists?.[editing.id] || []}
                        selectedModel={selection?.configId === editing.id ? selection.modelName : undefined}
                        index={index}
                        selected={selection?.configId === editing.id}
                        onSelect={onSelectConfig}
                        canDelete={state.configs.length > 1}
                        onDuplicate={() =>
                            run(async () => {
                                await duplicateConfig(index);
                                setEditingId(apiStore.getSnapshot().configs.at(-1).id);
                            })
                        }
                        onDelete={() =>
                            run(async () => {
                                await deleteConfig(index);
                                setEditingId(null);
                            })
                        }
                    />
                )}
            </div>
        </SettingsPage>
    );
}
