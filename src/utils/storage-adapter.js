// 检测是否在Chrome扩展环境中
export const isExtensionEnvironment = typeof chrome !== 'undefined' && chrome.runtime;

// 存储适配器
export const storageAdapter = {
    // 获取存储的数据
    async get(key) {
        if (isExtensionEnvironment) {
            return await chrome.storage.local.get(key);
        } else {
            const value = localStorage.getItem(key);
            return value ? { [key]: JSON.parse(value) } : {};
        }
    },

    // 设置存储的数据
    async set(data) {
        if (isExtensionEnvironment) {
            await chrome.storage.local.set(data);
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
            return await chrome.storage.sync.get(key);
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
            await chrome.storage.sync.set(data);
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
            const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
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
            return await chrome.runtime.sendMessage(message);
        } else {
            console.warn('Message passing is not supported in web environment:', message);
            return null;
        }
    },

    // 添加标签页变化监听器
    onTabActivated(callback) {
        if (isExtensionEnvironment) {
            chrome.tabs.onActivated.addListener(callback);
        } else {
            // Web环境下不需要监听标签页变化
            console.info('Tab activation listening is not supported in web environment');
        }
    }
};

// 新增：记录存储空间占用的函数
function logStorageUsage() {
    if (isExtensionEnvironment) {
        // 确保 chrome.storage.local API 可用
        if (chrome && chrome.storage && chrome.storage.local && typeof chrome.storage.local.getBytesInUse === 'function') {
            chrome.storage.local.getBytesInUse(null).then((bytesInUse) => {
                console.log("[Cerebr] 插件占用的本地存储空间: " + (bytesInUse / (1024 * 1024)).toFixed(2) + " MB");
            }).catch(error => {
                console.error("[Cerebr] 获取插件本地存储空间失败:", error);
            });
        } else {
            console.warn("[Cerebr] chrome.storage.local.getBytesInUse API 在插件环境中不可用或未正确初始化。");
        }
    } else {
        // 在网页环境中，计算 localStorage 的占用空间 (近似值)
        try {
            let totalLocalStorageBytes = 0;
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key === null) continue;
                const value = localStorage.getItem(key);
                if (value === null) continue;
                totalLocalStorageBytes += (key.length + value.length) * 2; // 估算UTF-16字节
            }
            console.log("[Cerebr] 网页占用的 localStorage 空间 (近似UTF-16): " + (totalLocalStorageBytes / (1024 * 1024)).toFixed(2) + " MB");
        } catch (e) {
            console.error("[Cerebr] 计算 localStorage 占用空间失败:", e);
        }
    }
}

// 在模块加载时执行日志记录
logStorageUsage();