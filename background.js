// 确保 Service Worker 立即激活
self.addEventListener('install', (event) => {
  console.log('Service Worker 安装中...', new Date().toISOString());
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  console.log('Service Worker 已激活', new Date().toISOString());
  event.waitUntil(self.clients.claim());
});

// 添加启动日志
console.log('Background script loaded at:', new Date().toISOString());

function checkCustomShortcut(callback) {
  chrome.commands.getAll((commands) => {
      const toggleCommand = commands.find(command => command.name === '_execute_action' || command.name === '_execute_browser_action');
      if (toggleCommand && toggleCommand.shortcut) {
          console.log('当前设置的快捷键:', toggleCommand.shortcut);
          // 直接获取最后一个字符并转换为小写
          const lastLetter = toggleCommand.shortcut.charAt(toggleCommand.shortcut.length - 1).toLowerCase();
          callback(lastLetter);
      }
  });
}

// 处理标签页连接和消息发送的通用函数
async function handleTabCommand(commandType) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      console.log('没有找到活动标签页');
      return;
    }

    // 检查标签页是否已连接
    const isConnected = await isTabConnected(tab.id);
    if (!isConnected) {
      console.log('标签页未连接，等待重试...');
      // 等待一段时间后重试
      await new Promise(resolve => setTimeout(resolve, 500));
      const retryConnection = await isTabConnected(tab.id);
      if (!retryConnection) {
        console.log('重试失败，标签页仍未连接');
        return;
      }
    }

    await chrome.tabs.sendMessage(tab.id, { type: commandType });
  } catch (error) {
    console.error(`处理${commandType}命令失败:`, error);
  }
}

// 简化后的命令监听器
chrome.commands.onCommand.addListener(async (command) => {
  console.log('onCommand:', command);

  if (command === 'toggle_sidebar') {
    await handleTabCommand('TOGGLE_SIDEBAR_toggle_sidebar');
  } else if (command === 'clear_chat') {
    await handleTabCommand('CLEAR_CHAT');
  } else if (command === 'quick_summary') {
    await handleTabCommand('QUICK_SUMMARY');
  }
});

// 监听扩展图标点击
chrome.action.onClicked.addListener(async (tab) => {
  console.log('扩展图标被点击');
  try {
    // 检查标签页是否已连接
    const isConnected = await isTabConnected(tab.id);
    if (!isConnected) {
      console.log('标签页未连接，等待重试...');
      // 等待一段时间后重试
      await new Promise(resolve => setTimeout(resolve, 500));
      const retryConnection = await isTabConnected(tab.id);
      if (!retryConnection) {
        console.log('重试失败，标签页仍未连接');
        return;
      }
    }

    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR_onClicked' });
  } catch (error) {
    console.error('处理切换失败:', error);
  }
});

// 创建一个持久连接
let port = null;
chrome.runtime.onConnect.addListener((p) => {
  console.log('建立持久连接');
  port = p;
  port.onDisconnect.addListener(() => {
    console.log('连接断开，尝试重新连接');
    port = null;
  });
});

// 监听来自 content script 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('收到消息:', message, '来自:', sender.tab?.id);

  if (message.type === 'CONTENT_LOADED') {
    console.log('内容脚本已加载:', message.url);
    sendResponse({ status: 'ok', timestamp: new Date().toISOString() });
    return false;
  }

  // 处理来自 sidebar 的网页内容请求
  if (message.type === 'GET_PAGE_CONTENT_FROM_SIDEBAR') {
    (async () => {
      let retryCount = 0;
      const maxRetries = 3;
      const retryDelay = 1000; // 1秒延迟

      async function tryGetContent() {
        try {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!activeTab) {
            return null;
          }

          if (sender.tab && sender.tab.id !== activeTab.id) {
            return null;
          }

          if (!sender.url || !sender.url.includes('sidebar.html')) {
            return null;
          }

          if (await isTabConnected(activeTab.id)) {
            return await chrome.tabs.sendMessage(activeTab.id, {
              type: 'GET_PAGE_CONTENT_INTERNAL'
            });
          }
          return null;
        } catch (error) {
          console.error(`获取页面内容失败 (尝试 ${retryCount + 1}/${maxRetries}):`, error);
          return null;
        }
      }

      async function getContentWithRetry() {
        while (retryCount < maxRetries) {
          const content = await tryGetContent();
          if (content) {
            return content;
          }
          retryCount++;
          if (retryCount < maxRetries) {
            console.log(`等待 ${retryDelay}ms 后进行第 ${retryCount + 1} 次重试...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
          }
        }
        return null;
      }

      const content = await getContentWithRetry();
      sendResponse(content);
    })();
    return true;
  }

  // 处理PDF下载请求
  if (message.action === 'downloadPDF') {
    (async () => {
      try {
        const response = await downloadPDF(message.url);
        sendResponse(response);
      } catch (error) {
        sendResponse({success: false, error: error.message});
      }
    })();
    return true;
  }

  // 处理获取PDF块的请求
  if (message.action === 'getPDFChunk') {
    (async () => {
      try {
        const response = await getPDFChunk(message.url, message.chunkIndex);
        sendResponse(response);
      } catch (error) {
        sendResponse({success: false, error: error.message});
      }
    })();
    return true;
  }

  return false;
});

// 监听存储变化
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.webpageSwitchDomains) {
        const { newValue = {}, oldValue = {} } = changes.webpageSwitchDomains;
        const domains = { ...oldValue, ...newValue };
        chrome.storage.local.set({ webpageSwitchDomains: domains });
    }
});

// 简化Service Worker活跃保持
const HEARTBEAT_INTERVAL = 20000;
const keepAliveInterval = setInterval(() => {
    console.log('Service Worker 心跳:', new Date().toISOString());
}, HEARTBEAT_INTERVAL);

self.addEventListener('beforeunload', () => clearInterval(keepAliveInterval));

// 简化初始化检查
chrome.runtime.onInstalled.addListener(() => {
    console.log('扩展已安装/更新:', new Date().toISOString());
});

// 简化标签页连接检查
async function isTabConnected(tabId) {
    try {
        await chrome.tabs.sendMessage(tabId, { type: 'PING' });
        return true;
    } catch {
        return false;
    }
}

// 简化消息发送
async function sendMessageToTab(tabId, message) {
    if (await isTabConnected(tabId)) {
        return chrome.tabs.sendMessage(tabId, message);
    }
    return null;
}

// 简化请求跟踪
const tabRequests = new Map();

function initTabRequests(tabId) {
    if (!tabRequests.has(tabId)) {
        tabRequests.set(tabId, {
            pending: new Set(),
            isInitialRequestsCompleted: false
        });
    }
}

// 简化请求监听器
chrome.webRequest.onBeforeRequest.addListener(
    ({ tabId, requestId }) => {
        if (tabId !== -1) {
            initTabRequests(tabId);
            const tabData = tabRequests.get(tabId);
            tabData.pending.add(requestId);
            // 使用非异步方式发送消息
            chrome.tabs.sendMessage(tabId, {
                type: 'REQUEST_STARTED',
                requestId,
                pendingCount: tabData.pending.size
            }).catch(() => {});
        }
    },
    { urls: ["<all_urls>"] }
);

chrome.webRequest.onCompleted.addListener(
    ({ tabId, requestId }) => {
        if (tabId !== -1 && tabRequests.has(tabId)) {
            const tabData = tabRequests.get(tabId);
            tabData.pending.delete(requestId);

            if (tabData.pending.size === 0) {
                tabData.isInitialRequestsCompleted = true;
            }

            // 使用非异步方式发送消息
            chrome.tabs.sendMessage(tabId, {
                type: 'REQUEST_COMPLETED',
                requestId,
                pendingCount: tabData.pending.size,
                isInitialRequestsCompleted: tabData.isInitialRequestsCompleted
            }).catch(() => {});
        }
    },
    { urls: ["<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener(
    ({ tabId, requestId }) => {
        if (tabId !== -1 && tabRequests.has(tabId)) {
            const tabData = tabRequests.get(tabId);
            tabData.pending.delete(requestId);

            // 使用非异步方式发送消息
            chrome.tabs.sendMessage(tabId, {
                type: 'REQUEST_FAILED',
                requestId,
                pendingCount: tabData.pending.size
            }).catch(() => {});
        }
    },
    { urls: ["<all_urls>"] }
);

chrome.tabs.onRemoved.addListener(tabId => tabRequests.delete(tabId));

// 添加公共的PDF文件获取函数
async function getPDFArrayBuffer(url) {
    if (url.startsWith('file://')) {
        // 处理本地文件
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('无法读取本地PDF文件');
        }
        return response.arrayBuffer();
    } else {
        // 处理在线文件
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('PDF文件下载失败');
        }
        return response.arrayBuffer();
    }
}

// 修改 downloadPDF 函数
async function downloadPDF(url) {
    try {
        console.log('开始下载PDF文件:', url);
        const arrayBuffer = await getPDFArrayBuffer(url);
        console.log('PDF文件下载完成，大小:', arrayBuffer.byteLength, 'bytes');

        // 将ArrayBuffer转换为Uint8Array
        const uint8Array = new Uint8Array(arrayBuffer);

        // 分块大小设为4MB
        const chunkSize = 4 * 1024 * 1024;
        const chunks = Math.ceil(uint8Array.length / chunkSize);

        // 发送第一个消息，包含总块数和文件大小信息
        return {
            success: true,
            type: 'init',
            totalChunks: chunks,
            totalSize: uint8Array.length
        };
    } catch (error) {
        console.error('PDF下载失败:', error);
        console.error('错误堆栈:', error.stack);
        throw new Error('PDF下载失败: ' + error.message);
    }
}

// 修改 getPDFChunk 函数
async function getPDFChunk(url, chunkIndex) {
    try {
        const arrayBuffer = await getPDFArrayBuffer(url);
        const uint8Array = new Uint8Array(arrayBuffer);
        const chunkSize = 4 * 1024 * 1024;
        const start = chunkIndex * chunkSize;
        const end = Math.min(start + chunkSize, uint8Array.length);

        return {
            success: true,
            type: 'chunk',
            chunkIndex: chunkIndex,
            data: Array.from(uint8Array.slice(start, end))
        };
    } catch (error) {
        console.error('获取PDF块数据失败:', error);
        return {
            success: false,
            error: error.message
        };
    }
}