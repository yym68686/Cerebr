class CerebrSidebar {
  constructor() {
    this.isVisible = false;
    this.sidebarWidth = 430;
    this.initialized = false;
    this.pageKey = window.location.origin + window.location.pathname;
    this.lastUrl = window.location.href;
    this.sidebar = null;
    this.hideTimeout = null;
    this.handleSidebarTransitionEnd = (event) => {
      if (!this.sidebar || event.target !== this.sidebar || event.propertyName !== 'transform') {
        return;
      }
      if (!this.isVisible) {
        if (this.hideTimeout) {
          clearTimeout(this.hideTimeout);
          this.hideTimeout = null;
        }
        this.sidebar.style.display = 'none';
      }
    };
    this.initializeSidebar();
    this.setupDragAndDrop(); // 添加拖放事件监听器
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
          this.sidebar.style.display = 'block';
          this.sidebar.classList.add('visible');
        } else {
          this.sidebar.classList.remove('visible');
          this.sidebar.style.display = 'none';
        }
        this.sidebar.style.width = `${this.sidebarWidth}px`;
      }
    } catch (error) {
      console.error('加载侧边栏状态失败:', error);
    }
  }

  async initializeSidebar() {
    try {
      // console.log('开始初始化侧边栏');
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
          --cerebr-sidebar-box-shadow: -2px 0 15px rgba(0,0,0,0.1);
          box-shadow: none;
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
          transition: transform 0.3s ease, box-shadow 0.3s ease;
          pointer-events: auto;
        }
        @media (prefers-color-scheme: dark) {
          .cerebr-sidebar {
            --cerebr-bg-color: #282c34;
            --cerebr-text-color: #abb2bf;
            --cerebr-sidebar-box-shadow: -2px 0 20px rgba(0,0,0,0.3);
          }
        }
        .cerebr-sidebar.visible {
          transform: translateX(-450px);
          box-shadow: var(--cerebr-sidebar-box-shadow, -2px 0 15px rgba(0,0,0,0.1));
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
      this.sidebar.style.display = 'none';
      this.sidebar.addEventListener('transitionend', this.handleSidebarTransitionEnd);

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
      iframe.src = chrome.runtime.getURL('index.html');
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

      // console.log('侧边栏已添加到文档');

      this.setupEventListeners(resizer);

      // 使用 requestAnimationFrame 确保状态已经应用
      requestAnimationFrame(() => {
        this.sidebar.classList.add('initialized');
        this.initialized = true;
        // console.log('侧边栏初始化完成');
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
      // 在改变可见性之前保存旧状态
      const wasVisible = this.isVisible;
      this.isVisible = !this.isVisible;

      // 更新DOM状态
      if (this.isVisible) {
        if (this.hideTimeout) {
          clearTimeout(this.hideTimeout);
          this.hideTimeout = null;
        }
        this.sidebar.style.display = 'block';
        void this.sidebar.offsetWidth; // 强制重排以使过渡动画运行
        this.sidebar.classList.add('visible');
      } else {
        this.sidebar.classList.remove('visible');

        if (this.hideTimeout) {
          clearTimeout(this.hideTimeout);
          this.hideTimeout = null;
        }

        if (!wasVisible) {
          this.sidebar.style.display = 'none';
        } else {
          this.hideTimeout = setTimeout(() => {
            if (!this.isVisible) {
              this.sidebar.style.display = 'none';
            }
            this.hideTimeout = null;
          }, 350);
          // 350ms是为了和css的transition的0.3s对齐，再加一些余量，等动画结束再设置为display:none
        }
      }

      // 保存状态
      this.saveState();

      // 如果从不可见变为可见，通知iframe并聚焦输入框
      if (!wasVisible && this.isVisible) {
        const iframe = this.sidebar.querySelector('.cerebr-sidebar__iframe');
        if (iframe) {
          iframe.contentWindow.postMessage({ type: 'FOCUS_INPUT' }, '*');
        }
      }
    } catch (error) {
      console.error('切换侧边栏失败:', error);
    }
  }

  setupDragAndDrop() {
    // console.log('初始化拖放功能');

    // 存储最后一次设置的图片数据
    let lastImageData = null;

    // 检查是否在侧边栏范围内的函数
    const isInSidebarBounds = (x, y) => {
      if (!this.sidebar) return false;
      const sidebarRect = this.sidebar.getBoundingClientRect();
      return (
        x >= sidebarRect.left &&
        x <= sidebarRect.right &&
        y >= sidebarRect.top &&
        y <= sidebarRect.bottom
      );
    };

    // 监听页面上的所有图片
    document.addEventListener('dragstart', (e) => {
      console.log('拖动开始，目标元素:', e.target.tagName);
      const img = e.target;
      if (img.tagName === 'IMG') {
        console.log('检测到图片拖动，图片src:', img.src);
        // 尝试直接获取图片的 src
        try {
          // 对于跨域图片，尝试使用 fetch 获取
          console.log('尝试获取图片数据');
          fetch(img.src)
            .then(response => response.blob())
            .then(blob => {
              console.log('成功获取图片blob数据，大小:', blob.size);
              const reader = new FileReader();
              reader.onloadend = () => {
                const base64Data = reader.result;
                console.log('成功转换为base64数据');
                const imageData = {
                  type: 'image',
                  data: base64Data,
                  name: img.alt || '拖放图片'
                };
                console.log('设置拖动数据:', imageData.name);
                lastImageData = imageData;  // 保存最后一次的图片数据
                // 使用自定义事件类型，避免数据丢失
                e.dataTransfer.setData('application/x-cerebr-image', JSON.stringify(imageData));
                e.dataTransfer.effectAllowed = 'copy';
              };
              reader.readAsDataURL(blob);
            })
            .catch(error => {
              console.error('获取图片数据失败:', error);
              // 如果 fetch 失败，回退到 canvas 方法
              console.log('尝试使用Canvas方法获取图片数据');
              try {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                const base64Data = canvas.toDataURL(img.src.match(/\.png$/i) ? 'image/png' : 'image/jpeg');
                console.log('成功使用Canvas获取图片数据');
                const imageData = {
                  type: 'image',
                  data: base64Data,
                  name: img.alt || '拖放图片'
                };
                console.log('设置拖动数据:', imageData.name);
                lastImageData = imageData;  // 保存最后一次的图片数据
                // 使用自定义事件类型，避免数据丢失
                e.dataTransfer.setData('application/x-cerebr-image', JSON.stringify(imageData));
                e.dataTransfer.effectAllowed = 'copy';
              } catch (canvasError) {
                console.error('Canvas获取图片数据失败:', canvasError);
              }
            });
        } catch (error) {
          console.error('处理图片拖动失败:', error);
        }
      }
    });

    // 监听拖动结束事件
    document.addEventListener('dragend', (e) => {
      const inSidebar = isInSidebarBounds(e.clientX, e.clientY);
      console.log('拖动结束，是否在侧边栏内:', inSidebar, '坐标:', e.clientX, e.clientY);

      const iframe = this.sidebar?.querySelector('.cerebr-sidebar__iframe');
      if (iframe && inSidebar && lastImageData && this.isVisible) {  // 确保侧边栏可见
        console.log('在侧边栏内放下，发送图片数据到iframe');
        iframe.contentWindow.postMessage({
          type: 'DROP_IMAGE',
          imageData: lastImageData
        }, '*');
      }
      // 重置状态
      lastImageData = null;
    });
  }
}

let sidebar;
try {
  sidebar = new CerebrSidebar();
  // console.log('侧边栏实例已创建');
} catch (error) {
  console.error('创建侧边栏实例失败:', error);
}

let inFlightPageContentPromise = null;

// 修改消息监听器
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // console.log('content.js 收到消息:', message.type);

    // 处理 PING 消息
    if (message.type === 'PING') {
      sendResponse({
        type: 'PONG',
        timestamp: message.timestamp,
        responseTime: Date.now()
      });
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
	        // console.log('收到获取页面内容请求');
	        if (inFlightPageContentPromise) {
	            inFlightPageContentPromise.then(sendResponse).catch(() => sendResponse(null));
	            return true;
	        }

	        inFlightPageContentPromise = extractPageContent(message.skipWaitContent);

	        inFlightPageContentPromise.then(content => {
	            sendResponse(content);
	        }).catch(error => {
	            console.error('提取页面内容失败:', error);
	            sendResponse(null);
	        }).finally(() => {
	            inFlightPageContentPromise = null;
	        });

	        return true;
	    }

    // 处理 NEW_CHAT 消息
    if (message.type === 'NEW_CHAT') {
        const iframe = sidebar?.sidebar?.querySelector('.cerebr-sidebar__iframe');
        if (iframe) {
            iframe.contentWindow.postMessage({ type: 'NEW_CHAT' }, '*');
        }
        sendResponse({ success: true });
        return true;
    }

    return true;
});

const port = chrome.runtime.connect({ name: 'cerebr-sidebar' });
port.onDisconnect.addListener(() => {
  console.log('与 background 的连接已断开');
});

function sendInitMessage(retryCount = 0) {
  const maxRetries = 10;
  const retryDelay = 1000;

  // console.log(`尝试发送初始化消息，第 ${retryCount + 1} 次尝试`);

  chrome.runtime.sendMessage({
    type: 'CONTENT_LOADED',
    url: window.location.href
  }).then(response => {
    // console.log('Background 响应:', response);
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
  if (event.message && event.message.includes('ResizeObserver loop')) {
    // console.debug('忽略 ResizeObserver 警告:', event.message);
    return; // 不记录为错误
  }
  console.error('全局错误:', event.error);
  // 添加更多错误信息记录
  console.error('错误详情:', {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    type: event.type,
    timeStamp: event.timeStamp,
    eventPhase: event.eventPhase
  });
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('未处理的 Promise 拒绝:', event.reason);
});


// 修改 extractPageContent 函数
async function extractPageContent(skipWaitContent = false) {
  // console.log('extractPageContent 开始提取页面内容');

  // 检查是否是PDF或者iframe中的PDF
  let pdfUrl = null;
  if (document.contentType === 'application/pdf' ||
      (window.location.href.includes('.pdf') ||
       document.querySelector('iframe[src*="pdf.js"]') ||
       document.querySelector('iframe[src*=".pdf"]'))) {
    // console.log('检测到PDF文件，尝试提取PDF内容');
    pdfUrl = window.location.href;

    // 如果是iframe中的PDF，尝试提取实际的PDF URL
    const pdfIframe = document.querySelector('iframe[src*="pdf.js"]') || document.querySelector('iframe[src*=".pdf"]');
    if (pdfIframe) {
      const iframeSrc = pdfIframe.src;
      // 尝试从iframe src中提取实际的PDF URL
      const urlMatch = iframeSrc.match(/[?&]file=([^&]+)/);
      if (urlMatch) {
        pdfUrl = decodeURIComponent(urlMatch[1]);
        console.log('从iframe中提取到PDF URL:', pdfUrl);
      }
    }

  }

  // 等待内容加载和网络请求完成 - 如果 skipWaitContent 为 true，则跳过等待
  // 当 skipWaitContent 为 true 时，表示是按需提取
  if (skipWaitContent) {
    // console.log('按需提取内容 (skipWaitContent=true)');
    // 如果是 PDF
    if (pdfUrl) {
      // console.log('按需提取 PDF 内容');
      const pdfText = await extractTextFromPDF(pdfUrl);
      if (pdfText) {
        return {
          title: document.title,
          url: window.location.href,
          content: pdfText
        };
      }
      return null;
    }
    const iframes = document.querySelectorAll('iframe');
    let frameContent = '';
    for (const iframe of iframes) {
      try {
        if (iframe.contentDocument || iframe.contentWindow) {
          const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;
          const content = iframeDocument.body.innerText;
          frameContent += content;
        }
      } catch (e) {
        // console.log('无法访问该iframe内容:', e.message);
      }
    }

    const tempContainer = document.body.cloneNode(true);

    // 将表单元素的实时 value 同步到克隆的节点中，以便 innerText 可以获取到
    const originalFormElements = document.body.querySelectorAll('textarea, input');
    const clonedFormElements = tempContainer.querySelectorAll('textarea, input');
    originalFormElements.forEach((el, index) => {
      if (clonedFormElements[index] && el.value) {
        clonedFormElements[index].textContent = el.value;
      }
    });

    const selectorsToRemove = [
        'script', 'style', 'nav', 'header', 'footer',
        'iframe', 'noscript', 'img', 'svg', 'video',
        '[role="complementary"]', '[role="navigation"]',
        '.sidebar', '.nav', '.footer', '.header'
    ];
    selectorsToRemove.forEach(selector => {
        tempContainer.querySelectorAll(selector).forEach(element => element.remove());
    });

    let mainContent = tempContainer.innerText + frameContent;
    mainContent = mainContent.replace(/\s+/g, ' ').replace(/\n\s*\n/g, '\n').trim();

    if (mainContent.length < 40) {
      console.log('提取的内容太少，返回 null');
      return null;
    }

    const gptTokenCount = await estimateGPTTokens(mainContent);
    console.log('页面内容提取完成，内容长度:', mainContent.length, 'GPT tokens:', gptTokenCount);

    return {
      title: document.title,
      url: window.location.href,
      content: mainContent
    };
  }

  // 当 skipWaitContent 为 false (默认)，表示是自动调用。
  // 在这种模式下，我们不进行任何耗时操作，特别是对于PDF。
  // console.log('自动调用 extractPageContent，不执行提取 (skipWaitContent=false)');
  return null;
}

// PDF.js 库的路径
const PDFJS_PATH = chrome.runtime.getURL('lib/pdf.js');
const PDFJS_WORKER_PATH = chrome.runtime.getURL('lib/pdf.worker.js');

// 设置 PDF.js worker 路径
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_PATH;

let inFlightPdfUrl = null;
let inFlightPdfExtraction = null;

const PDF_TEXT_CACHE_MAX_ENTRIES = 3;
const PDF_TEXT_CACHE_MAX_CHARS = 1_000_000;
const pdfTextCache = new Map();

function getCachedPdfText(url) {
  const cached = pdfTextCache.get(url);
  if (!cached) return null;
  pdfTextCache.delete(url);
  pdfTextCache.set(url, cached);
  return cached.text || null;
}

function setCachedPdfText(url, text) {
  if (!url || !text) return;
  if (typeof text === 'string' && text.length > PDF_TEXT_CACHE_MAX_CHARS) return;
  pdfTextCache.delete(url);
  pdfTextCache.set(url, { text, createdAt: Date.now() });
  while (pdfTextCache.size > PDF_TEXT_CACHE_MAX_ENTRIES) {
    const oldestKey = pdfTextCache.keys().next().value;
    if (!oldestKey) break;
    pdfTextCache.delete(oldestKey);
  }
}

async function extractTextFromPDF(url) {
  const cachedText = getCachedPdfText(url);
  if (cachedText) return cachedText;

  if (inFlightPdfExtraction && inFlightPdfUrl === url) {
    return inFlightPdfExtraction;
  }

  inFlightPdfUrl = url;

  const extractionPromise = (async () => {
  let requestId = null;
  const sendRuntimeMessage = (message) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve(response);
    });
  });
  let loadingTask = null;
  let pdf = null;
  let worker = null;
  try {
    // 使用已存在的 sidebar 实例
    if (!sidebar || !sidebar.sidebar) {
      console.error('侧边栏实例不存在');
      return null;
    }

    // 获取iframe
    const iframe = sidebar.sidebar.querySelector('.cerebr-sidebar__iframe');
    if (!iframe) {
      console.error('找不到iframe元素');
      return null;
    }

    // 发送更新placeholder消息
    const sendPlaceholderUpdate = (message, timeout = 0) => {
      // console.log('发送placeholder更新:', message);
      iframe.contentWindow.postMessage({
        type: 'UPDATE_PLACEHOLDER',
        placeholder: message,
        timeout: timeout
      }, '*');
    };

    sendPlaceholderUpdate('正在下载PDF文件...');

    console.log('开始下载PDF:', url);
    // 首先获取PDF文件的初始信息
    const initResponse = await sendRuntimeMessage({
      action: 'downloadPDF',
      url: url
    });

    if (!initResponse.success) {
      console.error('PDF初始化失败，响应:', initResponse);
      sendPlaceholderUpdate('PDF下载失败', 2000);
      throw new Error('PDF初始化失败');
    }

    requestId = initResponse.requestId;
    const { totalChunks, totalSize, chunkSize } = initResponse;
    // console.log(`PDF文件大小: ${totalSize} bytes, 总块数: ${totalChunks}`);

    if (!requestId) {
      sendPlaceholderUpdate('PDF下载失败', 2000);
      throw new Error('PDF初始化失败：缺少 requestId');
    }

    // 分块接收数据（直接写入预分配缓冲区，避免中间数组与重复拷贝）
    const effectiveChunkSize = Number.isFinite(chunkSize) && chunkSize > 0 ? chunkSize : (4 * 1024 * 1024);
    const completeData = new Uint8Array(totalSize);
    let receivedBytes = 0;
    for (let i = 0; i < totalChunks; i++) {
      sendPlaceholderUpdate(`正在下载PDF文件 (${Math.round((i + 1) / totalChunks * 100)}%)...`);

      const chunkResponse = await sendRuntimeMessage({
        action: 'getPDFChunk',
        requestId,
        chunkIndex: i
      });

      if (!chunkResponse?.success) {
        sendPlaceholderUpdate('PDF下载失败', 2000);
        throw new Error(`获取PDF块 ${i} 失败`);
      }

      const chunkData = chunkResponse.data;
      const chunkBytes = chunkData instanceof ArrayBuffer
        ? new Uint8Array(chunkData)
        : Array.isArray(chunkData)
          ? Uint8Array.from(chunkData)
          : new Uint8Array();
      const start = i * effectiveChunkSize;
      const expectedLen = Math.min(effectiveChunkSize, totalSize - start);
      if (chunkBytes.byteLength !== expectedLen) {
        throw new Error(`PDF块长度异常: chunk=${i}, got=${chunkBytes.byteLength}, expected=${expectedLen}, start=${start}, totalSize=${totalSize}`);
      }
      completeData.set(chunkBytes, start);
      receivedBytes += chunkBytes.byteLength;
    }

    if (receivedBytes !== totalSize) {
      throw new Error(`PDF下载不完整: received=${receivedBytes}, totalSize=${totalSize}`);
    }

    // 基本文件头校验，便于定位“下载到的并非PDF”类问题（例如HTML/重定向页）
    const header = String.fromCharCode(...completeData.slice(0, 5));
    if (header !== '%PDF-') {
      const preview = new TextDecoder('utf-8', { fatal: false }).decode(completeData.slice(0, 300));
      throw new Error(`下载内容不是PDF(缺少%PDF-头)，前300字节预览: ${preview}`);
    }

    sendPlaceholderUpdate('正在解析PDF文件...');

    // console.log('开始解析PDF文件');
    try {
      // 为每次解析创建独立 worker，避免复用导致的卡死/状态污染
      if (pdfjsLib.PDFWorker) {
        worker = new pdfjsLib.PDFWorker({ name: `cerebr-pdf-${Date.now()}` });
      }
    } catch (e) {
      worker = null;
    }

    loadingTask = pdfjsLib.getDocument(worker ? { data: completeData, worker } : { data: completeData });
    pdf = await loadingTask.promise;
    // console.log('PDF加载成功，总页数:', pdf.numPages);

    let fullText = '';
    // 遍历所有页面
    for (let i = 1; i <= pdf.numPages; i++) {
      sendPlaceholderUpdate(`正在提取文本 (${i}/${pdf.numPages})...`);
      // console.log(`开始处理第 ${i}/${pdf.numPages} 页`);
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(item => item.str).join(' ');
      // console.log(`第 ${i} 页提取的文本长度:`, pageText.length);
      fullText += pageText + '\n';
      try {
        page.cleanup();
      } catch (e) {
        // ignore
      }
    }

    // 计算GPT分词数量
    const gptTokenCount = await estimateGPTTokens(fullText);
    console.log('PDF文本提取完成，总文本长度:', fullText.length, '预计GPT tokens:', gptTokenCount);
    sendPlaceholderUpdate(`PDF处理完成 (约 ${gptTokenCount} tokens)`, 2000);
    setCachedPdfText(url, fullText);
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
  } finally {
    if (requestId) {
      sendRuntimeMessage({ action: 'releasePDF', requestId }).catch(() => {});
    }
    try {
      if (pdf && typeof pdf.destroy === 'function') {
        await pdf.destroy();
      }
    } catch (e) {
      // ignore
    }
    try {
      if (loadingTask && typeof loadingTask.destroy === 'function') {
        await loadingTask.destroy();
      }
    } catch (e) {
      // ignore
    }
    try {
      if (worker && typeof worker.destroy === 'function') {
        await worker.destroy();
      }
    } catch (e) {
      // ignore
    }
  }
  })();

  inFlightPdfExtraction = extractionPromise;

  try {
    return await extractionPromise;
  } finally {
    if (inFlightPdfExtraction === extractionPromise) {
      inFlightPdfExtraction = null;
      inFlightPdfUrl = null;
    }
  }
}


// 添加GPT分词估算函数
async function estimateGPTTokens(text) {
  try {
    // 简单估算：平均每4个字符约为1个token
    // 这是一个粗略估计，实际token数可能会有所不同
    const estimatedTokens = Math.ceil(text.length / 4.25625);
    return estimatedTokens;
  } catch (error) {
    console.error('计算GPT tokens时出错:', error);
    return 0;
  }
}
