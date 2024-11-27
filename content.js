console.log('Cerebr content script loaded at:', new Date().toISOString());
console.log('Window location:', window.location.href);
console.log('Document readyState:', document.readyState);

class CerebrSidebar {
  constructor() {
    this.isVisible = false;
    this.sidebarWidth = 430;
    console.log('CerebrSidebar 实例创建');
    this.initializeSidebar();
  }

  initializeSidebar() {
    try {
      console.log('开始初始化侧边栏');
      // 创建一个自定义元素作为容器
      const container = document.createElement('cerebr-root');
      container.attachShadow({ mode: 'open' }); // 使用 Shadow DOM

      // 创建样式
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
          transition: all 0.3s ease;
          border-radius: 12px;
          margin-right: 20px;
          overflow: hidden;
        }
        @media (prefers-color-scheme: dark) {
          .cerebr-sidebar {
            --cerebr-bg-color: #1a1a1a;
            --cerebr-text-color: #ffffff;
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

        .cerebr-sidebar {
          animation: sidebar-appear 0.3s ease;
        }
        @keyframes sidebar-appear {
          from {
            opacity: 0;
            transform: translateX(-430px) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translateX(-450px) scale(1);
          }
        }
      `;

      // 创建侧边栏容器
      this.sidebar = document.createElement('div');
      this.sidebar.className = 'cerebr-sidebar';

      // 创建头部
      const header = document.createElement('div');
      header.className = 'cerebr-sidebar__header';

      // 创建调整大小的手柄
      const resizer = document.createElement('div');
      resizer.className = 'cerebr-sidebar__resizer';

      // 创建内容区域
      const content = document.createElement('div');
      content.className = 'cerebr-sidebar__content';

      // 创建iframe
      const iframe = document.createElement('iframe');
      iframe.className = 'cerebr-sidebar__iframe';
      iframe.src = chrome.runtime.getURL('sidebar.html');
      iframe.allow = 'clipboard-write';

      // 组装DOM
      content.appendChild(iframe);
      this.sidebar.appendChild(header);
      this.sidebar.appendChild(resizer);
      this.sidebar.appendChild(content);

      // 添加样式和侧边栏到 Shadow DOM
      container.shadowRoot.appendChild(style);
      container.shadowRoot.appendChild(this.sidebar);

      // 添加到文档根节点
      document.documentElement.appendChild(container);
      console.log('侧边栏已添加到文档');

      // 添加事件监听
      this.setupEventListeners(resizer);
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
    try {
      console.log('切换侧边栏可见性，当前状态:', this.isVisible);
      this.isVisible = !this.isVisible;
      this.sidebar.classList.toggle('visible', this.isVisible);
      console.log('侧边栏可见性已切换为:', this.isVisible);
    } catch (error) {
      console.error('切换侧边栏失败:', error);
    }
  }
}

// 创建侧边栏实例
let sidebar;
try {
  sidebar = new CerebrSidebar();
  console.log('侧边栏实例已创建');
} catch (error) {
  console.error('创建侧边栏实例失败:', error);
}

// 监听来自 background 的消息
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
    return true;  // 保持消息通道开放
  }
});

// 建立持久连接
const port = chrome.runtime.connect({ name: 'cerebr-sidebar' });
port.onDisconnect.addListener(() => {
  console.log('与 background 的连接已断开');
});

// 修改初始化消息发送逻辑
function sendInitMessage(retryCount = 0) {
  const maxRetries = 10;
  const retryDelay = 1000; // 1秒

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
      console.error('达到最大重试次数，初始化消息发送失败');
    }
  });
}

// 等待文档加载完成后再发送初始化消息
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(sendInitMessage, 500); // 等待 500ms 后发送
  });
} else {
  setTimeout(sendInitMessage, 500);
}

// 添加错误处理
window.addEventListener('error', (event) => {
  console.error('全局错误:', event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('未处理的 Promise 拒绝:', event.reason);
});

// 添加提取网页内容的函数
function extractPageContent() {
    // 移除不需要的元素
    const elementsToRemove = document.querySelectorAll('script, style, noscript, iframe, img, svg, header, footer, nav, aside');
    elementsToRemove.forEach(el => el.remove());

    // 获取主要内容
    const article = document.querySelector('article') || document.querySelector('main') || document.body;

    // 获取所有文本节点
    const textNodes = [];
    const walk = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while (node = walk.nextNode()) {
        const text = node.textContent.trim();
        if (text.length > 20) {  // 只保留较长的文本
            textNodes.push(text);
        }
    }

    return {
        title: document.title,
        url: window.location.href,
        content: textNodes.join('\n')
    };
}

// 添加消息监听
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_PAGE_CONTENT') {
        const content = extractPageContent();
        sendResponse(content);
    }
    return true;
});