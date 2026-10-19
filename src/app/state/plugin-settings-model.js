import { getActiveLocale, t } from '../../utils/i18n.js';
import { resolvePluginLocalizedText } from '../../plugin/core/plugin-i18n.js';
export function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

export function resolveHostLocalizedText(key, fallback = '') {
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

export function resolveLocalizedText(item, key, fallback = '') {
    const normalizedKey = String(key || '').trim();
    const normalizedFallback = String(fallback || '').trim();

    if (!normalizedKey) {
        return normalizedFallback;
    }

    const pluginI18n =
        item?.manifest?.i18n && typeof item.manifest.i18n === 'object'
            ? item.manifest.i18n
            : item?.i18n && typeof item.i18n === 'object'
              ? item.i18n
              : null;
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

export function resolvePluginName(item) {
    return resolveLocalizedText(item, item?.nameKey, item?.displayName || item?.id);
}

export function resolvePluginDescription(item) {
    return resolveLocalizedText(item, item?.descriptionKey, item?.description);
}

export function resolveAvailabilityReason(item) {
    return resolveHostLocalizedText(item?.availabilityReasonKey, item?.availabilityReason);
}

export function getPermissionLabel(permission) {
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

export function getScopeLabel(scope) {
    if (scope === 'page') return t('plugin_scope_page');
    if (scope === 'shell') return t('plugin_scope_shell');
    if (scope === 'prompt') return t('plugin_scope_prompt');
    if (scope === 'background') return t('plugin_scope_background');
    return scope;
}

export function getKindLabel(kind) {
    if (kind === 'builtin') return t('plugin_kind_builtin');
    if (kind === 'declarative') return t('plugin_kind_declarative');
    if (kind === 'script') return t('plugin_kind_script');
    return kind;
}

export function resolveRuntimeHostForScope(scope) {
    if (scope === 'page') return 'page';
    if (scope === 'background') return 'background';
    return 'shell';
}

export function getDiagnosticStateLabel(state) {
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

export function getDiagnosticStateBadgeModifier(state) {
    if (state === 'active') return 'highlight';
    if (state === 'activating') return 'warning';
    if (state === 'error') return 'danger';
    if (state === 'unavailable') return 'warning';
    if (state === 'disabled') return 'muted';
    return '';
}

export function formatTimestamp(timestamp) {
    if (!timestamp) return '';

    try {
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) return timestamp;
        return date.toLocaleString();
    } catch {
        return timestamp;
    }
}

export function resolvePluginHomepageInfo(item) {
    const rawValue = normalizeString(item?.homepage || item?.manifest?.homepage || item?.record?.homepage);
    if (!rawValue) {
        return null;
    }

    try {
        const url = new URL(rawValue);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
            return {
                href: url.toString(),
                label: rawValue,
            };
        }
    } catch {
        // fall through to raw display
    }

    return {
        href: '',
        label: rawValue,
    };
}

export function confirmInstall(item) {
    const permissionLabels = (item.permissions || []).map(getPermissionLabel);
    const lines = [t('plugin_install_confirm_title', [resolvePluginName(item)])];

    if (permissionLabels.length > 0) {
        lines.push('');
        lines.push(t('plugin_install_confirm_permissions'));
        permissionLabels.forEach((label) => {
            lines.push(`- ${label}`);
        });
    }

    return window.confirm(lines.join('\n'));
}
