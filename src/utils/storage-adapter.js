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
            try {
                const response = await browser.runtime.sendMessage({
                    type: "getCurrentTab"
                });
                if (response && response.tab) {
                    return response.tab;
                } else {
                    console.error('无法从后台脚本获取标签页信息:', response);
                    return null;
                }
            } catch (error) {
                console.error('获取当前标签页信息失败:', error);
                return null;
            }
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
            // 在后台脚本中监听标签页变化，并通过消息传递通知
            browser.runtime.onMessage.addListener((message) => {
                if (message.type === "tabActivated") {
                    callback();
                }
            });
        } else {
            // Web环境下不需要监听标签页变化
            console.info('Tab activation listening is not supported in web environment');
        }
    }
};