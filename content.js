// executeScript may run this classic script again in the same isolated world.
// Keep lexical declarations private and reuse a pending or successful bootstrap.
(() => {
  const previous = globalThis.__cerebrContentLoader;
  if (previous && previous.status !== 'failed') return;
  if (previous) chrome.runtime.onMessage.removeListener(previous.listener);
  const state = { status: 'loading', listener: null };
  globalThis.__cerebrContentLoader = state;
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

  state.listener = (message, sender, sendResponse) => {
    if (typeof runtimeMessageHandler === 'function') {
      return runtimeMessageHandler(message, sender, sendResponse);
    }

    if (state.status === 'failed') {
      sendResponse(null);
      return false;
    }
    pendingRuntimeMessages.push({ message, sender, sendResponse });
    return true;
  };
  chrome.runtime.onMessage.addListener(state.listener);

  // Keep this classic content-script loader dependency-free. Its target must be
  // the compiled module, including when Chrome loads the repository directory.
  const extensionManifest = chrome.runtime.getManifest();
  const backgroundEntry = extensionManifest.background.service_worker || extensionManifest.background.scripts[0];
  const compiledDirectory = backgroundEntry.slice(0, backgroundEntry.lastIndexOf('/') + 1);

  void import(chrome.runtime.getURL(`${compiledDirectory}src/host/content/content-script.js`))
    .then(({ bootContentScript }) => {
      runtimeMessageHandler = bootContentScript();
      state.status = 'ready';
      flushPendingRuntimeMessages();
    })
    .catch((error) => {
      state.status = 'failed';
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

})();
