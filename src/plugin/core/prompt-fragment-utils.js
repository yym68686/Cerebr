import { normalizeNumber, normalizeString } from './runtime-utils.js';

const SUPPORTED_PROMPT_FRAGMENT_PLACEMENTS = new Set([
    'system.prepend',
    'system.append',
]);

export function normalizePromptFragment(fragment, pluginId) {
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
    if (!content) {
        return null;
    }

    const placement = normalizeString(fragment.placement, 'system.append');
    const normalizedPlacement = SUPPORTED_PROMPT_FRAGMENT_PLACEMENTS.has(placement)
        ? placement
        : 'system.append';
    const normalizedPluginId = normalizeString(fragment.pluginId, pluginId);
    const fragmentId = normalizeString(
        fragment.id,
        `${normalizedPluginId || 'plugin'}:fragment:${content.slice(0, 32)}`
    );

    return {
        pluginId: normalizedPluginId,
        id: fragmentId,
        placement: normalizedPlacement,
        priority: normalizeNumber(fragment.priority, 0),
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
