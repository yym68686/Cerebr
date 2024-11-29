console.log('Cerebr content script loaded at:', new Date().toISOString());
console.log('Window location:', window.location.href);
console.log('Document readyState:', document.readyState);

class CerebrSidebar {
  constructor() {
    this.isVisible = false;
    this.sidebarWidth = 430;
    this.initialized = false;
    this.pageKey = window.location.origin + window.location.pathname;
    console.log('CerebrSidebar 实例创建');
    this.initializeSidebar();
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

  initializeSidebar() {
    try {
      console.log('开始初始化侧边栏');
      const container = document.createElement('cerebr-root');
      container.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent = `
        :host {
          all: initial;
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
        }
        .cerebr-sidebar__iframe {
          width: 100%;
          height: 100%;
          border: none;
          background: var(--cerebr-bg-color, #ffffff);
        }
      `;

      this.sidebar = document.createElement('div');
      this.sidebar.className = 'cerebr-sidebar';

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

      container.shadowRoot.appendChild(style);
      container.shadowRoot.appendChild(this.sidebar);

      document.documentElement.appendChild(container);
      console.log('侧边栏已添加到文档');

      this.setupEventListeners(resizer);

      this.loadState().then(() => {
        requestAnimationFrame(() => {
          this.sidebar.classList.add('initialized');
          this.initialized = true;
          console.log('侧边栏初始化完成');
        });
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
      console.log('切换侧边栏可见性，当前状态:', this.isVisible);
      this.isVisible = !this.isVisible;
      this.sidebar.classList.toggle('visible', this.isVisible);
      this.saveState();
      console.log('侧边栏可见性已切换为:', this.isVisible);

      if (this.isVisible) {
        const iframe = this.sidebar.querySelector('.cerebr-sidebar__iframe');
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('收到消息:', message, '来自:', sender);

  if (message.type === 'TOGGLE_SIDEBAR') {
    try {
      console.log('收到切换侧边栏命令，来源:', message.source);
      if (sidebar) {
        sidebar.toggle();
        console.log('侧边栏已切换');
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

function extractPageContent() {
  console.log('开始提取页面内容');
  // 创建一个文档片段来处理内容，避免修改原始页面
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = document.body.innerHTML;

  // 检查是否是PDF
  if (document.contentType === 'application/pdf') {
    console.log('检测到PDF文件，尝试提取PDF内容');
    return extractTextFromPDF(window.location.href).then(pdfText => {
      if (pdfText) {
        return {
          title: document.title,
          url: window.location.href,
          content: pdfText
        };
      }
    });
  }

  // 在临时容器中移除不需要的元素
  const elementsToRemove = tempDiv.querySelectorAll('script, style, noscript, iframe, svg, header, footer, nav, aside');
  elementsToRemove.forEach(el => el.remove());

  // 获取主要内容
  const article = document.querySelector('article') || document.querySelector('main') || document.querySelector('.content') || document.querySelector('.article');

  // 如果找到定的内容容器，使用它
  let mainContent = '';
  if (article) {
    const clone = article.cloneNode(true);
    // 清理克隆的内容
    const cleanup = clone.querySelectorAll('script, style, noscript, iframe, svg');
    cleanup.forEach(el => el.remove());
    mainContent = clone.textContent;
  } else {
    // 如果没有找到特定容器，从 body 提取文本
    const bodyClone = tempDiv;
    const paragraphs = bodyClone.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li');
    mainContent = Array.from(paragraphs)
      .map(p => p.textContent.trim())
      .filter(text => text.length > 20)  // 只保留较长的文本
      .join('\n');
  }

  // 清理文本
  mainContent = mainContent
    .replace(/\s+/g, ' ')  // 替换多个空白字符为单个空格
    .replace(/\n\s*\n/g, '\n')  // 替换多个换行为单个换行
    .trim();

  console.log('页面内容提取完成，内容长度:', mainContent.length);

  return {
    title: document.title,
    url: window.location.href,
    content: mainContent
  };
}

// 监听消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_PAGE_CONTENT') {
    console.log('收到获取页面内容请求');
    const content = extractPageContent();
    if (content instanceof Promise) {
      content.then(result => {
        console.log('异步内容提取完成');
        sendResponse(result);
      }).catch(error => {
        console.error('内容提取失败:', error);
        sendResponse(null);
      });
      return true;
    }
    sendResponse(content);
  }
  return true;
});

// PDF.js 库的路径
const PDFJS_PATH = chrome.runtime.getURL('lib/pdf.js');
const PDFJS_WORKER_PATH = chrome.runtime.getURL('lib/pdf.worker.js');

// 设置 PDF.js worker 路径
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_PATH;

async function extractTextFromPDF(url) {
  try {
    // 在shadow DOM中查找容器
    const sidebar = document.querySelector('cerebr-root');
    if (!sidebar || !sidebar.shadowRoot) {
      console.error('找不到侧边栏元素');
      return null;
    }

    // 通过iframe发送消息来更新placeholder
    const iframe = sidebar.shadowRoot.querySelector('.cerebr-sidebar__iframe');
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
    const iframe = sidebar.shadowRoot.querySelector('.cerebr-sidebar__iframe');
    if (iframe) {
      iframe.contentWindow.postMessage({
        type: 'UPDATE_PLACEHOLDER',
        placeholder: 'PDF处理失败',
        timeout: 2000
      }, '*');
    }
    return null;
  }
}