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

chrome.commands.onCommand.addListener(async (command) => {
  console.log('onCommand:', command);
  if (command === 'toggle_sidebar') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR_toggle_sidebar' });
  }
});

// 监听扩展图标点击
chrome.action.onClicked.addListener(async (tab) => {
  console.log('扩展图标被点击');
  try {
      // console.log('尝试切换侧边栏');
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR_onClicked' });
      // console.log('已发送切换侧边栏命令');
  } catch (error) {
      console.error('处理切换失败:', error);
      console.error('错误堆栈:', error.stack);
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
    try {
      console.log('内容脚本已加载:', message.url);
      sendResponse({ status: 'ok', timestamp: new Date().toISOString() });
    } catch (error) {
      console.error('处理 CONTENT_LOADED 消息失败:', error);
      sendResponse({ status: 'error', error: error.message });
    }
    return true;
  }

  // 处理来自 sidebar 的网页内容请求
  if (message.type === 'GET_PAGE_CONTENT_FROM_SIDEBAR') {
    (async () => {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab) {
          console.log('未找到活动标签页');
          sendResponse(null);
          return;
        }

        // 检查请求是否来自当前活动标签页
        if (sender.tab && sender.tab.id !== activeTab.id) {
          console.log('请求来自非活动标签页，忽略请求');
          sendResponse(null);
          return;
        }

        // 检查发送者是否是 sidebar
        if (!sender.url || !sender.url.includes('sidebar.html')) {
          console.log('请求不是来自sidebar，忽略请求');
          sendResponse(null);
          return;
        }

        // 检查标签页是否已连接
        if (await isTabConnected(activeTab.id)) {
          console.log('向活动标签页发送内容请求:', activeTab.id);
          const response = await chrome.tabs.sendMessage(activeTab.id, {
            type: 'GET_PAGE_CONTENT_INTERNAL'
          });
          console.log('收到活动标签页响应，发送回 sidebar');
          sendResponse(response);
        } else {
          console.log('标签页未连接，无法获取内容');
          sendResponse(null);
        }
      } catch (error) {
        console.error('获取页面内容失败:', error);
        sendResponse(null);
      }
    })();
    return true;
  }

  // 处理PDF下载请求
  if (message.action === 'downloadPDF') {
    console.log('收到PDF下载请求');
    downloadPDF(message.url)
      .then(data => {
        console.log('PDF下载成功，准备发送响应');
        // 将 ArrayBuffer 转换为 Uint8Array
        const uint8Array = new Uint8Array(data);
        // 将 Uint8Array 转换为普通数组
        const array = Array.from(uint8Array);
        sendResponse({success: true, data: array});
      })
      .catch(error => {
        console.error('PDF下载失败:', error);
        sendResponse({success: false, error: error.message});
      });
    return true;
  }
});

// 监听存储变化
chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName === 'local' && changes.webpageSwitchDomains) {
    const newValue = changes.webpageSwitchDomains.newValue || {};
    const oldValue = changes.webpageSwitchDomains.oldValue || {};
    console.log('域名状态变更:', {old: oldValue, new: newValue});

    // 确保状态持久化
    try {
      const result = await chrome.storage.local.get('webpageSwitchDomains');
      const currentDomains = result.webpageSwitchDomains || {};

      // 检查是否有丢失的域名
      const allDomains = {...oldValue, ...currentDomains};
      if (Object.keys(allDomains).length > Object.keys(currentDomains).length) {
        console.log('检测到域名丢失，恢复状态:', allDomains);
        await chrome.storage.local.set({ webpageSwitchDomains: allDomains });
      }
    } catch (error) {
      console.error('域名状态持久化失败:', error);
    }
  }
});

// 保持 Service Worker 活跃
let keepAliveInterval = setInterval(() => {
  console.log('Service Worker 心跳:', new Date().toISOString());
}, 20000);

// 清理函数
self.addEventListener('beforeunload', () => {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
  }
});

// 初始化检查
chrome.runtime.onInstalled.addListener(() => {
  console.log('扩展已安装/更新，时间:', new Date().toISOString());
  chrome.commands.getAll().then(commands => {
    console.log('已注册的命令:', commands);
    commands.forEach(cmd => {
      console.log(`命令 ${cmd.name} 的快捷键:`, cmd.shortcut || '未设置');
    });
  });
});

// PDF下载函数
async function downloadPDF(url) {
    try {
        console.log('开始下载PDF文件:', url);
        const response = await fetch(url);
        console.log('PDF文件下载响应状态:', response.status);
        const arrayBuffer = await response.arrayBuffer();
        console.log('PDF文件下载完成，大小:', arrayBuffer.byteLength, 'bytes');
        return arrayBuffer;
    } catch (error) {
        console.error('PDF下载失败:', error);
        console.error('错误堆栈:', error.stack);
        throw new Error('PDF下载失败: ' + error.message);
    }
}

// 添加网络请求跟踪
const tabRequests = new Map(); // 存储每个标签页的请求

// 初始化标签页的请求跟踪
function initTabRequests(tabId) {
  if (!tabRequests.has(tabId)) {
    tabRequests.set(tabId, {
      pending: new Set(),
      isInitialRequestsCompleted: false
    });
  }
}

// 添加连接检查函数
async function isTabConnected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return true;
  } catch (error) {
    return false;
  }
}

// 修改消息发送函数
async function sendMessageToTab(tabId, message) {
  try {
    if (await isTabConnected(tabId)) {
      return await chrome.tabs.sendMessage(tabId, message);
    } else {
      console.log(`标签页 ${tabId} 未连接，跳过消息发送`);
      return null;
    }
  } catch (error) {
    // console.log(`发送消息到标签页 ${tabId} 失败:`, error);
    return null;
  }
}

// 修改网络请求监听器
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    const { tabId, requestId, url } = details;
    if (tabId !== -1) {  // 忽略不属于任何标签页的请求
      initTabRequests(tabId);
      const tabData = tabRequests.get(tabId);
      tabData.pending.add(requestId);

      // 通知 content script
      await sendMessageToTab(tabId, {
        type: 'REQUEST_STARTED',
        requestId,
        pendingCount: tabData.pending.size
      });
    }
  },
  { urls: ["<all_urls>"] }
);

// 修改请求完成监听器
chrome.webRequest.onCompleted.addListener(
  async (details) => {
    const { tabId, requestId, url } = details;
    if (tabId !== -1 && tabRequests.has(tabId)) {
      const tabData = tabRequests.get(tabId);
      tabData.pending.delete(requestId);

      if (tabData.pending.size === 0 && !tabData.isInitialRequestsCompleted) {
        tabData.isInitialRequestsCompleted = true;
        console.log(`[Tab ${tabId}] 所有初始请求已完成`);
      }

      // 通知 content script
      await sendMessageToTab(tabId, {
        type: 'REQUEST_COMPLETED',
        requestId,
        pendingCount: tabData.pending.size,
        isInitialRequestsCompleted: tabData.isInitialRequestsCompleted
      });
    }
  },
  { urls: ["<all_urls>"] }
);

// 修改请求错误监听器
chrome.webRequest.onErrorOccurred.addListener(
  async (details) => {
    const { tabId, requestId, url } = details;
    if (tabId !== -1 && tabRequests.has(tabId)) {
      const tabData = tabRequests.get(tabId);
      tabData.pending.delete(requestId);

      // 通知 content script
      await sendMessageToTab(tabId, {
        type: 'REQUEST_FAILED',
        requestId,
        pendingCount: tabData.pending.size
      });
    }
  },
  { urls: ["<all_urls>"] }
);

// 清理标签页数据
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabRequests.has(tabId)) {
    console.log(`[Tab ${tabId}] 标签页关闭，清理请求数据`);
    tabRequests.delete(tabId);
  }
});