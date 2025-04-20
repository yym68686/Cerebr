// 检测是否在浏览器扩展环境中
export const isExtensionEnvironment = typeof browser !== 'undefined' && browser.runtime;

// 存储适配器
export const storageAdapter = {
    // 获取存储的数据
    async get(key) {
        if (isExtensionEnvironment) {
            return await browser.storage.local.get(key);
        } else {
            const value = localStorage.getItem(key);
            return value ? { [key]: JSON.parse(value) } : {};
        }
    },

    // 设置存储的数据
    async set(data) {
        if (isExtensionEnvironment) {
            await browser.storage.local.set(data);
        } else {
            for (const [key, value] of Object.entries(data)) {
                localStorage.setItem(key, JSON.stringify(value));
            }
        }
    }
};

// 同步存储适配器
export const syncStorageAdapter = {
    // 获取存储的数据
    async get(key) {
        if (isExtensionEnvironment) {
            return await browser.storage.sync.get(key);
        } else {
            // 处理数组形式的 key
            if (Array.isArray(key)) {
                const result = {};
                for (const k of key) {
                    const value = localStorage.getItem(`sync_${k}`);
                    if (value) {
                        result[k] = JSON.parse(value);
                    }
                }
                return result;
            } else {
                // 处理单个 key
                const value = localStorage.getItem(`sync_${key}`);
                return value ? { [key]: JSON.parse(value) } : {};
            }
        }
    },

    // 设置存储的数据
    async set(data) {
        if (isExtensionEnvironment) {
            await browser.storage.sync.set(data);
        } else {
            for (const [key, value] of Object.entries(data)) {
                localStorage.setItem(`sync_${key}`, JSON.stringify(value));
            }
        }
    }
};

// 浏览器API适配器
export const browserAdapter = {
    // 获取当前标签页信息
    async getCurrentTab() {
        if (isExtensionEnvironment) {
            const [tab] = await browser.tabs.query({active: true, currentWindow: true});
            if (!tab?.url) return null;

            // 处理本地文件
            if (tab.url.startsWith('file://')) {
                return {
                    url: 'file://',
                    title: 'Local PDF',
                    hostname: 'local_pdf'
                };
            }

            const url = new URL(tab.url);
            return {
                url: tab.url,
                title: tab.title,
                hostname: url.hostname
            };
        } else {
            const url = window.location.href;
            // 处理本地文件
            if (url.startsWith('file://')) {
                return {
                    url: 'file://',
                    title: 'Local PDF',
                    hostname: 'local_pdf'
                };
            }
            return {
                url: url,
                title: document.title,
                hostname: window.location.hostname
            };
        }
    },

    // 发送消息
    async sendMessage(message) {
        if (isExtensionEnvironment) {
            return await browser.runtime.sendMessage(message);
        } else {
            console.warn('Message passing is not supported in web environment:', message);
            return null;
        }
    },

    // 添加标签页变化监听器
    onTabActivated(callback) {
        if (isExtensionEnvironment) {
            browser.tabs.onActivated.addListener(callback);
        } else {
            // Web环境下不需要监听标签页变化
            console.info('Tab activation listening is not supported in web environment');
        }
    }
};