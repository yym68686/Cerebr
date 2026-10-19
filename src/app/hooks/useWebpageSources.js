import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { desktopBrowserStore } from '../../platform/desktop-browser.js';
import { browserAdapter, isExtensionEnvironment } from '../../utils/storage-adapter.js';
import { getWebpageSourceTabs } from '../../runtime/webpage/webpage-context.js';
import {
    getWebpageSwitchesForChat,
    subscribeWebpageSwitches,
    updateWebpageSwitchesForChat,
} from '../../utils/webpage-switches.js';
import { notify } from '../state/ui-store.js';
import { t } from '../../utils/i18n.js';

const empty = { tabs: [], current: null, groups: {}, switches: {}, loading: false, error: null };

export function useWebpageSources(chatId, menuOpen, autoAddCurrentPage = false) {
    const browser = useSyncExternalStore(desktopBrowserStore.subscribe, desktopBrowserStore.getSnapshot);
    const available = isExtensionEnvironment || !!browser.session;
    const [data, setData] = useState(empty);
    const owner = useRef(null);
    const refresh = useCallback(() => owner.current?.refresh(), []);
    useEffect(() => {
        if (!available || !chatId) {
            setData(empty);
            return;
        }
        const context = { chatId, active: true, load: 0, mutation: 0, pending: 0 };
        owner.current = context;
        setData((previous) => (previous.chatId === chatId ? previous : { ...empty, chatId, loading: true }));
        context.refresh = async () => {
            const load = ++context.load,
                mutation = context.mutation;
            const current = () => context.active && load === context.load && mutation === context.mutation;
            try {
                const [allTabs, tab] = await Promise.all([
                    browserAdapter.getAllTabs(),
                    browserAdapter.getCurrentTab(),
                ]);
                if (!current()) return;
                const currentTab = allTabs.find((item) => item.id === tab?.id) || tab;
                const switches = await getWebpageSwitchesForChat(chatId, {
                    currentTab,
                    initialize: autoAddCurrentPage,
                });
                const tabs = getWebpageSourceTabs(allTabs, switches);
                const groupIds = [...new Set(tabs.map((tab) => tab.groupId).filter((id) => id >= 0))];
                const groups = await browserAdapter.getTabGroupsByIds(groupIds).catch(() => ({}));
                if (current())
                    setData({
                        chatId,
                        tabs,
                        current: tabs.find((item) => item.id === tab?.id || item.url === tab?.url) || null,
                        groups,
                        switches,
                        loading: false,
                        error: null,
                    });
            } catch (error) {
                if (current()) setData((previous) => ({ ...previous, loading: false, error }));
            }
        };
        const refreshVisible = () => {
            if (!document.hidden) void context.refresh();
        };
        const unsubscribe = subscribeWebpageSwitches((id) => {
            if (id === chatId && !context.pending) void context.refresh();
        });
        const unsubscribeTabs = browserAdapter.onTabActivated(refreshVisible);
        const unsubscribeTabChanges = browserAdapter.onTabsChanged(refreshVisible);
        window.addEventListener('focus', refreshVisible);
        document.addEventListener('visibilitychange', refreshVisible);
        void context.refresh();
        return () => {
            context.active = false;
            if (owner.current === context) owner.current = null;
            unsubscribe();
            unsubscribeTabs();
            unsubscribeTabChanges();
            window.removeEventListener('focus', refreshVisible);
            document.removeEventListener('visibilitychange', refreshVisible);
        };
    }, [chatId, autoAddCurrentPage, available, browser.session]);
    useEffect(() => {
        if (menuOpen) void refresh();
    }, [menuOpen, refresh]);
    const toggle = useCallback(
        async (tabs, value) => {
            const context = owner.current;
            if (!context?.active || context.chatId !== chatId || !tabs.length) return false;
            const patch = Object.fromEntries(tabs.map((tab) => [tab.id, value]));
            context.mutation++;
            context.pending++;
            setData((previous) =>
                previous.chatId === chatId
                    ? { ...previous, switches: { ...previous.switches, ...patch } }
                    : previous
            );
            try {
                await updateWebpageSwitchesForChat(chatId, patch, { tabs });
                return context.active;
            } catch (error) {
                notify(t('composer_sources_save_error'), { type: 'error' });
                return false;
            } finally {
                context.pending--;
                if (context.active && !context.pending) void context.refresh();
            }
        },
        [chatId]
    );
    const visible = data.chatId === chatId && available ? data : empty;
    return {
        ...visible,
        available,
        selected: visible.tabs.filter((tab) => visible.switches[tab.id] === true),
        toggle,
        refresh,
    };
}
