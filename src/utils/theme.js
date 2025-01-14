/**
 * 设置主题的工具函数
 * @param {boolean} isDark - 是否为深色主题
 * @param {Object} config - 配置对象
 * @param {HTMLElement} config.root - 根元素（通常是document.documentElement）
 * @param {HTMLInputElement} config.themeSwitch - 主题切换开关元素
 * @param {Function} config.saveTheme - 保存主题的回调函数
 */
export function setTheme(isDark, { root, themeSwitch, saveTheme }) {
    // 移除现有的主题类
    root.classList.remove('dark-theme', 'light-theme');

    // 添加新的主题类
    root.classList.add(isDark ? 'dark-theme' : 'light-theme');

    // 更新开关状态
    if (themeSwitch) {
        themeSwitch.checked = isDark;
    }

    // 保存主题设置
    if (saveTheme) {
        saveTheme(isDark ? 'dark' : 'light');
    }
}