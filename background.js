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

// 按需注入 PDF.js：避免每个页面都加载 300KB+ 的库
const pdfJsInjectedTabs = new Set();

// YouTube timedtext URL 缓存：从 webRequest 捕获“带签名的完整 URL”，避免自行构造参数
const ytTimedTextUrlByTabAndVideo = new Map(); // key: `${tabId}:${videoId}` -> { url, createdAt }
const YT_TIMEDTEXT_TTL_MS = 10 * 60 * 1000;

function ytTimedTextKey(tabId, videoId) {
  return `${tabId}:${videoId}`;
}

function pruneYouTubeTimedTextCache() {
  const now = Date.now();
  for (const [key, value] of ytTimedTextUrlByTabAndVideo.entries()) {
    if (!value?.createdAt || now - value.createdAt > YT_TIMEDTEXT_TTL_MS) {
      ytTimedTextUrlByTabAndVideo.delete(key);
    }
  }
  // Hard cap to avoid unbounded growth
  const MAX_ENTRIES = 200;
  if (ytTimedTextUrlByTabAndVideo.size > MAX_ENTRIES) {
    const entries = Array.from(ytTimedTextUrlByTabAndVideo.entries());
    entries.sort((a, b) => (b[1]?.createdAt || 0) - (a[1]?.createdAt || 0));
    entries.slice(MAX_ENTRIES).forEach(([k]) => ytTimedTextUrlByTabAndVideo.delete(k));
  }
}

try {
  chrome.webRequest?.onBeforeRequest?.addListener?.(
    (details) => {
      try {
        // tabId 可能为 -1（例如扩展页/后台请求），只缓存来自页面的请求
        if (typeof details?.tabId !== 'number' || details.tabId < 0) return;
        const url = new URL(details.url);
        if (url.hostname !== 'www.youtube.com' || url.pathname !== '/api/timedtext') return;
        const videoId = url.searchParams.get('v');
        if (!videoId) return;
        ytTimedTextUrlByTabAndVideo.set(ytTimedTextKey(details.tabId, videoId), {
          url: url.toString(),
          createdAt: Date.now()
        });
        pruneYouTubeTimedTextCache();
      } catch {
        // ignore
      }
    },
    { urls: ['*://www.youtube.com/api/timedtext*'] }
  );
} catch {
  // ignore (e.g., missing permission in some environments)
}

chrome.tabs?.onRemoved?.addListener?.((tabId) => {
  pdfJsInjectedTabs.delete(tabId);
  // 清理该 tab 的 timedtext 缓存
  for (const key of ytTimedTextUrlByTabAndVideo.keys()) {
    if (key.startsWith(`${tabId}:`)) {
      ytTimedTextUrlByTabAndVideo.delete(key);
    }
  }
});

chrome.tabs?.onUpdated?.addListener?.((tabId, changeInfo) => {
  if (changeInfo?.status === 'loading') {
    pdfJsInjectedTabs.delete(tabId);
    // 页面刷新/跳转后清理该 tab 的 timedtext 缓存（新视频会产生新 URL）
    for (const key of ytTimedTextUrlByTabAndVideo.keys()) {
      if (key.startsWith(`${tabId}:`)) {
        ytTimedTextUrlByTabAndVideo.delete(key);
      }
    }
  }
});

async function ensurePdfJsInjected(tabId) {
  if (!tabId) return { success: false, error: 'Missing tabId' };
  if (pdfJsInjectedTabs.has(tabId)) return { success: true, alreadyInjected: true };

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib/pdf.js']
    });
    pdfJsInjectedTabs.add(tabId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
}

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

  if (message.type === 'ENSURE_PDFJS') {
    (async () => {
      const tabId = sender?.tab?.id;
      const result = await ensurePdfJsInjected(tabId);
      sendResponse(result);
    })();
    return true;
  }

  if (message.type === 'FETCH_YOUTUBE_TIMEDTEXT') {
    (async () => {
      try {
        const urlString = message?.url;
        if (!urlString || typeof urlString !== 'string') {
          sendResponse({ success: false, error: 'Missing url' });
          return;
        }

        let url;
        try {
          url = new URL(urlString);
        } catch {
          sendResponse({ success: false, error: 'Invalid url' });
          return;
        }

        const host = url.hostname.toLowerCase();
        const isYouTube = host === 'youtube.com' || host.endsWith('.youtube.com');
        if (!isYouTube || url.pathname !== '/api/timedtext') {
          sendResponse({ success: false, error: 'URL not allowed' });
          return;
        }

        // Avoid leaking cookies; the timedtext URL is typically fully signed.
        const resp = await fetch(url.toString(), { credentials: 'omit' });
        if (!resp.ok) {
          const preview = await resp.text().catch(() => '');
          sendResponse({
            success: false,
            error: `HTTP ${resp.status}`,
            preview: preview.slice(0, 300)
          });
          return;
        }

        const text = await resp.text();
        sendResponse({ success: true, text });
      } catch (error) {
        sendResponse({ success: false, error: error?.message || String(error) });
      }
    })();
    return true;
  }

  if (message.type === 'GET_YOUTUBE_TIMEDTEXT_URL') {
    (async () => {
      try {
        const tabId = sender?.tab?.id;
        const videoId = message?.videoId;
        if (!tabId || !videoId) {
          sendResponse({ success: false, url: null, lang: null, caps: null });
          return;
        }
        pruneYouTubeTimedTextCache();
        const cached = ytTimedTextUrlByTabAndVideo.get(ytTimedTextKey(tabId, videoId));
        let lang = null;
        let caps = null;
        if (cached?.url) {
          try {
            const url = new URL(cached.url);
            lang = url.searchParams.get('lang');
            caps = url.searchParams.get('caps');
          } catch {
            // ignore
          }
        }
        sendResponse({ success: true, url: cached?.url || null, lang, caps });
      } catch {
        sendResponse({ success: false, url: null, lang: null, caps: null });
      }
    })();
    return true;
  }

  if (message.type === 'GET_TAB_GROUPS_BY_IDS') {
    (async () => {
      try {
        if (!chrome.tabGroups || typeof chrome.tabGroups.get !== 'function') {
          sendResponse({});
          return;
        }
        const groupIds = Array.isArray(message?.groupIds) ? message.groupIds : [];
        const uniqueIds = [...new Set(groupIds)]
          .filter((id) => typeof id === 'number' && Number.isFinite(id) && id >= 0);

        if (uniqueIds.length === 0) {
          sendResponse({});
          return;
        }

        const results = await Promise.allSettled(uniqueIds.map((id) => chrome.tabGroups.get(id)));
        const groupsById = {};
        results.forEach((res) => {
          if (res.status !== 'fulfilled' || !res.value) return;
          const g = res.value;
          groupsById[g.id] = {
            id: g.id,
            title: g.title || '',
            color: g.color || null,
            collapsed: !!g.collapsed,
            windowId: g.windowId
          };
        });
        sendResponse(groupsById);
      } catch (e) {
        console.error('Failed to get tab groups:', e);
        sendResponse({});
      }
    })();
    return true;
  }

  if (message.type === 'GET_ALL_TABS') {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({});
        sendResponse(tabs);
      } catch (e) {
        console.error("Failed to get all tabs:", e);
        sendResponse(null);
      }
    })();
    return true;
  }

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

  if (message.type === 'RELOAD_TAB') {
    (async () => {
        try {
            await chrome.tabs.reload(message.tabId);
            sendResponse({ status: 'success' });
        } catch (error) {
            console.error(`Failed to reload tab ${message.tabId}:`, error);
            sendResponse({ status: 'error', error: error.message });
        }
    })();
    return true;
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
        const response = await getPDFChunk(message.requestId, message.chunkIndex);
        sendResponse(response);
      } catch (error) {
        sendResponse({success: false, error: error.message});
      }
    })();
    return true;
  }

  // 处理释放PDF缓存的请求
  if (message.action === 'releasePDF') {
    (async () => {
      try {
        const response = releasePDF(message.requestId);
        sendResponse(response);
      } catch (error) {
        sendResponse({ success: false, error: error.message });
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

const PDF_CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_PDF_CACHE_ENTRIES = 5;
const MAX_PDF_CACHE_TOTAL_BYTES = 256 * 1024 * 1024;

/** @type {Map<string, {arrayBuffer: ArrayBuffer, totalSize: number, totalChunks: number, chunkSize: number, createdAt: number, lastAccessed: number, url: string}>} */
const pdfCache = new Map();

function touchPdfCacheEntry(requestId) {
  const entry = pdfCache.get(requestId);
  if (!entry) return null;
  entry.lastAccessed = Date.now();
  pdfCache.delete(requestId);
  pdfCache.set(requestId, entry);
  return entry;
}

function getPdfCacheTotalBytes() {
  let total = 0;
  for (const entry of pdfCache.values()) {
    total += entry.totalSize || 0;
  }
  return total;
}

function evictPdfCacheIfNeeded() {
  while (pdfCache.size > MAX_PDF_CACHE_ENTRIES || (pdfCache.size > 1 && getPdfCacheTotalBytes() > MAX_PDF_CACHE_TOTAL_BYTES)) {
    const oldestKey = pdfCache.keys().next().value;
    if (!oldestKey) break;
    pdfCache.delete(oldestKey);
  }
}

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
      const headers = {
          'Accept': 'application/pdf,*/*',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
      };

      // 如果是ScienceDirect的URL，添加特殊处理
      if (url.includes('sciencedirectassets.com')) {
          // 从原始页面获取必要的cookie和referer
          headers['Accept'] = '*/*';  // ScienceDirect需要这个
          headers['Referer'] = 'https://www.sciencedirect.com/';
          headers['Origin'] = 'https://www.sciencedirect.com';
          headers['Connection'] = 'keep-alive';
      }
      const response = await fetch(url, {
        method: 'GET',
        headers: headers,
        credentials: 'include',
        mode: 'cors'
      });
      // 处理在线文件
      if (!response.ok) {
          throw new Error('PDF文件下载失败');
      }
      return response.arrayBuffer();
  }
}

// 修改 downloadPDF 函数
async function downloadPDF(url) {
  try {
      // console.log('开始下载PDF文件:', url);
      const arrayBuffer = await getPDFArrayBuffer(url);
      // console.log('PDF文件下载完成，大小:', arrayBuffer.byteLength, 'bytes');
      const totalSize = arrayBuffer.byteLength;
      const totalChunks = Math.ceil(totalSize / PDF_CHUNK_SIZE);

      const requestId = (self.crypto && typeof self.crypto.randomUUID === 'function')
        ? self.crypto.randomUUID()
        : `${Date.now()}_${Math.random().toString(16).slice(2)}`;

      pdfCache.set(requestId, {
        arrayBuffer,
        totalSize,
        totalChunks,
        chunkSize: PDF_CHUNK_SIZE,
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        url
      });
      evictPdfCacheIfNeeded();

      return {
        success: true,
        type: 'init',
        requestId,
        totalChunks,
        totalSize,
        chunkSize: PDF_CHUNK_SIZE
      };
  } catch (error) {
      console.error('PDF下载失败:', error);
      console.error('错误堆栈:', error.stack);
      throw new Error('PDF下载失败: ' + error.message);
  }
}

// 修改 getPDFChunk 函数
async function getPDFChunk(requestId, chunkIndex) {
  try {
      const entry = touchPdfCacheEntry(requestId);
      if (!entry) {
        return { success: false, error: 'PDF cache entry not found' };
      }

      const start = chunkIndex * entry.chunkSize;
      const end = Math.min(start + entry.chunkSize, entry.totalSize);
      if (start < 0 || start >= entry.totalSize || end <= start) {
        return { success: false, error: 'Invalid chunk range' };
      }

      return {
          success: true,
          type: 'chunk',
          chunkIndex: chunkIndex,
          // Note: Chrome extension messaging can be unreliable for ArrayBuffer payloads in some setups.
          // Use a plain number array to maximize compatibility; still avoid re-downloading by slicing cached buffer.
          data: Array.from(new Uint8Array(entry.arrayBuffer, start, end - start))
      };
  } catch (error) {
      console.error('获取PDF块数据失败:', error);
      return {
          success: false,
          error: error.message
      };
  }
}

function releasePDF(requestId) {
  if (!requestId) return { success: false, error: 'Missing requestId' };
  pdfCache.delete(requestId);
  return { success: true };
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
