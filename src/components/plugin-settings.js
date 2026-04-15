import { t } from '../utils/i18n.js';
import {
    getPluginMarketplaceModel,
    installMarketplaceItem,
    toggleInstalledPlugin,
    uninstallMarketplaceItem,
    updateMarketplaceItem,
} from '../plugin/market/plugin-market-service.js';
import {
    getDeveloperPluginModel,
    installLocalScriptPluginFromSource,
    refreshLocalScriptPlugin,
    uninstallLocalScriptPlugin,
} from '../plugin/dev/local-plugin-service.js';
import { subscribePluginState } from '../plugin/shared/plugin-store.js';

function resolvePluginName(item) {
    if (item?.nameKey) return t(item.nameKey);
    return String(item?.displayName || item?.id || '').trim();
}

function resolvePluginDescription(item) {
    if (item?.descriptionKey) return t(item.descriptionKey);
    return String(item?.description || '').trim();
}

function getPermissionLabel(permission) {
    const mapping = {
        'prompt:extend': 'plugin_permission_prompt_extend',
        'page:selection': 'plugin_permission_page_selection',
        'shell:input': 'plugin_permission_shell_input',
        'page:read': 'plugin_permission_page_read',
        'page:write': 'plugin_permission_page_write',
        'chat:read': 'plugin_permission_chat_read',
        'chat:write': 'plugin_permission_chat_write',
    };

    const key = mapping[permission];
    return key ? t(key) : permission;
}

function getScopeLabel(scope) {
    if (scope === 'page') return t('plugin_scope_page');
    if (scope === 'shell') return t('plugin_scope_shell');
    if (scope === 'prompt') return t('plugin_scope_prompt');
    return scope;
}

function getKindLabel(kind) {
    if (kind === 'builtin') return t('plugin_kind_builtin');
    if (kind === 'declarative') return t('plugin_kind_declarative');
    if (kind === 'script') return t('plugin_kind_script');
    return kind;
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
    content.appendChild(pluginId);
    if (footer.childElementCount > 0) {
        content.appendChild(footer);
    }

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
    } else if (item.kind === 'builtin' && item.installed) {
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

    const footer = document.createElement('div');
    footer.className = 'plugin-card__footer';
    footer.appendChild(createActionButton({
        label: t('plugin_dev_action_refresh'),
        action: 'refresh-local',
        disabled: !item.manifestUrl,
    }));
    footer.appendChild(createActionButton({
        label: t('plugin_action_uninstall'),
        action: 'uninstall-local',
    }));

    content.appendChild(titleRow);
    content.appendChild(description);
    content.appendChild(meta);
    content.appendChild(sourceBlock);
    content.appendChild(pluginId);
    content.appendChild(footer);

    header.appendChild(content);
    card.appendChild(header);

    const footnoteText = !item.runtimeSupported && item.requiresExtension
        ? t('plugin_disabled_requires_extension')
        : '';

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

export async function initPluginSettings({ page } = {}) {
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
    const developerSourceInput = page.querySelector('#developer-plugin-source');
    const developerSamplePath = page.querySelector('#developer-plugin-sample-path');
    const statusNode = page.querySelector('#plugin-settings-status');

    let activeTab = 'installed';
    let currentModel = {
        installedItems: [],
        marketplaceItems: [],
        developerItems: [],
        sampleManifestPath: '',
        sources: [],
    };

    const findInstalledItem = (pluginId) => currentModel.installedItems.find((item) => item.id === pluginId);
    const findMarketplaceItem = (pluginId) => currentModel.marketplaceItems.find((item) => item.id === pluginId);
    const findDeveloperItem = (pluginId) => currentModel.developerItems.find((item) => item.id === pluginId);

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
        const failedSource = currentModel.sources.find((source) => !source.ok);
        if (failedSource) {
            statusNode.textContent = t('plugin_market_sync_failed');
            statusNode.dataset.state = 'error';
            return;
        }

        const latestSource = currentModel.sources.find((source) => source.ok && source.generatedAt);
        if (latestSource?.generatedAt) {
            statusNode.textContent = t('plugin_market_last_synced', [formatTimestamp(latestSource.generatedAt)]);
            statusNode.dataset.state = 'normal';
            return;
        }

        statusNode.textContent = '';
        statusNode.dataset.state = 'normal';
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
        if (developerSamplePath && currentModel.sampleManifestPath) {
            developerSamplePath.textContent = currentModel.sampleManifestPath;
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
        if (statusNode) {
            statusNode.textContent = t('plugin_market_loading');
            statusNode.dataset.state = 'loading';
        }
        try {
            const [marketplaceModel, developerModel] = await Promise.all([
                getPluginMarketplaceModel(),
                getDeveloperPluginModel(),
            ]);

            currentModel = {
                ...marketplaceModel,
                developerItems: developerModel.items || [],
                sampleManifestPath: developerModel.sampleManifestPath || '',
            };
            render();
        } catch (error) {
            console.error('[Cerebr] Failed to refresh plugin marketplace', error);
            if (statusNode) {
                statusNode.textContent = `${t('plugin_market_sync_failed')}: ${error?.message || String(error)}`;
                statusNode.dataset.state = 'error';
            }
        }
    };

    const handlePageClick = async (event) => {
        const devActionButton = event.target.closest?.('[data-plugin-dev-action]');
        if (devActionButton instanceof HTMLButtonElement) {
            const devAction = devActionButton.dataset.pluginDevAction;
            if (devAction === 'install') {
                const source = String(developerSourceInput?.value || '').trim();
                if (!source) {
                    window.alert(t('plugin_dev_source_required'));
                    developerSourceInput?.focus?.();
                    return;
                }

                devActionButton.disabled = true;
                try {
                    await installLocalScriptPluginFromSource(source);
                    await refresh();
                    setActiveTab('developer');
                } catch (error) {
                    console.error('[Cerebr] Failed to sideload local plugin', error);
                    window.alert(error?.message || t('plugin_market_sync_failed'));
                } finally {
                    devActionButton.disabled = false;
                }
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

    page.addEventListener('click', handlePageClick);
    page.addEventListener('change', handlePageChange);
    page.addEventListener('click', handleTabClick);

    const unsubscribe = subscribePluginState(() => {
        void refresh();
    });

    await refresh();

    return {
        async refresh() {
            await refresh();
        },
        destroy() {
            page.removeEventListener('click', handlePageClick);
            page.removeEventListener('change', handlePageChange);
            page.removeEventListener('click', handleTabClick);
            unsubscribe?.();
        },
    };
}
