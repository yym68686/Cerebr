const pendingRuntimeMessages = [];
let runtimeMessageHandler = null;

function flushPendingRuntimeMessages() {
  if (typeof runtimeMessageHandler !== 'function' || pendingRuntimeMessages.length === 0) {
    return;
  }

  const pending = pendingRuntimeMessages.splice(0);
  for (const { message, sender, sendResponse } of pending) {
    try {
      runtimeMessageHandler(message, sender, sendResponse);
    } catch (error) {
      console.error('处理排队的 content message 失败:', error);
      try {
        sendResponse(null);
      } catch {
        // ignore
      }
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (typeof runtimeMessageHandler === 'function') {
    return runtimeMessageHandler(message, sender, sendResponse);
  }

  pendingRuntimeMessages.push({ message, sender, sendResponse });
  return true;
});

void import(chrome.runtime.getURL('src/host/content/content-script.js'))
  .then(({ bootContentScript }) => {
    runtimeMessageHandler = bootContentScript();
    flushPendingRuntimeMessages();
  })
  .catch((error) => {
    console.error('加载 content script 模块失败:', error);
    const pending = pendingRuntimeMessages.splice(0);
    pending.forEach(({ sendResponse }) => {
      try {
        sendResponse(null);
      } catch {
        // ignore
      }
    });
  });
