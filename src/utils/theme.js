/**
 * 设置主题的工具函数
 * @param {string} themeMode - 主题模式：'light', 'dark', 'auto'
 * @param {Object} config - 配置对象
 * @param {HTMLElement} config.root - 根元素（通常是document.documentElement）
 * @param {HTMLSelectElement} config.themeSelect - 主题选择器元素
 * @param {Function} config.saveTheme - 保存主题的回调函数
 */
export function setTheme(themeMode, { root, themeSelect, saveTheme }) {
    // 移除现有的主题类
    root.classList.remove('dark-theme', 'light-theme');

    let isDark = false;
    
    if (themeMode === 'auto') {
        // 跟随系统主题
        isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } else {
        // 手动设置的主题
        isDark = themeMode === 'dark';
    }

    // 添加新的主题类
    root.classList.add(isDark ? 'dark-theme' : 'light-theme');

    // 更新选择器状态
    if (themeSelect) {
        themeSelect.value = themeMode;
    }

    // 保存主题设置
    if (saveTheme) {
        saveTheme(themeMode);
    }

    // 更新 Mermaid 主题并重新渲染
    if (window.mermaid) {
        window.mermaid.initialize({
            theme: isDark ? 'dark' : 'default'
        });

        // 重新渲染所有图表
        if (window.renderMermaidDiagrams) {
            window.renderMermaidDiagrams();
        }
    }

    // // 更新浏览器 UI 颜色
    // updateThemeColor(isDark);
}

// 更新主题颜色
function updateThemeColor(isDark) {
    const themeColorMeta = document.getElementById('theme-color-meta');
    if (themeColorMeta) {
        if (isDark) {
            // 深色模式：移除 meta 标签的 content 属性，使用浏览器默认颜色
            themeColorMeta.removeAttribute('content');
        } else {
            // 浅色模式：设置自定义颜色
            themeColorMeta.content = '#ffffff';
        }
    }
}