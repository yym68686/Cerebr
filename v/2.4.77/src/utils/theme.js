export const THEME_SYSTEM = 'system';
export const THEME_LIGHT = 'light';
export const THEME_DARK = 'dark';
export const THEME_STORAGE_KEY = 'theme';

const THEME_VALUES = new Set([THEME_SYSTEM, THEME_LIGHT, THEME_DARK]);

export function normalizeThemePreference(value) {
    return THEME_VALUES.has(value) ? value : THEME_SYSTEM;
}

export function isSystemDarkMode() {
    return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveThemeIsDark(themePreference) {
    const normalized = normalizeThemePreference(themePreference);
    if (normalized === THEME_DARK) return true;
    if (normalized === THEME_LIGHT) return false;
    return isSystemDarkMode();
}

/**
 * 应用主题偏好，不负责持久化。
 * @param {string} themePreference - system/light/dark
 * @param {Object} config - 配置对象
 * @param {HTMLElement} config.root - 根元素（通常是 document.documentElement）
 * @param {HTMLSelectElement} [config.themeSelect] - 主题选择器
 * @returns {{ themePreference: string, isDark: boolean }}
 */
export function applyThemePreference(themePreference, { root, themeSelect } = {}) {
    const targetRoot = root || document.documentElement;
    const normalized = normalizeThemePreference(themePreference);
    const isDark = resolveThemeIsDark(normalized);

    if (targetRoot) {
        targetRoot.classList.remove('dark-theme', 'light-theme');
        if (normalized === THEME_DARK) {
            targetRoot.classList.add('dark-theme');
        } else if (normalized === THEME_LIGHT) {
            targetRoot.classList.add('light-theme');
        }
        targetRoot.dataset.themePreference = normalized;
    }

    if (themeSelect) {
        themeSelect.value = normalized;
    }

    if (window.mermaid) {
        if (typeof window.initializeCerebrMermaid === 'function') {
            window.initializeCerebrMermaid(isDark);
        } else {
            window.mermaid.initialize({
                theme: isDark ? 'dark' : 'default'
            });
        }

        if (window.renderMermaidDiagrams) {
            window.renderMermaidDiagrams();
        }
    }

    updateThemeColor(isDark);

    return { themePreference: normalized, isDark };
}

function updateThemeColor(isDark) {
    const themeColorMeta = document.getElementById('theme-color-meta');
    if (themeColorMeta) {
        themeColorMeta.content = isDark ? '#262B33' : '#f5f1ea';
    }
}
