console.log('Cerebr content script loaded at:', new Date().toISOString());
console.log('Window location:', window.location.href);
console.log('Document readyState:', document.readyState);

class CerebrSidebar {
  constructor() {
    this.isVisible = false;
    this.sidebarWidth = 430;
    this.initialized = false;
    this.pageKey = window.location.origin + window.location.pathname;
    this.lastUrl = window.location.href;
    console.log('CerebrSidebar 实例创建');
    this.lastToggleTime = null; // 添加上次执行时间存储
    this.initializeSidebar();
    this.setupUrlChangeListener();
  }

  setupUrlChangeListener() {
    let lastPathname = window.location.pathname;
    let lastSearch = window.location.search;

    // 检查是否是真正的页面变化
    const isRealPageChange = (oldPath, oldSearch) => {
        const newPathname = window.location.pathname;
        const newSearch = window.location.search;

        // 如果是 PDF，忽略 URL 中的 hash 和 search 变化
        if (document.contentType === 'application/pdf') {
            return false;
        }

        // 对于其他页面，检查路径或查询参数是否发生实质变化
        return newPathname !== oldPath || newSearch !== oldSearch;
    };

    // 处理 URL 变化的通用函数
    this.handleUrlChange = (source = '') => {
        const currentUrl = window.location.href;
        if (currentUrl !== this.lastUrl && isRealPageChange(lastPathname, lastSearch)) {
            console.log(`[URL变化${source ? '-' + source : ''}]`, '从:', this.lastUrl, '到:', currentUrl);
            this.lastUrl = currentUrl;
            lastPathname = window.location.pathname;
            lastSearch = window.location.search;

            const iframe = source === 'pushState' || source === 'replaceState'
                ? document.querySelector('cerebr-root')?.shadowRoot?.querySelector('.cerebr-sidebar__iframe')
                : this.sidebar?.querySelector('.cerebr-sidebar__iframe');

            if (iframe) {
                iframe.contentWindow.postMessage({
                    type: 'URL_CHANGED',
                    url: currentUrl
                }, '*');
            }
        }
    };

    // 使用 setInterval 定期检查 URL 变化
    setInterval(() => {
        this.handleUrlChange();
    }, 1000);

    // 修改 popstate 事件处理
    window.addEventListener('popstate', () => {
        this.handleUrlChange('popstate');
    });

    // 修改 pushState 和 replaceState 监听
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function() {
        originalPushState.apply(this, arguments);
        this.handleUrlChange('pushState');
    }.bind(this);

    history.replaceState = function() {
        originalReplaceState.apply(this, arguments);
        this.handleUrlChange('replaceState');
    }.bind(this);
  }

  async saveState() {
    try {
      const states = await chrome.storage.local.get('sidebarStates') || { sidebarStates: {} };
      if (!states.sidebarStates) {
        states.sidebarStates = {};
      }
      states.sidebarStates[this.pageKey] = {
        isVisible: this.isVisible,
        width: this.sidebarWidth
      };
      await chrome.storage.local.set(states);
    } catch (error) {
      console.error('保存侧边栏状态失败:', error);
    }
  }

  async loadState() {
    try {
      const states = await chrome.storage.local.get('sidebarStates');
      if (states.sidebarStates && states.sidebarStates[this.pageKey]) {
        const state = states.sidebarStates[this.pageKey];
        this.isVisible = state.isVisible;
        this.sidebarWidth = state.width;

        if (this.isVisible) {
          this.sidebar.classList.add('visible');
        }
        this.sidebar.style.width = `${this.sidebarWidth}px`;
      }
    } catch (error) {
      console.error('加载侧边栏状态失败:', error);
    }
  }

  async initializeSidebar() {
    try {
      console.log('开始初始化侧边栏');
      const container = document.createElement('cerebr-root');

      // 防止外部JavaScript访问和修改我们的元素
      Object.defineProperty(container, 'remove', {
        configurable: false,
        writable: false,
        value: () => {
          console.log('阻止移除侧边栏');
          return false;
        }
      });

      // 使用closed模式的shadowRoot以增加隔离性
      const shadow = container.attachShadow({ mode: 'closed' });

      const style = document.createElement('style');
      style.textContent = `
        :host {
          all: initial;
          contain: style layout size;
        }
        .cerebr-sidebar {
          position: fixed;
          top: 20px;
          right: -450px;
          width: 430px;
          height: calc(100vh - 40px);
          background: var(--cerebr-bg-color, #ffffff);
          color: var(--cerebr-text-color, #000000);
          box-shadow: -2px 0 15px rgba(0,0,0,0.1);
          z-index: 2147483647;
          border-radius: 12px;
          margin-right: 20px;
          overflow: hidden;
          visibility: hidden;
          transform: translateX(0);
          pointer-events: none;
          contain: style layout size;
          isolation: isolate;
        }
        .cerebr-sidebar.initialized {
          visibility: visible;
          transition: transform 0.3s ease;
          pointer-events: auto;
        }
        @media (prefers-color-scheme: dark) {
          .cerebr-sidebar {
            --cerebr-bg-color: #282c34;
            --cerebr-text-color: #abb2bf;
            box-shadow: -2px 0 20px rgba(0,0,0,0.3);
          }
        }
        .cerebr-sidebar.visible {
          transform: translateX(-450px);
        }
        .cerebr-sidebar__content {
          height: 100%;
          overflow: hidden;
          border-radius: 12px;
          contain: style layout size;
        }
        .cerebr-sidebar__iframe {
          width: 100%;
          height: 100%;
          border: none;
          background: var(--cerebr-bg-color, #ffffff);
          contain: strict;
        }
      `;

      this.sidebar = document.createElement('div');
      this.sidebar.className = 'cerebr-sidebar';

      // 防止外部JavaScript访问和修改侧边栏
      Object.defineProperty(this.sidebar, 'remove', {
        configurable: false,
        writable: false,
        value: () => {
          console.log('阻止移除侧边栏');
          return false;
        }
      });

      const header = document.createElement('div');
      header.className = 'cerebr-sidebar__header';

      const resizer = document.createElement('div');
      resizer.className = 'cerebr-sidebar__resizer';

      const content = document.createElement('div');
      content.className = 'cerebr-sidebar__content';

      const iframe = document.createElement('iframe');
      iframe.className = 'cerebr-sidebar__iframe';
      iframe.src = chrome.runtime.getURL('sidebar.html');
      iframe.allow = 'clipboard-write';

      content.appendChild(iframe);
      this.sidebar.appendChild(header);
      this.sidebar.appendChild(resizer);
      this.sidebar.appendChild(content);

      shadow.appendChild(style);
      shadow.appendChild(this.sidebar);

      // 先加载状态
      await this.loadState();

      // 添加到文档并保护它
      const root = document.documentElement;
      root.appendChild(container);

      // 使用MutationObserver确保我们的元素不会被移除
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'childList') {
            const removedNodes = Array.from(mutation.removedNodes);
            if (removedNodes.includes(container)) {
              console.log('检测到侧边栏被移除，正在恢复...');
              root.appendChild(container);
            }
          }
        }
      });

      observer.observe(root, {
        childList: true
      });

      console.log('侧边栏已添加到文档');

      this.setupEventListeners(resizer);

      // 使用 requestAnimationFrame 确保状态已经应用
      requestAnimationFrame(() => {
        this.sidebar.classList.add('initialized');
        this.initialized = true;
        console.log('侧边栏初始化完成');
      });
    } catch (error) {
      console.error('初始化侧边栏失败:', error);
    }
  }

  setupEventListeners(resizer) {
    let startX, startWidth;

    resizer.addEventListener('mousedown', (e) => {
      startX = e.clientX;
      startWidth = this.sidebarWidth;

      const handleMouseMove = (e) => {
        const diff = startX - e.clientX;
        this.sidebarWidth = Math.min(Math.max(300, startWidth + diff), 800);
        this.sidebar.style.width = `${this.sidebarWidth}px`;
      };

      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    });
  }

  toggle() {
    if (!this.initialized) return;

    try {
      const currentTime = new Date();
      const timeDiff = this.lastToggleTime ? currentTime - this.lastToggleTime : 0;

      // 如果时间间隔小于10ms则不执行
      if (timeDiff > 0 && timeDiff < 10) {
        console.log('切换操作被忽略 - 间隔太短:', timeDiff + 'ms');
        return;
      }

      console.log('切换侧边栏可见性 -',
        '当前时间:', currentTime.toLocaleTimeString(),
        '上次执行:', this.lastToggleTime ? this.lastToggleTime.toLocaleTimeString() : '无',
        '时间间隔:', timeDiff + 'ms',
        '当前状态:', this.isVisible,
        '侧边栏可见性已切换为:', !this.isVisible
      );
      this.lastToggleTime = currentTime;

      this.isVisible = !this.isVisible;
      this.sidebar.classList.toggle('visible', this.isVisible);
      this.saveState();


      if (this.isVisible) {
        const iframe = this.sidebar.querySelector('.cerebr-sidebar__iframe');
        // console.log('发送聚焦输入框消息');
        if (iframe) {
          iframe.contentWindow.postMessage({ type: 'FOCUS_INPUT' }, '*');
        }
      }
    } catch (error) {
      console.error('切换侧边栏失败:', error);
    }
  }
}

let sidebar;
try {
  sidebar = new CerebrSidebar();
  console.log('侧边栏实例已创建');
} catch (error) {
  console.error('创建侧边栏实例失败:', error);
}

// 修改消息监听器
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type != 'REQUEST_STARTED' && message.type != 'REQUEST_COMPLETED' &&
        message.type != 'REQUEST_FAILED' && message.type != 'PING') {
      console.log('content.js 收到消息:', message.type);
    }

    // 处理 PING 消息
    if (message.type === 'PING') {
      sendResponse(true);
      return true;
    }

    // 处理侧边栏切换命令
    if (message.type === 'TOGGLE_SIDEBAR_onClicked' || message.type === 'TOGGLE_SIDEBAR_toggle_sidebar') {
        try {
            if (sidebar) {
                sidebar.toggle();
                sendResponse({ success: true, status: sidebar.isVisible });
            } else {
                console.error('侧边栏实例不存在');
                sendResponse({ success: false, error: 'Sidebar instance not found' });
            }
        } catch (error) {
            console.error('处理切换命令失败:', error);
            sendResponse({ success: false, error: error.message });
        }
        return true;
    }

    // 处理获取页面内容请求
    if (message.type === 'GET_PAGE_CONTENT_INTERNAL') {
        console.log('收到获取页面内容请求');
        isProcessing = true;

        extractPageContent().then(content => {
            isProcessing = false;
            sendResponse(content);
        }).catch(error => {
            console.error('提取页面内容失败:', error);
            isProcessing = false;
            sendResponse(null);
        });

        return true;
    }

    return true;
});

// 监听来自iframe的消息
window.addEventListener('message', (event) => {
  // console.log("监听来自iframe的消息:", event.data);
  if (event.data && event.data.type === 'TOGGLE_SIDEBAR') {
      if (sidebar) {
          sidebar.toggle();
      }
  }
});

const port = chrome.runtime.connect({ name: 'cerebr-sidebar' });
port.onDisconnect.addListener(() => {
  console.log('与 background 的连接已断开');
});

function sendInitMessage(retryCount = 0) {
  const maxRetries = 10;
  const retryDelay = 1000;

  console.log(`尝试发送初始化消息，第 ${retryCount + 1} 次尝试`);

  chrome.runtime.sendMessage({
    type: 'CONTENT_LOADED',
    url: window.location.href
  }).then(response => {
    console.log('Background 响应:', response);
  }).catch(error => {
    console.log('发送消息失败:', error);
    if (retryCount < maxRetries) {
      console.log(`${retryDelay}ms 后重试...`);
      setTimeout(() => sendInitMessage(retryCount + 1), retryDelay);
    } else {
      console.error('达最大重试次数，初始化消息发送失败');
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(sendInitMessage, 500);
  });
} else {
  setTimeout(sendInitMessage, 500);
}

window.addEventListener('error', (event) => {
  console.error('全局错误:', event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('未处理的 Promise 拒绝:', event.reason);
});

// 添加变量来跟踪网络请求状态和时间
let pendingRequests = new Set();
let isInitialRequestsCompleted = false;
let lastRequestCompletedTime = null;
let requestCompletionTimer = null;
let relayRequestCompletedTime = 300;

// 检查请求是否已完成的函数
function checkRequestsCompletion() {
    const now = Date.now();
    if (lastRequestCompletedTime && (now - lastRequestCompletedTime) >= relayRequestCompletedTime) {
        // console.log(`${relayRequestCompletedTime} 毫秒内没有新的请求完成，判定为加载完成`);
        isInitialRequestsCompleted = true;
    }
}

// 重置计时器
function resetCompletionTimer() {
    if (requestCompletionTimer) {
        clearTimeout(requestCompletionTimer);
    }
    lastRequestCompletedTime = Date.now();
    requestCompletionTimer = setTimeout(checkRequestsCompletion, relayRequestCompletedTime);
}

// 监听来自 background.js 的网络请求状态更新
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 处理网络请求状态更新
    if (message.type === 'REQUEST_STARTED') {
        pendingRequests.add(message.requestId);
        // console.log('新请求开始，待处理请求数:', message.pendingCount);
    }
    else if (message.type === 'REQUEST_COMPLETED') {
        pendingRequests.delete(message.requestId);
        // console.log('请求完成，待处理请求数:', message.pendingCount);
        resetCompletionTimer(); // 重置计时器

        if (message.isInitialRequestsCompleted) {
            isInitialRequestsCompleted = true;
            // console.log('所有初始请求已完成');
        }
    }
    else if (message.type === 'REQUEST_FAILED') {
        pendingRequests.delete(message.requestId);
        console.log('请求失败，待处理请求数:', message.pendingCount);
        resetCompletionTimer(); // 重置计时器
    }
    // ... 其他消息处理 ...
    return true;
});

// 修改 waitForContent 函数
async function waitForContent() {
  return new Promise((resolve) => {
    const checkContent = () => {
      // 检查是否有主要内容元素
      const mainElements = document.querySelectorAll('body, p, h2, article, [role="article"], [role="main"], [data-testid="tweet"]');

      // 检查网络请求是否都已完成
      const requestsCompleted = lastRequestCompletedTime && (Date.now() - lastRequestCompletedTime) >= relayRequestCompletedTime;

      if (mainElements.length > 0 && requestsCompleted) {
        console.log(`页面内容已加载，网络请求已完成（已稳定${relayRequestCompletedTime}秒无新请求）`);
        resolve();
      } else {
        const reason = [];
        if (mainElements.length === 0) reason.push('主要内容未找到');
        if (!requestsCompleted) {
            if (pendingRequests.size > 0) {
                reason.push(`还有 ${pendingRequests.size} 个网络请求未完成`);
            }
            if (lastRequestCompletedTime) {
                const waitTime = Math.floor((relayRequestCompletedTime - (Date.now() - lastRequestCompletedTime)) / 1000);
                if (waitTime > 0) {
                    reason.push(`等待请求稳定，剩余 ${waitTime} 秒`);
                }
            } else {
                reason.push('等待首个请求完成');
            }
        }
        console.log('等待页面加载...', reason.join(', '));
        setTimeout(checkContent, 1000);
      }
    };

    // 开始检查
    setTimeout(checkContent, 1000);
  });
}

// 修改 extractPageContent 函数
async function extractPageContent() {
  console.log('extractPageContent 开始提取页面内容');

  // 检查是否是PDF
  if (document.contentType === 'application/pdf') {
    console.log('检测到PDF文件，尝试提取PDF内容');
    const pdfText = await extractTextFromPDF(window.location.href);
    if (pdfText) {
      return {
        title: document.title,
        url: window.location.href,
        content: pdfText
      };
    }
  }

  // 等待内容加载和网络请求完成
  await waitForContent();

  // 创建一个文档片段来处理内容
  const tempContainer = document.createElement('div');
  tempContainer.innerHTML = document.body.innerHTML;

  // 移除不需要的元素
  const selectorsToRemove = [
      'script', 'style', 'nav', 'header', 'footer',
      'iframe', 'noscript', 'img', 'svg', 'video',
      '[role="complementary"]', '[role="navigation"]',
      '.sidebar', '.nav', '.footer', '.header'
  ];

  selectorsToRemove.forEach(selector => {
      const elements = tempContainer.querySelectorAll(selector);
      elements.forEach(element => element.remove());
  });

  let mainContent = tempContainer.innerText;

  // 理文本
  mainContent = mainContent
      .replace(/\s+/g, ' ')  // 替换多个空白字符为单个空格
      .replace(/\n\s*\n/g, '\n')  // 替换多个换行为单个换行
      .trim();

  // 检查提取的内容是否足够
  if (mainContent.length < 40) {
      console.log('提取的内容太少，返回 null');
      return null;
  }

  console.log('页面内容提取完成，内容:', mainContent);
  console.log('页面内容提取完成，内容长度:', mainContent.length);

  return {
      title: document.title,
      url: window.location.href,
      content: mainContent
  };
}

// PDF.js 库的路径
const PDFJS_PATH = chrome.runtime.getURL('lib/pdf.js');
const PDFJS_WORKER_PATH = chrome.runtime.getURL('lib/pdf.worker.js');

// 设置 PDF.js worker 路径
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_PATH;

async function extractTextFromPDF(url) {
  try {
    // 使用已存在的 sidebar 实例
    if (!sidebar || !sidebar.sidebar) {
      console.error('侧边栏实例不存在');
      return null;
    }

    // 通过iframe发送消息来更新placeholder
    const iframe = sidebar.sidebar.querySelector('.cerebr-sidebar__iframe');
    if (iframe) {
      console.log('发送更新placeholder消息:', {
        type: 'UPDATE_PLACEHOLDER',
        placeholder: '正在下载PDF文件...'
      });
      iframe.contentWindow.postMessage({
        type: 'UPDATE_PLACEHOLDER',
        placeholder: '正在下载PDF文件...'
      }, '*');
    }

    console.log('开始下载PDF:', url);
    const response = await chrome.runtime.sendMessage({
      action: 'downloadPDF',
      url: url
    });

    if (!response.success) {
      console.error('PDF下载失败，响应:', response);
      if (iframe) {
        iframe.contentWindow.postMessage({
          type: 'UPDATE_PLACEHOLDER',
          placeholder: 'PDF下载失败',
          timeout: 2000
        }, '*');
      }
      throw new Error('PDF下载失败');
    }

    const uint8Array = new Uint8Array(response.data);
    console.log('PDF下载成功，数据大小:', uint8Array.byteLength, 'bytes');

    if (iframe) {
      iframe.contentWindow.postMessage({
        type: 'UPDATE_PLACEHOLDER',
        placeholder: '正在解析PDF文件...'
      }, '*');
    }

    console.log('开始解析PDF文件');
    const loadingTask = pdfjsLib.getDocument({data: uint8Array});
    const pdf = await loadingTask.promise;
    console.log('PDF加载成功，总页数:', pdf.numPages);

    let fullText = '';
    // 遍历所有页面
    for (let i = 1; i <= pdf.numPages; i++) {
      if (iframe) {
        iframe.contentWindow.postMessage({
          type: 'UPDATE_PLACEHOLDER',
          placeholder: `正在提取文本 (${i}/${pdf.numPages})...`
        }, '*');
      }
      console.log(`开始处理第 ${i}/${pdf.numPages} 页`);
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(item => item.str).join(' ');
      console.log(`第 ${i} 页提取的文本长度:`, pageText.length);
      fullText += pageText + '\n';
    }

    console.log('PDF文本提取完成，总文本长度:', fullText.length);
    if (iframe) {
      iframe.contentWindow.postMessage({
        type: 'UPDATE_PLACEHOLDER',
        placeholder: 'PDF处理完成',
        timeout: 2000
      }, '*');
    }
    return fullText;
  } catch (error) {
    console.error('PDF处理过程中出错:', error);
    console.error('错误堆栈:', error.stack);
    if (sidebar && sidebar.sidebar) {
      const iframe = sidebar.sidebar.querySelector('.cerebr-sidebar__iframe');
      if (iframe) {
        iframe.contentWindow.postMessage({
          type: 'UPDATE_PLACEHOLDER',
          placeholder: 'PDF处理失败',
          timeout: 2000
        }, '*');
      }
    }
    return null;
  }
}