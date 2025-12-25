// 检测是否在Chrome扩展环境中
export const isExtensionEnvironment = !!(typeof chrome !== 'undefined' && chrome.runtime);

const IDB_DB_NAME = 'CerebrData';
const IDB_DB_VERSION = 1;
const IDB_STORE_NAME = 'keyValueStore';

let dbPromise = null;

const CHATS_INDEX_V2_KEY = 'cerebr_chats_index_v2';
const CHAT_V2_PREFIX = 'cerebr_chat_v2_';
const READING_PROGRESS_V1_PREFIX = 'cerebr_reading_progress_v1_';

function isChatStorageKey(key) {
    return key === CHATS_INDEX_V2_KEY ||
        (typeof key === 'string' && (key.startsWith(CHAT_V2_PREFIX) || key.startsWith(READING_PROGRESS_V1_PREFIX)));
}

function getDb() {
    if (!dbPromise) {
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

async function idbGetOne(key) {
    const db = await getDb();
    if (!db) return undefined;
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([IDB_STORE_NAME], 'readonly');
        const store = transaction.objectStore(IDB_STORE_NAME);
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = (event) => {
            console.error(`IndexedDB get error for key ${key}:`, event.target.error);
            reject(event.target.error);
        };
    });
}

async function idbGetMany(keys) {
    const db = await getDb();
    if (!db) return Object.fromEntries(keys.map(k => [k, undefined]));
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([IDB_STORE_NAME], 'readonly');
        const store = transaction.objectStore(IDB_STORE_NAME);
        const result = {};
        let completed = 0;

        keys.forEach((key) => {
            const request = store.get(key);
            request.onsuccess = () => {
                result[key] = request.result;
                completed++;
                if (completed === keys.length) resolve(result);
            };
            request.onerror = (event) => {
                console.error(`IndexedDB get error for key ${key}:`, event.target.error);
                transaction.abort();
                reject(event.target.error);
            };
        });

        transaction.onerror = (event) => {
            console.error('IndexedDB get transaction error:', event.target.error);
            reject(event.target.error);
        };
        transaction.onabort = (event) => {
            console.error('IndexedDB get transaction aborted:', event.target.error);
            reject(new Error('Transaction aborted, possibly due to an earlier error.'));
        };
    });
}

async function idbSetMany(data) {
    const db = await getDb();
    if (!db) throw new Error("IndexedDB not available");
    const entries = Object.entries(data);
    if (entries.length === 0) return;
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([IDB_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(IDB_STORE_NAME);
        entries.forEach(([key, value]) => {
            const request = store.put(value, key);
            request.onerror = (event) => {
                console.error(`IndexedDB set error for key ${key}:`, event.target.error);
                transaction.abort();
                reject(event.target.error);
            };
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = (event) => {
            console.error('IndexedDB set transaction error:', event.target.error);
            reject(event.target.error);
        };
        transaction.onabort = (event) => {
            console.error('IndexedDB set transaction aborted:', event.target.error);
            reject(new Error('Transaction aborted, possibly due to an earlier error.'));
        };
    });
}

async function idbRemoveMany(keys) {
    const db = await getDb();
    if (!db) throw new Error("IndexedDB not available");
    const keysArray = Array.isArray(keys) ? keys : [keys];
    if (keysArray.length === 0) return;
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
}

// 存储适配器
export const storageAdapter = {
    // 获取存储的数据
    async get(key) {
        try {
            if (Array.isArray(key)) {
                if (key.length === 0) return {};
                if (isExtensionEnvironment) {
                    const idbKeys = key.filter(isChatStorageKey);
                    const chromeKeys = key.filter(k => !isChatStorageKey(k));
                    let [idbResult, chromeResult] = await Promise.all([
                        idbKeys.length > 0 ? idbGetMany(idbKeys) : Promise.resolve({}),
                        chromeKeys.length > 0 ? chrome.storage.local.get(chromeKeys) : Promise.resolve({})
                    ]);

                    // 兼容迁移：chat keys 优先从 IDB 读，缺失则回退到 chrome.storage.local，再写回 IDB
                    if (idbKeys.length > 0) {
                        const missingIdbKeys = idbKeys.filter(k => typeof idbResult[k] === 'undefined');
                        if (missingIdbKeys.length > 0) {
                            const chromeFallback = await chrome.storage.local.get(missingIdbKeys);
                            const fallbackEntries = Object.entries(chromeFallback).filter(([, v]) => typeof v !== 'undefined');
                            if (fallbackEntries.length > 0) {
                                const fallbackPayload = Object.fromEntries(fallbackEntries);
                                await idbSetMany(fallbackPayload);
                                await chrome.storage.local.remove(Object.keys(fallbackPayload));
                                idbResult = { ...idbResult, ...fallbackPayload };
                            }
                        }
                    }

                    return { ...chromeResult, ...idbResult };
                }
                return await idbGetMany(key);
            }

            if (isExtensionEnvironment) {
                if (isChatStorageKey(key)) {
                    let value = await idbGetOne(key);
                    if (typeof value === 'undefined') {
                        const chromeFallback = await chrome.storage.local.get(key);
                        value = chromeFallback[key];
                        if (typeof value !== 'undefined') {
                            await idbSetMany({ [key]: value });
                            await chrome.storage.local.remove(key);
                        }
                    }
                    return { [key]: value };
                }
                return await chrome.storage.local.get(key);
            }

            return { [key]: await idbGetOne(key) };
        } catch (error) {
            console.error('Failed to get data from storage for key ' + key + ':', error);
            if (Array.isArray(key)) {
                return Object.fromEntries(key.map(k => [k, undefined]));
            }
            return { [key]: undefined };
        }
    },

    // 删除存储的数据
    async remove(keys) {
        if (Array.isArray(keys) && keys.length === 0) return;
        const keysArray = Array.isArray(keys) ? keys : [keys];
        const idbKeys = keysArray.filter(isChatStorageKey);

        if (isExtensionEnvironment) {
            await Promise.all([
                idbKeys.length > 0 ? idbRemoveMany(idbKeys) : Promise.resolve(),
                chrome.storage.local.remove(keysArray)
            ]);
            return;
        }

        await idbRemoveMany(keysArray);
    },

    // 设置存储的数据
    async set(data) {
        const entries = Object.entries(data);
        if (entries.length === 0) return;

        const idbPayload = {};
        const chromePayload = {};
        entries.forEach(([k, v]) => {
            if (isExtensionEnvironment && !isChatStorageKey(k)) {
                chromePayload[k] = v;
            } else {
                idbPayload[k] = v;
            }
        });

        if (isExtensionEnvironment) {
            await Promise.all([
                Object.keys(idbPayload).length > 0 ? idbSetMany(idbPayload) : Promise.resolve(),
                Object.keys(chromePayload).length > 0 ? chrome.storage.local.set(chromePayload) : Promise.resolve()
            ]);
            // 迁移清理：确保 chat keys 不再残留在 chrome.storage.local
            if (Object.keys(idbPayload).length > 0) {
                await chrome.storage.local.remove(Object.keys(idbPayload));
            }
            return;
        }

        await idbSetMany(idbPayload);
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
                    windowId: tab.windowId,
                    url: 'file://',
                    title: 'Local PDF',
                    hostname: 'local_pdf'
                };
            }

            const url = new URL(tab.url);
            return {
                id: tab.id,
                windowId: tab.windowId,
                url: tab.url,
                title: tab.title,
                hostname: url.hostname
            };
        } else {
            const url = window.location.href;
            // 处理本地文件
            if (url.startsWith('file://')) {
                return {
                    id: 'current',
                    url: 'file://',
                    title: 'Local PDF',
                    hostname: 'local_pdf'
                };
            }
            return {
                id: 'current',
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

    getTabGroupsByIds: (groupIds) => {
        if (!isExtensionEnvironment) return Promise.resolve({});
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: 'GET_TAB_GROUPS_BY_IDS', groupIds }, (response) => {
                if (chrome.runtime.lastError) {
                    return reject(chrome.runtime.lastError);
                }
                resolve(response || {});
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
