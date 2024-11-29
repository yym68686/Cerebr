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

// 切换侧边栏
async function toggleSidebar(tab) {
  try {
    console.log('尝试切换侧边栏，标签页:', tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' });
    console.log('已发送切换侧边栏命令');
    return true;
  } catch (error) {
    console.error('切换侧边栏失败:', error);
    return false;
  }
}

// 处理切换侧边栏的通用函数
async function handleToggle() {
  try {
    console.log('开始处理切换请求');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      console.log('当前标签页:', tab);
      if (tab.url.startsWith('chrome://')) {
        console.warn('无法在 Chrome 内部页面上运行');
        return;
      }
      const result = await toggleSidebar(tab);
      console.log('切换结果:', result);
    } else {
      console.error('没有找到活动标签页');
    }
  } catch (error) {
    console.error('处理切换失败:', error);
    console.error('错误堆栈:', error.stack);
  }
}

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

// 监听扩展图标点击
chrome.action.onClicked.addListener(async (tab) => {
  console.log('扩展图标被点击');
  await handleToggle();
});

// 监听命令（快捷键）
chrome.commands.onCommand.addListener(async (command) => {
  console.log('收到快捷键命令:', command, '时间:', new Date().toISOString());

  if (command === '_execute_action') {
    console.log('执行快捷键命令');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      console.error('没有找到活动标签页');
      return;
    }

    if (tab.url.startsWith('chrome://')) {
      console.warn('无法在 Chrome 内部页面上运行');
      return;
    }

    try {
      // 直接发送消息到 content script
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'TOGGLE_SIDEBAR',
        source: 'shortcut'
      });
      console.log('快捷键切换响应:', response);
    } catch (error) {
      console.error('快捷键切换失败:', error);
    }
  }
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