// 确保 Service Worker 立即激活
self.addEventListener('install', (event) => {
  console.log('Service Worker 安装中...', new Date().toISOString());
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  // console.log('Service Worker 已激活', new Date().toISOString());
  event.waitUntil(
    (async () => {
      // 使用 clients.claim() 来控制未受控制的客户端。
      // 这在开发过程中或没有要声明的客户端时可能会失败。
      // 安全地捕获错误以避免未捕ared 的 Promise 拒绝。
      try {
        await self.clients.claim();
      } catch (error) {
        // console.warn('clients.claim() 失败，但可以安全地忽略:', error);
      }
    })()
  );
});

// 添加启动日志
// console.log('Background script loaded at:', new Date().toISOString());

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

// 重新注入 content script 并等待连接
async function reinjectContentScript(tabId) {
  console.log('标签页未连接，尝试重新注入 content script...');
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    console.log('已重新注入 content script');
    // 给脚本一点时间初始化
    await new Promise(resolve => setTimeout(resolve, 500));
    const isConnected = await isTabConnected(tabId);
    if (!isConnected) {
      console.log('重新注入后仍未连接');
    }
    return isConnected;
  } catch (error) {
    console.error('重新注入 content script 失败:', error);
    return false;
  }
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
    if (!isConnected && await reinjectContentScript(tab.id)) {
      await chrome.tabs.sendMessage(tab.id, { type: commandType });
      return;
    }

    if (isConnected) {
      await chrome.tabs.sendMessage(tab.id, { type: commandType });
    }
  } catch (error) {
    console.error(`处理${commandType}命令失败:`, error);
  }
}

// 监听扩展图标点击
chrome.action.onClicked.addListener(async (tab) => {
  console.log('扩展图标被点击');
  try {
    // 检查标签页是否已连接
    const isConnected = await isTabConnected(tab.id);
    if (!isConnected && await reinjectContentScript(tab.id)) {
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR_onClicked' });
      return;
    }

    if (isConnected) {
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR_onClicked' });
    }
  } catch (error) {
    console.error('处理切换失败:', error);
  }
});

// 简化后的命令监听器
chrome.commands.onCommand.addListener(async (command) => {
  console.log('onCommand:', command);

  if (command === 'toggle_sidebar') {
    await handleTabCommand('TOGGLE_SIDEBAR_toggle_sidebar');
  } else if (command === 'new_chat') {
    await handleTabCommand('NEW_CHAT');
  }
});

// 创建一个持久连接
let port = null;
chrome.runtime.onConnect.addListener((p) => {
  // console.log('建立持久连接');
  port = p;
  port.onDisconnect.addListener(() => {
    // console.log('连接断开，尝试重新连接', p.sender.tab.id, p.sender.tab.url);
    port = null;
  });
});

// 监听来自 content script 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // console.log('收到消息:', message, '来自:', sender.tab?.id);

  if (message.type === 'GET_CURRENT_TAB') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        sendResponse(tab);
      } catch (e) {
        console.error("Failed to get current tab:", e);
        sendResponse(null);
      }
    })();
    return true; // Indicates that the response is sent asynchronously.
  }

  if (message.type === 'CONTENT_LOADED') {
    // console.log('内容脚本已加载:', message.url);
    sendResponse({ status: 'ok', timestamp: new Date().toISOString() });
    return false;
  }

  // 检查标签页是否活跃
  if (message.type === 'CHECK_TAB_ACTIVE') {
    (async () => {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab) {
          sendResponse(false);
          return;
        }
        sendResponse(sender.tab && sender.tab.id === activeTab.id);
      } catch (error) {
        console.error('检查标签页活跃状态失败:', error);
        sendResponse(false);
      }
    })();
    return true;
  }

  if (message.type === 'IS_TAB_CONNECTED') {
    (async () => {
        const isConnected = await isTabConnected(message.tabId);
        sendResponse(isConnected);
    })();
    return true; // 保持通道开放以进行异步响应
  }

  // 处理来自 sidebar 的网页内容请求
  if (message.type === 'GET_PAGE_CONTENT_FROM_SIDEBAR') {
    (async () => {
      try {
        // 确保请求来自我们的扩展UI
        if (!sender.url || !sender.url.includes('index.html')) {
          console.warn('GET_PAGE_CONTENT_FROM_SIDEBAR request from invalid sender:', sender.url);
          sendResponse(null);
          return;
        }

        // 如果消息中指定了 tabId，则使用它；否则，查询当前活动标签页
        const tabIdToQuery = message.tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;

        if (!tabIdToQuery) {
          console.warn('No target tab found for GET_PAGE_CONTENT_FROM_SIDEBAR');
          sendResponse(null);
          return;
        }

        let isConnected = await isTabConnected(tabIdToQuery);
        if (!isConnected) {
            // 如果未连接，尝试重新注入脚本
            console.log(`Tab ${tabIdToQuery} not connected, attempting to reinject content script.`);
            isConnected = await reinjectContentScript(tabIdToQuery);
        }

        if (isConnected) {
          const response = await chrome.tabs.sendMessage(tabIdToQuery, {
            type: 'GET_PAGE_CONTENT_INTERNAL',
            skipWaitContent: message.skipWaitContent || false
          });
          sendResponse(response);
        } else {
          console.warn(`Tab ${tabIdToQuery} is still not connected, even after attempting to reinject.`);
          sendResponse(null);
        }
      } catch (error) {
        console.error(`Error in GET_PAGE_CONTENT_FROM_SIDEBAR for tab ${message.tabId}:`, error);
        sendResponse(null);
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
    // console.log('Service Worker 心跳:', new Date().toISOString());
}, HEARTBEAT_INTERVAL);

self.addEventListener('beforeunload', () => clearInterval(keepAliveInterval));

// 简化初始化检查
chrome.runtime.onInstalled.addListener(() => {
    console.log('扩展已安装/更新:', new Date().toISOString());
});

// 改进标签页连接检查
async function isTabConnected(tabId) {
    try {
        // console.log(`isTabConnected PING: ${tabId}`);
        const response = await chrome.tabs.sendMessage(tabId, {
            type: 'PING',
            timestamp: Date.now()
        });
        // console.log('isTabConnected:', response.type);
        return response && response.type === 'PONG';
    } catch {
        return false;
    }
}

// 监听标签页激活事件，并通知相关方，兼容 Firefox 需要
chrome.tabs.onActivated.addListener(activeInfo => {
  chrome.runtime.sendMessage({
    type: 'TAB_ACTIVATED',
    payload: activeInfo
  }).catch(error => {
    // 忽略错误，因为可能没有页面在监听
    if (error.message.includes('Could not establish connection') || error.message.includes('Receiving end does not exist')) {
      // This is expected if no content script is listening
    } else {
      console.error('Error sending TAB_ACTIVATED message:', error);
    }
  });
});
