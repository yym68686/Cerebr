import { validateBrowserRequest } from '../../runtime/sync/browser-protocol.js';
import { createWebpageTabRegistry } from './webpage-tab-registry.js';
import {
    getWebpageSwitchesForChat,
    updateWebpageSwitchesForChat,
    setWebpageSwitchesForChat,
} from '../../utils/webpage-switches.js';

export function createBrowserPageRequests({ api, getPageContent }) {
    const identifyTabs = createWebpageTabRegistry(api.storage?.session);
    const allTabs = async () => identifyTabs(await api.tabs.query({}));
    const currentTab = async () =>
        (await api.tabs.query({ active: true, lastFocusedWindow: true }))[0] || null;
    return async (raw) => {
        const message = validateBrowserRequest(raw);
        if (message.type === 'GET_ALL_TABS') return allTabs();
        if (message.type === 'GET_CURRENT_TAB') return currentTab();
        if (message.type === 'GET_PAGE_CONTENT_FROM_SIDEBAR') return getPageContent(message);
        if (message.type === 'GET_TAB_GROUPS_BY_IDS') {
            if (!api.tabGroups?.get) return {};
            const groups = await Promise.allSettled(message.groupIds.map((id) => api.tabGroups.get(id)));
            return Object.fromEntries(
                groups.filter((group) => group.status === 'fulfilled').map(({ value }) => [value.id, value])
            );
        }
        if (message.type === 'GET_WEBPAGE_SWITCHES')
            return getWebpageSwitchesForChat(message.chatId, {
                currentTab: await currentTab(),
                tabs: await allTabs(),
                initialize: message.initialize,
            });
        if (message.type === 'SET_WEBPAGE_SWITCHES')
            return setWebpageSwitchesForChat(message.chatId, message.patch);
        const tabs = (await allTabs()).filter((tab) => Object.hasOwn(message.patch, tab.id));
        if (tabs.length !== Object.keys(message.patch).length)
            throw new Error('Selected browser tab has closed');
        return updateWebpageSwitchesForChat(message.chatId, message.patch, { tabs });
    };
}
