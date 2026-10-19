// Content imports can still be starting when a command arrives. The loader
// queues PING until boot completes; bound that wait if the page navigates away.
export function createTabConnection({ api, logger = console, timeoutMs = 5000 }) {
    const pendingInjections = new Map();
    const isClosedTabError = (error) => /No tab with id|Invalid tab ID|tab (?:was )?closed/i.test(error?.message || '');

    async function isTabConnected(tabId) {
        let timer;
        try {
            const response = await Promise.race([
                api.tabs.sendMessage(tabId, { type: 'PING', timestamp: Date.now() }),
                new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
            ]);
            return response?.type === 'PONG';
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    function reinjectContentScript(tabId, scriptPath) {
        if (pendingInjections.has(tabId)) return pendingInjections.get(tabId);
        const pending = (async () => {
            try {
                const tab = await api.tabs.get(tabId);
                if (!tab || tab.discarded) return false;
                await api.scripting.executeScript({ target: { tabId }, files: [scriptPath] });
                return await isTabConnected(tabId);
            } catch (error) {
                // Closing a selected tab while extraction is starting is normal.
                if (!isClosedTabError(error)) logger.error('重新注入 content script 失败:', error);
                return false;
            }
        })();
        pendingInjections.set(tabId, pending);
        void pending.finally(() => pendingInjections.delete(tabId));
        return pending;
    }

    return { isTabConnected, reinjectContentScript };
}
