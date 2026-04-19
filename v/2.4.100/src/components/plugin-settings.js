import { getActiveLocale, t } from '../utils/i18n.js';
import { resolvePluginLocalizedText } from '../plugin/core/plugin-i18n.js';
import {
    getPluginMarketplaceModel,
    installMarketplaceItem,
    toggleInstalledPlugin,
    uninstallMarketplaceItem,
    updateMarketplaceItem,
} from '../plugin/market/plugin-market-service.js';
import {
    getDeveloperPluginModel,
    installLocalScriptPluginFromDataTransfer,
    installLocalScriptPluginFromFileList,
    refreshLocalScriptPlugin,
    uninstallLocalScriptPlugin,
} from '../plugin/dev/local-plugin-service.js';
import { subscribePluginState } from '../plugin/shared/plugin-store.js';
import { isExtensionContextInvalidatedError } from '../utils/storage-adapter.js';
import { showToast } from '../utils/ui.js';

function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function resolveHostLocalizedText(key, fallback = '') {
    const normalizedKey = String(key || '').trim();
    const normalizedFallback = String(fallback || '').trim();

    if (!normalizedKey) {
        return normalizedFallback;
    }

    const translated = t(normalizedKey);
    if (translated && translated !== normalizedKey) {
        return translated;
    }

    return normalizedFallback || normalizedKey;
}

function resolveLocalizedText(item, key, fallback = '') {
    const normalizedKey = String(key || '').trim();
    const normalizedFallback = String(fallback || '').trim();

    if (!normalizedKey) {
        return normalizedFallback;
    }

    const pluginI18n = item?.manifest?.i18n && typeof item.manifest.i18n === 'object'
        ? item.manifest.i18n
        : (item?.i18n && typeof item.i18n === 'object' ? item.i18n : null);
    return resolvePluginLocalizedText({
        i18n: pluginI18n,
        locale: getActiveLocale(),
        key: normalizedKey,
        fallback: normalizedFallback,
        hostGetMessage(messageKey, substitutions = [], hostFallback = '') {
            const translated = t(messageKey, substitutions);
            if (translated && translated !== messageKey) {
                return translated;
            }
            return hostFallback;
        },
    });
}

function resolvePluginName(item) {
    return resolveLocalizedText(item, item?.nameKey, item?.displayName || item?.id);
}

function resolvePluginDescription(item) {
    return resolveLocalizedText(item, item?.descriptionKey, item?.description);
}

function resolveAvailabilityReason(item) {
    return resolveHostLocalizedText(item?.availabilityReasonKey, item?.availabilityReason);
}

function getPermissionLabel(permission) {
    const mapping = {
        'prompt:fragments': 'plugin_permission_prompt_fragments',
        'prompt:extend': 'plugin_permission_prompt_extend',
        'page:selection': 'plugin_permission_page_selection',
        'page:selection:read': 'plugin_permission_page_selection_read',
        'page:selection:clear': 'plugin_permission_page_selection_clear',
        'shell:input': 'plugin_permission_shell_input',
        'shell:input:read': 'plugin_permission_shell_input_read',
        'shell:input:write': 'plugin_permission_shell_input_write',
        'shell:input:mount': 'plugin_permission_shell_input_mount',
        'shell:input:actions': 'plugin_permission_shell_input_actions',
        'shell:input:slash-commands': 'plugin_permission_shell_input_slash_commands',
        'shell:input:modal': 'plugin_permission_shell_input_modal',
        'shell:input:layout': 'plugin_permission_shell_input_layout',
        'shell:menu': 'plugin_permission_shell_menu',
        'shell:menu:items': 'plugin_permission_shell_menu_items',
        'shell:page': 'plugin_permission_shell_page',
        'shell:page:control': 'plugin_permission_shell_page_control',
        'page:read': 'plugin_permission_page_read',
        'page:snapshot': 'plugin_permission_page_snapshot',
        'page:extractors': 'plugin_permission_page_extractors',
        'page:query': 'plugin_permission_page_query',
        'page:observe': 'plugin_permission_page_observe',
        'page:observe:selectors': 'plugin_permission_page_observe_selectors',
        'page:write': 'plugin_permission_page_write',
        'chat:read': 'plugin_permission_chat_read',
        'chat:current': 'plugin_permission_chat_current',
        'chat:messages': 'plugin_permission_chat_messages',
        'chat:write': 'plugin_permission_chat_write',
        'chat:send': 'plugin_permission_chat_send',
        'chat:abort': 'plugin_permission_chat_abort',
        'chat:retry': 'plugin_permission_chat_retry',
        'chat:cancel': 'plugin_permission_chat_cancel',
        'chat:regenerate': 'plugin_permission_chat_regenerate',
        'site:read': 'plugin_permission_site_read',
        'site:query': 'plugin_permission_site_query',
        'site:write': 'plugin_permission_site_write',
        'site:fill': 'plugin_permission_site_fill',
        'site:click': 'plugin_permission_site_click',
        'site:observe': 'plugin_permission_site_observe',
        'ui:mount': 'plugin_permission_ui_mount',
        'ui:slots': 'plugin_permission_ui_slots',
        'ui:anchored-action': 'plugin_permission_ui_anchored_action',
        'tabs:read': 'plugin_permission_tabs_read',
        'tabs:query': 'plugin_permission_tabs_query',
        'tabs:query:active': 'plugin_permission_tabs_query_active',
        'tabs:get': 'plugin_permission_tabs_get',
        'tabs:write': 'plugin_permission_tabs_write',
        'tabs:reload': 'plugin_permission_tabs_reload',
        'tabs:message': 'plugin_permission_tabs_message',
        'storage:read': 'plugin_permission_storage_read',
        'storage:read:local': 'plugin_permission_storage_read_local',
        'storage:read:sync': 'plugin_permission_storage_read_sync',
        'storage:write': 'plugin_permission_storage_write',
        'storage:write:local': 'plugin_permission_storage_write_local',
        'storage:write:sync': 'plugin_permission_storage_write_sync',
        'bridge:send': 'plugin_permission_bridge_send',
        'bridge:send:page': 'plugin_permission_bridge_send_page',
        'bridge:send:shell': 'plugin_permission_bridge_send_shell',
        'bridge:send:background': 'plugin_permission_bridge_send_background',
    };

    const key = mapping[permission];
    return key ? t(key) : permission;
}

function getScopeLabel(scope) {
    if (scope === 'page') return t('plugin_scope_page');
    if (scope === 'shell') return t('plugin_scope_shell');
    if (scope === 'prompt') return t('plugin_scope_prompt');
    if (scope === 'background') return t('plugin_scope_background');
    return scope;
}

function getKindLabel(kind) {
    if (kind === 'builtin') return t('plugin_kind_builtin');
    if (kind === 'declarative') return t('plugin_kind_declarative');
    if (kind === 'script') return t('plugin_kind_script');
    return kind;
}

function resolveRuntimeHostForScope(scope) {
    if (scope === 'page') return 'page';
    if (scope === 'background') return 'background';
    return 'shell';
}

function getDiagnosticStateLabel(state) {
    const mapping = {
        active: 'plugin_diag_state_active',
        registered: 'plugin_diag_state_registered',
        activating: 'plugin_diag_state_activating',
        error: 'plugin_diag_state_error',
        disabled: 'plugin_diag_state_disabled',
        unavailable: 'plugin_diag_state_unavailable',
    };

    const key = mapping[state];
    return key ? t(key) : normalizeString(state || 'registered');
}

function getDiagnosticStateBadgeModifier(state) {
    if (state === 'active') return 'highlight';
    if (state === 'activating') return 'warning';
    if (state === 'error') return 'danger';
    if (state === 'unavailable') return 'warning';
    if (state === 'disabled') return 'muted';
    return '';
}

function createBadge(label, modifier = '') {
    const badge = document.createElement('span');
    badge.className = `plugin-badge${modifier ? ` plugin-badge--${modifier}` : ''}`;
    badge.textContent = label;
    return badge;
}

function createActionButton({ label, action, disabled = false }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'plugin-action-button';
    button.dataset.pluginAction = action;
    button.disabled = disabled;
    button.textContent = label;
    return button;
}

function formatTimestamp(timestamp) {
    if (!timestamp) return '';

    try {
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) return timestamp;
        return date.toLocaleString();
    } catch {
        return timestamp;
    }
}

function createDiagnosticRow(label, value, { error = false } = {}) {
    const row = document.createElement('div');
    row.className = 'plugin-card__field-item';

    const labelNode = document.createElement('span');
    labelNode.className = 'plugin-card__field-item-label';
    labelNode.textContent = label;

    const valueNode = document.createElement('span');
    valueNode.className = `plugin-card__field-item-value${error ? ' plugin-card__field-item-value--error' : ''}`;
    valueNode.textContent = value;

    row.appendChild(labelNode);
    row.appendChild(valueNode);
    return row;
}

function buildRuntimeDiagnosticsBlock(item) {
    const diagnostic = item?.runtimeDiagnostic;
    if (!diagnostic) {
        return null;
    }

    const block = document.createElement('div');
    block.className = 'plugin-card__field plugin-card__field--diagnostics';

    const label = document.createElement('span');
    label.className = 'plugin-card__field-label';
    label.textContent = t('plugin_diag_runtime_field');

    const summary = document.createElement('div');
    summary.className = 'plugin-card__field-inline';
    summary.appendChild(createBadge(getScopeLabel(diagnostic.host || resolveRuntimeHostForScope(item?.scope))));
    summary.appendChild(createBadge(
        getDiagnosticStateLabel(diagnostic.state),
        getDiagnosticStateBadgeModifier(diagnostic.state)
    ));

    block.appendChild(label);
    block.appendChild(summary);

    const details = document.createElement('div');
    details.className = 'plugin-card__field-list';

    if (Array.isArray(diagnostic.activationEvents) && diagnostic.activationEvents.length > 0) {
        details.appendChild(createDiagnosticRow(
            t('plugin_diag_activation_field'),
            diagnostic.activationEvents.join(', ')
        ));
    }

    if (diagnostic.lastActivationEvent) {
        details.appendChild(createDiagnosticRow(
            t('plugin_diag_last_event_field'),
            diagnostic.lastActivationEvent
        ));
    }

    if (diagnostic.lastActivatedAt) {
        details.appendChild(createDiagnosticRow(
            t('plugin_diag_last_activated_field'),
            formatTimestamp(diagnostic.lastActivatedAt)
        ));
    }

    if (Number.isFinite(Number(diagnostic.failures)) && Number(diagnostic.failures) > 0) {
        details.appendChild(createDiagnosticRow(
            t('plugin_diag_failures_field'),
            String(Number(diagnostic.failures))
        ));
    }

    const errorMessage = normalizeString(
        diagnostic?.lastError?.message || diagnostic?.error,
        diagnostic?.state === 'unavailable' ? t('plugin_diag_host_unavailable') : ''
    );
    if (errorMessage) {
        details.appendChild(createDiagnosticRow(
            t('plugin_diag_error_field'),
            errorMessage,
            { error: true }
        ));
    }

    if (details.childElementCount > 0) {
        block.appendChild(details);
    }

    return block;
}

function isUserCancelledError(error) {
    return error?.name === 'AbortError' || /cancel(l)?ed/i.test(String(error?.message || ''));
}

function createStatusBadges(item) {
    const fragment = document.createDocumentFragment();

    if (item.sourceType === 'builtin') {
        fragment.appendChild(createBadge(t('plugin_source_builtin')));
    } else if (item.sourceType === 'developer') {
        fragment.appendChild(createBadge(t('plugin_source_developer')));
    } else {
        fragment.appendChild(createBadge(t('plugin_source_registry')));
    }
    fragment.appendChild(createBadge(getKindLabel(item.kind)));
    fragment.appendChild(createBadge(getScopeLabel(item.scope)));
    if (item.requiresExtension) {
        fragment.appendChild(createBadge(t('plugin_requires_extension')));
    }

    if (Array.isArray(item.permissions)) {
        item.permissions.forEach((permission) => {
            fragment.appendChild(createBadge(getPermissionLabel(permission)));
        });
    }

    if (item.updateAvailable) {
        fragment.appendChild(createBadge(t('plugin_status_update_available'), 'highlight'));
    }
    if (!item.compatible) {
        fragment.appendChild(createBadge(t('plugin_status_incompatible'), 'warning'));
    }
    if (item.availabilityStatus === 'disabled') {
        fragment.appendChild(createBadge(t('plugin_status_disabled_remotely'), 'warning'));
    }
    if (item.devModeOnly) {
        fragment.appendChild(createBadge(t('plugin_action_dev_mode_only'), 'warning'));
    }

    return fragment;
}

function appendToggle(titleRow, item) {
    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'switch plugin-card__switch';

    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.checked = !!item.enabled;
    toggleInput.disabled = item.availabilityStatus === 'disabled' || !item.compatible || !item.runtimeSupported;
    toggleInput.dataset.pluginToggle = item.id;
    toggleInput.setAttribute('aria-label', t('plugin_toggle_enable_aria', [resolvePluginName(item)]));

    const slider = document.createElement('span');
    slider.className = 'slider';
    slider.setAttribute('aria-hidden', 'true');

    toggleLabel.appendChild(toggleInput);
    toggleLabel.appendChild(slider);
    titleRow.appendChild(toggleLabel);
}

function buildInstalledCard(item) {
    const card = document.createElement('article');
    card.className = 'plugin-card';
    card.dataset.pluginId = item.id;
    card.dataset.cardKind = 'installed';

    const header = document.createElement('div');
    header.className = 'plugin-card__header';

    const content = document.createElement('div');
    content.className = 'plugin-card__content';

    const titleRow = document.createElement('div');
    titleRow.className = 'plugin-card__title-row';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'plugin-card__title-wrap';

    const title = document.createElement('h3');
    title.className = 'plugin-card__title';
    title.textContent = resolvePluginName(item);

    const version = document.createElement('div');
    version.className = 'plugin-card__version';
    version.textContent = `${t('plugin_version_label')}: ${item.installedVersion || item.latestVersion || '-'}`;

    titleWrap.appendChild(title);
    titleWrap.appendChild(version);
    titleRow.appendChild(titleWrap);
    appendToggle(titleRow, item);

    const description = document.createElement('p');
    description.className = 'plugin-card__description';
    description.textContent = resolvePluginDescription(item);

    const meta = document.createElement('div');
    meta.className = 'plugin-card__meta';
    meta.appendChild(createStatusBadges(item));

    const pluginId = document.createElement('code');
    pluginId.className = 'plugin-card__id';
    pluginId.textContent = item.id;
    const runtimeDiagnostics = buildRuntimeDiagnosticsBlock(item);

    const footer = document.createElement('div');
    footer.className = 'plugin-card__footer';

    if (item.updateAvailable) {
        footer.appendChild(createActionButton({
            label: t('plugin_action_update'),
            action: 'update',
            disabled: item.availabilityStatus === 'disabled' || !item.compatible || !item.runtimeSupported,
        }));
    }

    if (item.canUninstall) {
        footer.appendChild(createActionButton({
            label: t('plugin_action_uninstall'),
            action: 'uninstall',
        }));
    }

    content.appendChild(titleRow);
    content.appendChild(description);
    content.appendChild(meta);
    if (runtimeDiagnostics) {
        content.appendChild(runtimeDiagnostics);
    }
    content.appendChild(pluginId);
    if (footer.childElementCount > 0) {
        content.appendChild(footer);
    }

    header.appendChild(content);
    card.appendChild(header);

    const footnoteText = resolveAvailabilityReason(item) || (!item.runtimeSupported && item.requiresExtension
        ? t('plugin_disabled_requires_extension')
        : '');

    if (footnoteText) {
        const footnote = document.createElement('p');
        footnote.className = 'plugin-card__footnote';
        footnote.textContent = footnoteText;
        card.appendChild(footnote);
    }

    return card;
}

function buildMarketplaceCard(item) {
    const card = document.createElement('article');
    card.className = 'plugin-card';
    card.dataset.pluginId = item.id;
    card.dataset.cardKind = 'marketplace';

    const header = document.createElement('div');
    header.className = 'plugin-card__header';

    const content = document.createElement('div');
    content.className = 'plugin-card__content';

    const titleRow = document.createElement('div');
    titleRow.className = 'plugin-card__title-row';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'plugin-card__title-wrap';

    const title = document.createElement('h3');
    title.className = 'plugin-card__title';
    title.textContent = resolvePluginName(item);

    const version = document.createElement('div');
    version.className = 'plugin-card__version';
    version.textContent = `${t('plugin_version_label')}: ${item.latestVersion || '-'}`;

    titleWrap.appendChild(title);
    titleWrap.appendChild(version);

    const actions = document.createElement('div');
    actions.className = 'plugin-card__market-actions';

    if (item.devModeOnly) {
        actions.appendChild(createActionButton({
            label: t('plugin_action_dev_mode_only'),
            action: 'noop',
            disabled: true,
        }));
    } else if (!item.runtimeSupported) {
        actions.appendChild(createActionButton({
            label: t('plugin_action_unavailable'),
            action: 'noop',
            disabled: true,
        }));
    } else if (!item.compatible) {
        actions.appendChild(createActionButton({
            label: t('plugin_action_unavailable'),
            action: 'noop',
            disabled: true,
        }));
    } else if (item.availabilityStatus === 'disabled') {
        actions.appendChild(createActionButton({
            label: t('plugin_action_unavailable'),
            action: 'noop',
            disabled: true,
        }));
    } else if (item.kind === 'builtin' && item.installed && !item.canUninstall) {
        actions.appendChild(createActionButton({
            label: t('plugin_action_builtin'),
            action: 'noop',
            disabled: true,
        }));
    } else if (item.updateAvailable) {
        actions.appendChild(createActionButton({
            label: t('plugin_action_update'),
            action: 'update',
        }));
    } else if (item.installed) {
        actions.appendChild(createActionButton({
            label: t('plugin_action_installed'),
            action: 'noop',
            disabled: true,
        }));
    } else {
        actions.appendChild(createActionButton({
            label: t('plugin_action_install'),
            action: 'install',
        }));
    }

    titleRow.appendChild(titleWrap);
    titleRow.appendChild(actions);

    const description = document.createElement('p');
    description.className = 'plugin-card__description';
    description.textContent = resolvePluginDescription(item);

    const meta = document.createElement('div');
    meta.className = 'plugin-card__meta';
    meta.appendChild(createStatusBadges(item));

    const pluginId = document.createElement('code');
    pluginId.className = 'plugin-card__id';
    pluginId.textContent = item.id;

    content.appendChild(titleRow);
    content.appendChild(description);
    content.appendChild(meta);
    content.appendChild(pluginId);

    header.appendChild(content);
    card.appendChild(header);

    const footnoteText = item.availabilityReason || (!item.runtimeSupported && item.requiresExtension
        ? t('plugin_disabled_requires_extension')
        : '');

    if (footnoteText) {
        const footnote = document.createElement('p');
        footnote.className = 'plugin-card__footnote';
        footnote.textContent = footnoteText;
        card.appendChild(footnote);
    }

    return card;
}

function buildDeveloperCard(item) {
    const card = document.createElement('article');
    card.className = 'plugin-card';
    card.dataset.pluginId = item.id;
    card.dataset.cardKind = 'developer';

    const header = document.createElement('div');
    header.className = 'plugin-card__header';

    const content = document.createElement('div');
    content.className = 'plugin-card__content';

    const titleRow = document.createElement('div');
    titleRow.className = 'plugin-card__title-row';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'plugin-card__title-wrap';

    const title = document.createElement('h3');
    title.className = 'plugin-card__title';
    title.textContent = resolvePluginName(item);

    const version = document.createElement('div');
    version.className = 'plugin-card__version';
    version.textContent = `${t('plugin_version_label')}: ${item.installedVersion || '-'}`;

    titleWrap.appendChild(title);
    titleWrap.appendChild(version);
    titleRow.appendChild(titleWrap);
    appendToggle(titleRow, item);

    const description = document.createElement('p');
    description.className = 'plugin-card__description';
    description.textContent = resolvePluginDescription(item);

    const meta = document.createElement('div');
    meta.className = 'plugin-card__meta';
    meta.appendChild(createStatusBadges(item));

    const sourceBlock = document.createElement('div');
    sourceBlock.className = 'plugin-card__field';

    const sourceLabel = document.createElement('span');
    sourceLabel.className = 'plugin-card__field-label';
    sourceLabel.textContent = t('plugin_dev_source_field');

    const sourceValue = document.createElement('code');
    sourceValue.className = 'plugin-card__source';
    sourceValue.textContent = item.sourceLabel || item.manifestUrl || '-';

    sourceBlock.appendChild(sourceLabel);
    sourceBlock.appendChild(sourceValue);

    const pluginId = document.createElement('code');
    pluginId.className = 'plugin-card__id';
    pluginId.textContent = item.id;
    const runtimeDiagnostics = buildRuntimeDiagnosticsBlock(item);

    const footer = document.createElement('div');
    footer.className = 'plugin-card__footer';
    footer.appendChild(createActionButton({
        label: t('plugin_dev_action_refresh'),
        action: 'refresh-local',
        disabled: !item.canRefresh,
    }));
    footer.appendChild(createActionButton({
        label: t('plugin_action_uninstall'),
        action: 'uninstall-local',
    }));

    content.appendChild(titleRow);
    content.appendChild(description);
    content.appendChild(meta);
    content.appendChild(sourceBlock);
    if (runtimeDiagnostics) {
        content.appendChild(runtimeDiagnostics);
    }
    content.appendChild(pluginId);
    content.appendChild(footer);

    header.appendChild(content);
    card.appendChild(header);

    const footnoteMessages = [];
    if (!item.manifestUrl && item.canRefresh) {
        footnoteMessages.push('Reload uses the cached bundle. Reinstall the folder after editing plugin files.');
    }
    if (!item.runtimeSupported && item.requiresExtension) {
        footnoteMessages.push(t('plugin_disabled_requires_extension'));
    }
    const footnoteText = footnoteMessages.join(' ');

    if (footnoteText) {
        const footnote = document.createElement('p');
        footnote.className = 'plugin-card__footnote';
        footnote.textContent = footnoteText;
        card.appendChild(footnote);
    }

    return card;
}

function confirmInstall(item) {
    const permissionLabels = (item.permissions || []).map(getPermissionLabel);
    const lines = [
        t('plugin_install_confirm_title', [resolvePluginName(item)]),
    ];

    if (permissionLabels.length > 0) {
        lines.push('');
        lines.push(t('plugin_install_confirm_permissions'));
        permissionLabels.forEach((label) => {
            lines.push(`- ${label}`);
        });
    }

    return window.confirm(lines.join('\n'));
}

export async function initPluginSettings({ page, loadRuntimeDiagnostics = null } = {}) {
    if (!page) {
        return {
            async refresh() {},
            destroy() {},
        };
    }

    const tabs = Array.from(page.querySelectorAll('[data-plugin-tab]'));
    const panels = Array.from(page.querySelectorAll('[data-plugin-panel]'));
    const installedList = page.querySelector('#installed-plugin-list');
    const installedEmpty = page.querySelector('#installed-plugin-empty');
    const marketplaceList = page.querySelector('#marketplace-plugin-list');
    const marketplaceEmpty = page.querySelector('#marketplace-plugin-empty');
    const developerList = page.querySelector('#developer-plugin-list');
    const developerEmpty = page.querySelector('#developer-plugin-empty');
    const developerDropzone = page.querySelector('#developer-plugin-dropzone');
    const developerFolderInput = page.querySelector('#developer-plugin-folder-input');
    const statusNode = page.querySelector('#plugin-settings-status');

    let activeTab = 'installed';
    let developerDragDepth = 0;
    let extensionContextInvalidated = false;
    let currentModel = {
        installedItems: [],
        marketplaceItems: [],
        developerItems: [],
        sources: [],
        runtimeDiagnostics: {
            hosts: {},
        },
    };

    const findInstalledItem = (pluginId) => currentModel.installedItems.find((item) => item.id === pluginId);
    const findMarketplaceItem = (pluginId) => currentModel.marketplaceItems.find((item) => item.id === pluginId);
    const findDeveloperItem = (pluginId) => currentModel.developerItems.find((item) => item.id === pluginId);

    const normalizeRuntimeHostInfo = (host, info = {}) => {
        const diagnostics = Array.isArray(info?.diagnostics)
            ? info.diagnostics
                .filter((entry) => entry && typeof entry === 'object')
                .map((entry) => ({
                    ...entry,
                    host,
                }))
            : [];

        return {
            host,
            available: info?.available !== false,
            error: normalizeString(info?.error),
            diagnostics,
            diagnosticsById: new Map(
                diagnostics
                    .filter((entry) => normalizeString(entry?.id))
                    .map((entry) => [normalizeString(entry.id), entry])
            ),
        };
    };

    const normalizeRuntimeDiagnostics = (payload = null) => {
        const hosts = payload?.hosts && typeof payload.hosts === 'object'
            ? payload.hosts
            : {};

        return {
            hosts: {
                shell: normalizeRuntimeHostInfo('shell', hosts.shell || {
                    available: true,
                    diagnostics: [],
                }),
                page: normalizeRuntimeHostInfo('page', hosts.page || {
                    available: false,
                    diagnostics: [],
                    error: normalizeString(payload?.pageError),
                }),
                background: normalizeRuntimeHostInfo('background', hosts.background || {
                    available: false,
                    diagnostics: [],
                    error: normalizeString(payload?.backgroundError),
                }),
            },
        };
    };

    const resolveRuntimeDiagnostic = (item, runtimeDiagnostics) => {
        const host = resolveRuntimeHostForScope(item?.scope);
        const hostInfo = runtimeDiagnostics?.hosts?.[host] || normalizeRuntimeHostInfo(host, {
            available: host === 'shell',
        });
        const matchedDiagnostic = hostInfo.diagnosticsById.get(item?.id);

        if (matchedDiagnostic) {
            return matchedDiagnostic;
        }

        if (!item?.enabled) {
            return {
                id: item?.id,
                host,
                state: 'disabled',
                active: false,
                activationEvents: [],
                failures: 0,
                lastActivationEvent: '',
                lastActivatedAt: 0,
                lastError: null,
            };
        }

        if (hostInfo.available === false || item?.runtimeSupported === false) {
            return {
                id: item?.id,
                host,
                state: 'unavailable',
                active: false,
                activationEvents: [],
                failures: 0,
                lastActivationEvent: '',
                lastActivatedAt: 0,
                lastError: null,
                error: normalizeString(hostInfo.error),
            };
        }

        return {
            id: item?.id,
            host,
            state: 'registered',
            active: false,
            activationEvents: [],
            failures: 0,
            lastActivationEvent: '',
            lastActivatedAt: 0,
            lastError: null,
        };
    };

    const attachRuntimeDiagnostics = (model, runtimeDiagnostics) => ({
        ...model,
        runtimeDiagnostics,
        installedItems: (model?.installedItems || []).map((item) => ({
            ...item,
            runtimeDiagnostic: resolveRuntimeDiagnostic(item, runtimeDiagnostics),
        })),
        developerItems: (model?.developerItems || []).map((item) => ({
            ...item,
            runtimeDiagnostic: resolveRuntimeDiagnostic(item, runtimeDiagnostics),
        })),
    });

    const setActiveTab = (tabId) => {
        activeTab = tabId;
        tabs.forEach((tab) => {
            const selected = tab.dataset.pluginTab === tabId;
            tab.classList.toggle('is-active', selected);
            tab.setAttribute('aria-selected', selected ? 'true' : 'false');
        });
        panels.forEach((panel) => {
            const visible = panel.dataset.pluginPanel === tabId;
            panel.classList.toggle('visible', visible);
            panel.hidden = !visible;
        });
    };

    const renderStatus = () => {
        if (!statusNode) return;
        const hasAnySuccessfulSource = currentModel.sources.some((source) => source.ok);
        if (!hasAnySuccessfulSource && currentModel.sources.length > 0) {
            statusNode.textContent = t('plugin_market_sync_failed');
            statusNode.dataset.state = 'error';
            return;
        }

        const latestSource = currentModel.sources
            .filter((source) => source.ok && source.generatedAt)
            .sort((left, right) => {
                const leftTime = Date.parse(left.generatedAt) || 0;
                const rightTime = Date.parse(right.generatedAt) || 0;
                return rightTime - leftTime;
            })[0];
        if (latestSource?.generatedAt) {
            statusNode.textContent = t('plugin_market_last_synced', [formatTimestamp(latestSource.generatedAt)]);
            statusNode.dataset.state = 'normal';
            return;
        }

        statusNode.textContent = '';
        statusNode.dataset.state = 'normal';
    };

    const hasDroppedFiles = (dataTransfer) => {
        const types = Array.from(dataTransfer?.types || []);
        if (types.includes('Files')) {
            return true;
        }
        if (Array.from(dataTransfer?.items || []).some((item) => item?.kind === 'file')) {
            return true;
        }
        return Number(dataTransfer?.files?.length || 0) > 0;
    };

    const setDeveloperDropActive = (active) => {
        developerDropzone?.classList.toggle('is-dragover', !!active);
    };

    const openDeveloperPicker = () => {
        developerFolderInput?.click?.();
    };

    const runDeveloperInstall = async (installer, { triggerButton = null } = {}) => {
        if (triggerButton) {
            triggerButton.disabled = true;
        }

        try {
            const pluginPackage = await installer();
            await refresh();
            setActiveTab('developer');

            showToast(
                t('plugin_dev_install_success', [resolvePluginName(pluginPackage)]),
                { type: 'success', durationMs: 1800 }
            );
        } catch (error) {
            if (!isUserCancelledError(error)) {
                console.error('[Cerebr] Failed to sideload local plugin', error);
                window.alert(error?.message || t('plugin_market_sync_failed'));
            }
        } finally {
            if (triggerButton) {
                triggerButton.disabled = false;
            }
            developerDragDepth = 0;
            setDeveloperDropActive(false);
        }
    };

    const renderInstalled = () => {
        installedList?.replaceChildren();
        const items = currentModel.installedItems || [];

        if (installedEmpty) {
            installedEmpty.hidden = items.length > 0;
        }
        if (!installedList) return;

        const fragment = document.createDocumentFragment();
        items.forEach((item) => {
            fragment.appendChild(buildInstalledCard(item));
        });
        installedList.appendChild(fragment);
    };

    const renderMarketplace = () => {
        marketplaceList?.replaceChildren();
        const items = currentModel.marketplaceItems || [];

        if (marketplaceEmpty) {
            marketplaceEmpty.hidden = items.length > 0;
        }
        if (!marketplaceList) return;

        const fragment = document.createDocumentFragment();
        items.forEach((item) => {
            fragment.appendChild(buildMarketplaceCard(item));
        });
        marketplaceList.appendChild(fragment);
    };

    const renderDeveloper = () => {
        developerList?.replaceChildren();
        const items = currentModel.developerItems || [];

        if (developerEmpty) {
            developerEmpty.hidden = items.length > 0;
        }
        if (!developerList) return;

        const fragment = document.createDocumentFragment();
        items.forEach((item) => {
            fragment.appendChild(buildDeveloperCard(item));
        });
        developerList.appendChild(fragment);
    };

    const render = () => {
        renderStatus();
        renderInstalled();
        renderMarketplace();
        renderDeveloper();
        setActiveTab(activeTab);
    };

    const refresh = async () => {
        if (extensionContextInvalidated) {
            return;
        }
        if (statusNode) {
            statusNode.textContent = t('plugin_market_loading');
            statusNode.dataset.state = 'loading';
        }
        try {
            const [marketplaceModel, developerModel, runtimeDiagnosticsPayload] = await Promise.all([
                getPluginMarketplaceModel(),
                getDeveloperPluginModel(),
                typeof loadRuntimeDiagnostics === 'function'
                    ? loadRuntimeDiagnostics().catch((error) => {
                        if (isExtensionContextInvalidatedError(error)) {
                            throw error;
                        }
                        console.warn('[Cerebr] Failed to load runtime diagnostics', error);
                        return {
                            hosts: {
                                shell: {
                                    available: true,
                                    diagnostics: [],
                                },
                                page: {
                                    available: false,
                                    diagnostics: [],
                                    error: error?.message || String(error),
                                },
                                background: {
                                    available: false,
                                    diagnostics: [],
                                    error: error?.message || String(error),
                                },
                            },
                        };
                    })
                    : Promise.resolve(null),
            ]);

            currentModel = attachRuntimeDiagnostics({
                ...marketplaceModel,
                developerItems: developerModel.items || [],
            }, normalizeRuntimeDiagnostics(runtimeDiagnosticsPayload));
            render();
        } catch (error) {
            if (isExtensionContextInvalidatedError(error)) {
                extensionContextInvalidated = true;
                if (statusNode) {
                    statusNode.textContent = t('plugin_market_sync_failed');
                    statusNode.dataset.state = 'error';
                }
                return;
            }
            console.error('[Cerebr] Failed to refresh plugin marketplace', error);
            if (statusNode) {
                statusNode.textContent = `${t('plugin_market_sync_failed')}: ${error?.message || String(error)}`;
                statusNode.dataset.state = 'error';
            }
        }
    };

    const handlePageClick = async (event) => {
        const devActionButton = event.target.closest?.('[data-plugin-dev-action]');
        if (devActionButton) {
            const devAction = devActionButton.dataset.pluginDevAction;
            if (devAction === 'pick-folder') {
                openDeveloperPicker();
                return;
            }
        }

        const actionButton = event.target.closest?.('[data-plugin-action]');
        if (!(actionButton instanceof HTMLButtonElement)) return;

        const pluginCard = actionButton.closest('.plugin-card');
        const pluginId = pluginCard?.dataset.pluginId;
        const action = actionButton.dataset.pluginAction;
        const installedItem = pluginId ? findInstalledItem(pluginId) : null;
        const marketplaceItem = pluginId ? findMarketplaceItem(pluginId) : null;
        const developerItem = pluginId ? findDeveloperItem(pluginId) : null;

        if (action === 'install') {
            if (!marketplaceItem) return;
            if (!confirmInstall(marketplaceItem)) return;
            actionButton.disabled = true;
            try {
                await installMarketplaceItem(marketplaceItem);
                await refresh();
                setActiveTab('installed');
            } catch (error) {
                console.error('[Cerebr] Failed to install plugin', error);
                window.alert(error?.message || t('plugin_market_sync_failed'));
            } finally {
                actionButton.disabled = false;
            }
            return;
        }

        if (action === 'update') {
            const item = marketplaceItem || installedItem;
            if (!item) return;
            actionButton.disabled = true;
            try {
                await updateMarketplaceItem(item);
                await refresh();
            } catch (error) {
                console.error('[Cerebr] Failed to update plugin', error);
                window.alert(error?.message || t('plugin_market_sync_failed'));
            } finally {
                actionButton.disabled = false;
            }
            return;
        }

        if (action === 'uninstall') {
            if (!installedItem) return;
            const confirmed = window.confirm(t('plugin_uninstall_confirm_title', [resolvePluginName(installedItem)]));
            if (!confirmed) return;
            actionButton.disabled = true;
            try {
                await uninstallMarketplaceItem(installedItem);
                await refresh();
            } catch (error) {
                console.error('[Cerebr] Failed to uninstall plugin', error);
                window.alert(error?.message || t('plugin_market_sync_failed'));
            } finally {
                actionButton.disabled = false;
            }
            return;
        }

        if (action === 'refresh-local') {
            if (!developerItem) return;
            actionButton.disabled = true;
            try {
                await refreshLocalScriptPlugin(pluginId);
                await refresh();
                showToast(
                    developerItem.manifestUrl
                        ? `Reloaded local plugin: ${resolvePluginName(developerItem)}`
                        : 'Reloaded cached local bundle. Reinstall the folder to apply file changes.',
                    {
                        type: developerItem.manifestUrl ? 'success' : 'warning',
                        durationMs: 2600,
                    }
                );
            } catch (error) {
                console.error('[Cerebr] Failed to refresh local plugin', error);
                window.alert(error?.message || t('plugin_market_sync_failed'));
            } finally {
                actionButton.disabled = false;
            }
            return;
        }

        if (action === 'uninstall-local') {
            if (!developerItem) return;
            const confirmed = window.confirm(t('plugin_uninstall_confirm_title', [resolvePluginName(developerItem)]));
            if (!confirmed) return;
            actionButton.disabled = true;
            try {
                await uninstallLocalScriptPlugin(pluginId);
                await refresh();
            } catch (error) {
                console.error('[Cerebr] Failed to uninstall local plugin', error);
                window.alert(error?.message || t('plugin_market_sync_failed'));
            } finally {
                actionButton.disabled = false;
            }
        }
    };

    const handlePageChange = async (event) => {
        const toggle = event.target;
        if (!(toggle instanceof HTMLInputElement) || toggle.type !== 'checkbox' || !toggle.dataset.pluginToggle) {
            return;
        }

        const item = findInstalledItem(toggle.dataset.pluginToggle) || findDeveloperItem(toggle.dataset.pluginToggle);
        if (!item) return;

        toggle.disabled = true;
        try {
            await toggleInstalledPlugin(item, toggle.checked);
            await refresh();
        } catch (error) {
            console.error('[Cerebr] Failed to toggle plugin', error);
            toggle.checked = !toggle.checked;
            window.alert(error?.message || t('plugin_market_sync_failed'));
        } finally {
            toggle.disabled = false;
        }
    };

    const handleTabClick = (event) => {
        const tab = event.target.closest?.('[data-plugin-tab]');
        if (!(tab instanceof HTMLButtonElement)) return;
        setActiveTab(tab.dataset.pluginTab || 'installed');
    };

    const handleDeveloperDragEnter = (event) => {
        if (!hasDroppedFiles(event.dataTransfer)) return;
        event.preventDefault();
        developerDragDepth += 1;
        setDeveloperDropActive(true);
    };

    const handleDeveloperDragOver = (event) => {
        if (!hasDroppedFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDeveloperDropActive(true);
    };

    const handleDeveloperDragLeave = (event) => {
        if (!hasDroppedFiles(event.dataTransfer)) return;
        event.preventDefault();
        developerDragDepth = Math.max(0, developerDragDepth - 1);
        if (developerDragDepth === 0) {
            setDeveloperDropActive(false);
        }
    };

    const handleDeveloperDrop = async (event) => {
        if (!hasDroppedFiles(event.dataTransfer)) return;
        event.preventDefault();
        await runDeveloperInstall(
            () => installLocalScriptPluginFromDataTransfer(event.dataTransfer),
            { resetInput: false }
        );
    };

    const handleDeveloperPickerChange = async (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || input.type !== 'file') {
            return;
        }

        const files = Array.from(input.files || []);
        input.value = '';
        if (files.length === 0) {
            return;
        }

        await runDeveloperInstall(
            () => installLocalScriptPluginFromFileList(files),
            { resetInput: false }
        );
    };

    const handleDeveloperDropzoneClick = (event) => {
        if (!developerDropzone?.contains(event.target)) return;
        if (event.target.closest?.('button, input, a, label')) return;
        openDeveloperPicker();
    };

    const handleDeveloperDropzoneKeydown = (event) => {
        if (!developerDropzone || event.target !== developerDropzone) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openDeveloperPicker();
    };

    page.addEventListener('click', handlePageClick);
    page.addEventListener('change', handlePageChange);
    page.addEventListener('click', handleTabClick);
    developerDropzone?.addEventListener('click', handleDeveloperDropzoneClick);
    developerDropzone?.addEventListener('keydown', handleDeveloperDropzoneKeydown);
    developerDropzone?.addEventListener('dragenter', handleDeveloperDragEnter);
    developerDropzone?.addEventListener('dragover', handleDeveloperDragOver);
    developerDropzone?.addEventListener('dragleave', handleDeveloperDragLeave);
    developerDropzone?.addEventListener('drop', handleDeveloperDrop);
    developerFolderInput?.addEventListener('change', handleDeveloperPickerChange);

    const unsubscribe = subscribePluginState(() => {
        void refresh();
    });

    await refresh();

    return {
        async refresh() {
            await refresh();
        },
        selectTab(tabId) {
            if (!tabId) return;
            setActiveTab(tabId);
        },
        destroy() {
            page.removeEventListener('click', handlePageClick);
            page.removeEventListener('change', handlePageChange);
            page.removeEventListener('click', handleTabClick);
            developerDropzone?.removeEventListener('click', handleDeveloperDropzoneClick);
            developerDropzone?.removeEventListener('keydown', handleDeveloperDropzoneKeydown);
            developerDropzone?.removeEventListener('dragenter', handleDeveloperDragEnter);
            developerDropzone?.removeEventListener('dragover', handleDeveloperDragOver);
            developerDropzone?.removeEventListener('dragleave', handleDeveloperDragLeave);
            developerDropzone?.removeEventListener('drop', handleDeveloperDrop);
            developerFolderInput?.removeEventListener('change', handleDeveloperPickerChange);
            unsubscribe?.();
        },
    };
}
