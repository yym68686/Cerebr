// 检测是否在Chrome扩展环境中
export const isExtensionEnvironment = !!(typeof chrome !== 'undefined' && chrome.runtime);

const IDB_DB_NAME = 'CerebrData';
const IDB_DB_VERSION = 1;
const IDB_STORE_NAME = 'keyValueStore';

let dbPromise = null;

function getDb() {
    if (!isExtensionEnvironment && !dbPromise) { //仅在非插件环境且dbPromise未初始化时创建
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(IDB_DB_NAME, IDB_DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
                    db.createObjectStore(IDB_STORE_NAME);
                }
            };

            request.onsuccess = (event) => {
                resolve(event.target.result);
            };

            request.onerror = (event) => {
                console.error('IndexedDB database error:', event.target.error);
                reject(event.target.error);
            };
        });
    }
    return dbPromise;
}

// 存储适配器
export const storageAdapter = {
    // 获取存储的数据
    async get(key) {
        if (isExtensionEnvironment) {
            return await chrome.storage.local.get(key);
        } else {
            try {
                const db = await getDb();
                if (!db) return { [key]: undefined }; // 如果数据库打开失败

                return new Promise((resolve, reject) => {
                    const transaction = db.transaction([IDB_STORE_NAME], 'readonly');
                    const store = transaction.objectStore(IDB_STORE_NAME);
                    const request = store.get(key);

                    request.onsuccess = () => {
                        resolve({ [key]: request.result });
                    };
                    request.onerror = (event) => {
                        console.error(`IndexedDB get error for key ${key}:`, event.target.error);
                        reject(event.target.error);
                    };
                });
            } catch (error) {
                console.error('Failed to get data from IndexedDB for key ' + key + ':', error);
                return { [key]: undefined };
            }
        }
    },

    // 删除存储的数据
    async remove(keys) {
        if (isExtensionEnvironment) {
            await chrome.storage.local.remove(keys);
        } else {
            try {
                const db = await getDb();
                if (!db) throw new Error("IndexedDB not available");

                const keysArray = Array.isArray(keys) ? keys : [keys];
                if (keysArray.length === 0) return Promise.resolve();

                return new Promise((resolve, reject) => {
                    const transaction = db.transaction([IDB_STORE_NAME], 'readwrite');
                    const store = transaction.objectStore(IDB_STORE_NAME);

                    keysArray.forEach((key) => {
                        const request = store.delete(key);
                        request.onerror = (event) => {
                            console.error(`IndexedDB remove error for key ${key}:`, event.target.error);
                            transaction.abort();
                            reject(event.target.error);
                        };
                    });

                    transaction.oncomplete = () => resolve();
                    transaction.onerror = (event) => {
                        console.error('IndexedDB remove transaction error:', event.target.error);
                        reject(event.target.error);
                    };
                    transaction.onabort = (event) => {
                        console.error('IndexedDB remove transaction aborted:', event.target.error);
                        reject(new Error('Transaction aborted, possibly due to an earlier error.'));
                    };
                });
            } catch (error) {
                console.error('Failed to remove data in IndexedDB:', error);
                throw error;
            }
        }
    },

    // 设置存储的数据
    async set(data) {
        if (isExtensionEnvironment) {
            await chrome.storage.local.set(data);
        } else {
            try {
                const db = await getDb();
                if (!db) throw new Error("IndexedDB not available");

                // 假设 data 是一个对象，我们需要迭代它来存储每个键值对
                // 或者，如果 ChatManager 总是用一个固定的主键（如 'cerebr_chats'）来保存所有聊天，
                // 那么这里的逻辑可以简化。
                // 当前 ChatManager 的 saveChats 是 this.storage.set({ [CHATS_KEY]: Array.from(this.chats.values()) });
                // 所以 data 是 { 'cerebr_chats': [...] }

                const entries = Object.entries(data);
                if (entries.length === 0) return Promise.resolve();

                return new Promise((resolve, reject) => {
                    const transaction = db.transaction([IDB_STORE_NAME], 'readwrite');
                    const store = transaction.objectStore(IDB_STORE_NAME);
                    let completedOperations = 0;

                    entries.forEach(([key, value]) => {
                        const request = store.put(value, key);
                        request.onsuccess = () => {
                            completedOperations++;
                            if (completedOperations === entries.length) {
                                // resolve(); // 事务完成后再 resolve
                            }
                        };
                        request.onerror = (event) => {
                            // 如果任何一个 put 失败，我们应该中止事务并 reject
                            console.error(`IndexedDB set error for key ${key}:`, event.target.error);
                            transaction.abort(); // 中止事务
                            reject(event.target.error);
                        };
                    });

                    transaction.oncomplete = () => {
                        resolve();
                    };
                    transaction.onerror = (event) => {
                        console.error('IndexedDB set transaction error:', event.target.error);
                        reject(event.target.error);
                    };
                     transaction.onabort = (event) => {
                        console.error('IndexedDB set transaction aborted:', event.target.error);
                        reject(new Error('Transaction aborted, possibly due to an earlier error.'));
                    };
                });

            } catch (error) {
                console.error('Failed to set data in IndexedDB:', error);
                // 根据应用的需要决定如何处理这个错误，例如向上抛出
                throw error;
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
            // 对于 sync，localStorage 可能是个更简单的回退，因为它本身容量就小
            // 或者您也可以为 sync 实现单独的 IndexedDB 存储（例如不同的 object store）
            // 这里暂时保持 localStorage 作为示例，但请注意其容量限制
            console.warn("Sync storage in web environment is using localStorage fallback, which has size limitations.");
            if (Array.isArray(key)) {
                const result = {};
                for (const k of key) {
                    const value = localStorage.getItem(`sync_${k}`);
                    if (value) {
                        try {
                            result[k] = JSON.parse(value);
                        } catch (e) {
                             console.error(`Error parsing sync_ ${k} from localStorage`, e);
                        }
                    }
                }
                return result;
            } else {
                const value = localStorage.getItem(`sync_${key}`);
                if (value) {
                    try {
                        return { [key]: JSON.parse(value) };
                    } catch (e) {
                        console.error(`Error parsing sync_ ${key} from localStorage`, e);
                    }
                }
                return {};
            }
        }
    },

    // 删除存储的数据
    async remove(keys) {
        if (isExtensionEnvironment) {
            await chrome.storage.sync.remove(keys);
        } else {
            console.warn("Sync storage in web environment is using localStorage fallback, which has size limitations.");
            const keysArray = Array.isArray(keys) ? keys : [keys];
            for (const key of keysArray) {
                localStorage.removeItem(`sync_${key}`);
            }
        }
    },

    // 设置存储的数据
    async set(data) {
        if (isExtensionEnvironment) {
            await chrome.storage.sync.set(data);
        } else {
            console.warn("Sync storage in web environment is using localStorage fallback, which has size limitations.");
            for (const [key, value] of Object.entries(data)) {
                try {
                    localStorage.setItem(`sync_${key}`, JSON.stringify(value));
                } catch (e) {
                    console.error(`Error setting sync_ ${key} to localStorage`, e);
                    // 如果 localStorage 也满了，这里可能会抛出 QuotaExceededError
                    throw e;
                }
            }
        }
    }
};

// 浏览器API适配器
export const browserAdapter = {
    // 获取当前标签页信息
    async getCurrentTab() {
        if (isExtensionEnvironment) {
            const tab = await chrome.runtime.sendMessage({ type: "GET_CURRENT_TAB" });
            if (!tab?.url) return null;

            // 处理本地文件
            if (tab.url.startsWith('file://')) {
                return {
                    id: tab.id,
                    url: 'file://',
                    title: 'Local PDF',
                    hostname: 'local_pdf'
                };
            }

            const url = new URL(tab.url);
            return {
                id: tab.id,
                url: tab.url,
                title: tab.title,
                hostname: url.hostname
            };
        } else {
            const url = window.location.href;
            // 处理本地文件
            if (url.startsWith('file://')) {
                return {
                    id: tab.id,
                    url: 'file://',
                    title: 'Local PDF',
                    hostname: 'local_pdf'
                };
            }
            return {
                id: tab.id,
                url: url,
                title: document.title,
                hostname: window.location.hostname
            };
        }
    },

    // 发送消息
    async sendMessage(message) {
        if (isExtensionEnvironment) {
           return new Promise((resolve, reject) => {
               chrome.runtime.sendMessage(message, (response) => {
                   if (chrome.runtime.lastError) {
                       return reject(chrome.runtime.lastError);
                   }
                   resolve(response);
               });
           });
        } else {
            console.warn('Message passing is not supported in web environment:', message);
            return Promise.resolve(null);
        }
    },

    getAllTabs: () => {
        if (!isExtensionEnvironment) {
            return Promise.resolve([{
                id: 'current',
                title: document.title,
                url: window.location.href,
            }]);
        }
        // Must be sent to background script to access tabs API
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: 'GET_ALL_TABS' }, (response) => {
                if (chrome.runtime.lastError) {
                    return reject(chrome.runtime.lastError);
                }
                resolve(response);
            });
        });
    },

    executeScriptInTab: (tabId, func, args = []) => {
        return new Promise((resolve, reject) => {
            if (!isExtensionEnvironment) {
                return reject(new Error('Not in an extension environment.'));
            }
            chrome.scripting.executeScript(
                {
                    target: { tabId: tabId },
                    func: func,
                    args: args,
                    world: 'MAIN'
                },
                (injectionResults) => {
                    if (chrome.runtime.lastError) {
                        return reject(chrome.runtime.lastError);
                    }
                    if (injectionResults && injectionResults.length > 0) {
                        resolve(injectionResults[0].result);
                    } else {
                        resolve(null);
                    }
                }
            );
        });
    },

    // 添加标签页变化监听器
    onTabActivated(callback) {
        if (isExtensionEnvironment) {
            // In a non-background script, we can't directly access chrome.tabs.
            // We listen for messages from the background script instead.
            // chrome.tabs.onActivated.addListener(callback);

            // 兼容 Firefox 需要
            chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
                if (message.type === 'TAB_ACTIVATED') {
                    callback(message.payload);
                }
            });
        }
    },

    isTabConnected: (tabId) => {
        if (!isExtensionEnvironment) return Promise.resolve(false);

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.log(`Tab ${tabId} timed out.`);
                resolve(false);
            }, 100); // 200毫秒超时

            chrome.runtime.sendMessage({ type: 'IS_TAB_CONNECTED', tabId }, (response) => {
                clearTimeout(timeout);
                if (chrome.runtime.lastError) {
                    // 比如tab不存在或无法访问
                    // console.warn(`Error checking tab ${tabId}:`, chrome.runtime.lastError.message);
                    return resolve(false);
                }
                resolve(response);
            });
        });
    },

    reloadTab: (tabId) => {
        if (!isExtensionEnvironment) return Promise.resolve(false);
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: 'RELOAD_TAB', tabId }, (response) => {
                if (chrome.runtime.lastError || response?.status === 'error') {
                    console.error(`Failed to reload tab ${tabId}:`, chrome.runtime.lastError || response?.error);
                    return resolve(false);
                }
                resolve(true);
            });
        });
    }
};

// 记录存储空间占用的函数
function logStorageUsage() {
    if (isExtensionEnvironment && typeof chrome.storage.local.getBytesInUse === 'function') {
        chrome.storage.local.getBytesInUse(null).then((bytesInUse) => {
            console.log(`[Cerebr] 插件(Chrome)本地存储精确占用: ${(bytesInUse / (1024 * 1024)).toFixed(2)} MB`);
        }).catch(error => {
            console.warn("[Cerebr] 获取插件本地存储空间失败:", error);
        });
    }
    // 在 Firefox 等其他插件环境中，使用手动计算作为回退，兼容 Firefox 需要
    else if (isExtensionEnvironment) {
        chrome.storage.local.get(null, (items) => {
            if (chrome.runtime.lastError) {
                console.error("[Cerebr] 手动计算存储失败 (获取数据出错):", chrome.runtime.lastError);
                return;
            }
            try {
                const jsonString = JSON.stringify(items);
                // 使用 Blob 来获取 UTF-8 编码的字节大小，这比简单地计算字符串长度更准确
                const bytes = new Blob([jsonString]).size;
                console.log(`[Cerebr] 插件(Firefox/其他)本地存储估算占用: ${(bytes / (1024 * 1024)).toFixed(2)} MB`);
            } catch (e) {
                console.error("[Cerebr] 手动计算存储失败 (JSON序列化出错):", e);
            }
        });
    } else {
        // 网页环境 - IndexedDB
        if (navigator.storage && navigator.storage.estimate) {
            navigator.storage.estimate().then(estimate => {
                console.log(`[Cerebr] 网页预估存储使用 (IndexedDB等): ${(estimate.usage / (1024 * 1024)).toFixed(2)} MB / 配额: ${(estimate.quota / (1024 * 1024)).toFixed(2)} MB`);
            }).catch(error => {
                console.warn("[Cerebr] 无法通过 navigator.storage.estimate() 获取网页存储信息:", error);
                console.log("[Cerebr] 网页环境使用 IndexedDB。具体大小请通过浏览器开发者工具查看。");
            });
        } else {
            console.log("[Cerebr] 网页环境使用 IndexedDB。具体大小请通过浏览器开发者工具查看。");
        }
    }
}

// 在模块加载时执行日志记录
logStorageUsage();
