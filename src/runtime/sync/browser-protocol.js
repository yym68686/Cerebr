export const BROWSER_BRIDGE_VERSION = 1;
const readTypes = new Set(['GET_ALL_TABS', 'GET_CURRENT_TAB']);
const selectionTypes = new Set(['GET_WEBPAGE_SWITCHES', 'UPDATE_WEBPAGE_SWITCHES', 'SET_WEBPAGE_SWITCHES']);
const validTabId = (value) => Number.isSafeInteger(value) && value >= 0;

// This is intentionally not a generic extension-message or executeScript relay.
export function validateBrowserRequest(message) {
    if (!message || typeof message !== 'object') throw new Error('Invalid browser request');
    if (readTypes.has(message.type)) return { type: message.type };
    if (
        message.type === 'GET_TAB_GROUPS_BY_IDS' &&
        Array.isArray(message.groupIds) &&
        message.groupIds.length <= 1000 &&
        message.groupIds.every(validTabId)
    )
        return { type: message.type, groupIds: [...new Set(message.groupIds)] };
    if (message.type === 'GET_PAGE_CONTENT_FROM_SIDEBAR' && validTabId(message.tabId))
        return { type: message.type, tabId: message.tabId, skipWaitContent: true };
    if (
        selectionTypes.has(message.type) &&
        typeof message.chatId === 'string' &&
        message.chatId.length > 0 &&
        message.chatId.length <= 200
    ) {
        if (message.type === 'GET_WEBPAGE_SWITCHES')
            return { type: message.type, chatId: message.chatId, initialize: message.initialize === true };
        if (message.patch && typeof message.patch === 'object' && !Array.isArray(message.patch)) {
            const entries = Object.entries(message.patch);
            if (
                entries.length <= 1000 &&
                entries.every(
                    ([key, value]) =>
                        /^\d+$/.test(key) && validTabId(Number(key)) && typeof value === 'boolean'
                )
            )
                return { type: message.type, chatId: message.chatId, patch: Object.fromEntries(entries) };
        }
    }
    throw new Error('Unsupported browser request');
}
