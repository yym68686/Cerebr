import { syncChatBottomExtraPadding } from '../../utils/scroll.js';
import {
    normalizeThemePreference,
    resolveThemeIsDark,
} from '../../utils/theme.js';

let layoutSyncRaf = 0;

export function getShellThemeSnapshot(root = document.documentElement) {
    const themePreference = normalizeThemePreference(root?.dataset?.themePreference);

    return {
        themePreference,
        isDark: resolveThemeIsDark(themePreference),
        classes: root?.classList ? Array.from(root.classList) : [],
    };
}

export function observeShellTheme(callback, { root = document.documentElement, immediate = true } = {}) {
    if (typeof callback !== 'function') {
        return () => {};
    }

    const emit = () => {
        callback(getShellThemeSnapshot(root));
    };

    if (immediate) {
        emit();
    }

    const observer = typeof MutationObserver === 'function'
        ? new MutationObserver(() => emit())
        : null;
    observer?.observe(root, {
        attributes: true,
        attributeFilter: ['class', 'data-theme-preference'],
    });

    const darkQuery = typeof window?.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
    const handleColorSchemeChange = () => {
        if (normalizeThemePreference(root?.dataset?.themePreference) === 'system') {
            emit();
        }
    };

    if (darkQuery?.addEventListener) {
        darkQuery.addEventListener('change', handleColorSchemeChange);
    } else if (darkQuery?.addListener) {
        darkQuery.addListener(handleColorSchemeChange);
    }

    return () => {
        observer?.disconnect?.();

        if (darkQuery?.removeEventListener) {
            darkQuery.removeEventListener('change', handleColorSchemeChange);
        } else if (darkQuery?.removeListener) {
            darkQuery.removeListener(handleColorSchemeChange);
        }
    };
}

export function requestShellLayoutSync() {
    if (layoutSyncRaf) {
        return true;
    }

    layoutSyncRaf = window.requestAnimationFrame(() => {
        layoutSyncRaf = 0;
        syncChatBottomExtraPadding();
    });

    return true;
}
