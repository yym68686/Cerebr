import { normalizeNumber, normalizeString } from './runtime-utils.js';
import { resolvePluginLocalizedText } from './plugin-i18n.js';

const SUPPORTED_PROMPT_FRAGMENT_PLACEMENTS = new Set([
    'system.prepend',
    'system.append',
]);

function getHostMessage(key, substitutions = [], fallback = '') {
    try {
        return chrome?.i18n?.getMessage?.(key, substitutions) || fallback;
    } catch {
        return fallback;
    }
}

export function normalizePromptFragment(fragment, pluginId, pluginManifest = null) {
    if (typeof fragment === 'string') {
        const content = normalizeString(fragment);
        if (!content) return null;

        return {
            pluginId: normalizeString(pluginId),
            id: `${normalizeString(pluginId, 'plugin')}:fragment:${content.slice(0, 32)}`,
            placement: 'system.append',
            priority: 0,
            content,
        };
    }

    if (!fragment || typeof fragment !== 'object') {
        return null;
    }

    const content = normalizeString(fragment.content);
    const contentKey = normalizeString(fragment.contentKey);
    if (!content && !contentKey) {
        return null;
    }

    const placement = normalizeString(fragment.placement, 'system.append');
    const normalizedPlacement = SUPPORTED_PROMPT_FRAGMENT_PLACEMENTS.has(placement)
        ? placement
        : 'system.append';
    const normalizedPluginId = normalizeString(fragment.pluginId, pluginId);
    const idSource = content || contentKey;
    const fragmentId = normalizeString(
        fragment.id,
        `${normalizedPluginId || 'plugin'}:fragment:${idSource.slice(0, 32)}`
    );

    return {
        pluginId: normalizedPluginId,
        id: fragmentId,
        placement: normalizedPlacement,
        priority: normalizeNumber(fragment.priority, 0),
        content,
        contentKey,
        i18n: fragment?.i18n && typeof fragment.i18n === 'object'
            ? { ...fragment.i18n }
            : (
                pluginManifest?.i18n && typeof pluginManifest.i18n === 'object'
                    ? { ...pluginManifest.i18n }
                    : null
            ),
    };
}

export function materializePromptFragment(fragment, {
    locale = '',
    hostGetMessage = getHostMessage,
} = {}) {
    if (!fragment || typeof fragment !== 'object') {
        return null;
    }

    const content = resolvePluginLocalizedText({
        i18n: fragment?.i18n || null,
        locale,
        key: fragment.contentKey,
        fallback: fragment.content,
        hostGetMessage,
    });
    if (!content) {
        return null;
    }

    return {
        ...fragment,
        content,
    };
}

export function sortPromptFragments(fragments = []) {
    return [...fragments]
        .filter(Boolean)
        .sort((left, right) => {
            const priorityDelta = normalizeNumber(right?.priority, 0) - normalizeNumber(left?.priority, 0);
            if (priorityDelta !== 0) {
                return priorityDelta;
            }

            const leftPluginId = normalizeString(left?.pluginId);
            const rightPluginId = normalizeString(right?.pluginId);
            const pluginDelta = leftPluginId.localeCompare(rightPluginId);
            if (pluginDelta !== 0) {
                return pluginDelta;
            }

            return normalizeString(left?.id).localeCompare(normalizeString(right?.id));
        });
}
