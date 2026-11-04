import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { desktopBrowserStore } from '../../platform/desktop-browser.js';
import { browserAdapter, isExtensionEnvironment } from '../../utils/storage-adapter.js';
import { getEnabledTabsContent, getWebpageSourceTabs } from '../../runtime/webpage/webpage-context.js';
import {
    getCachedWebpagesForChat,
    getWebpageSwitchesForChat,
    removeCachedWebpageSource,
    subscribeWebpageSwitches,
    updateWebpageSwitchesForChat,
    webpageCacheIdentity,
} from '../../utils/webpage-switches.js';
import { notify } from '../state/ui-store.js';
import { t } from '../../utils/i18n.js';

const empty = { tabs: [], current: null, groups: {}, switches: {}, loading: false, error: null };

export function useWebpageSources(chatId, menuOpen, autoAddCurrentPage = false) {
    const browser = useSyncExternalStore(desktopBrowserStore.subscribe, desktopBrowserStore.getSnapshot);
    const available = isExtensionEnvironment || !!browser.session;
    const [data, setData] = useState(empty);
    const cache = useRef(new Map());
    const sourceHeight = useRef(0);
    useLayoutEffect(() => {
        if (data.chatId === chatId) sourceHeight.current = document.querySelector('.composer-sources')?.getBoundingClientRect().height || 0;
    }, [data, chatId]);
    const owner = useRef(null);
    const refresh = useCallback(() => owner.current?.refresh(), []);
    useEffect(() => {
        if (!chatId) {
            setData(empty);
            return;
        }
        const context = { chatId, active: true, load: 0, mutation: 0, pending: 0, snapshotTimer: null };
        owner.current = context;
        context.refreshSnapshot = () => {
            if (!available || !context.active) return;
            clearTimeout(context.snapshotTimer);
            context.snapshotTimer = setTimeout(() => {
                if (context.active && !document.hidden) {
                    void getEnabledTabsContent(chatId)
                        .then(() => {
                            if (context.active) void context.refresh({ snapshot: false });
                        })
                        .catch(() => {});
                }
            }, 300);
        };
        // Keep geometry until the new chat's cached or fetched sources are ready.
        context.refresh = async ({ snapshot = true } = {}) => {
            const load = ++context.load,
                mutation = context.mutation;
            const current = () => context.active && load === context.load && mutation === context.mutation;
            try {
                if (!available) {
                    const cachedPages = await getCachedWebpagesForChat(chatId);
                    if (!current()) return;
                    const tabs = cachedPages.map((page) => ({
                        id: `cached:${webpageCacheIdentity(page.url)}`,
                        title: page.title,
                        url: page.url,
                        lastAccessed: page.updatedAt || 0,
                        cached: true,
                        tabId: page.tabId,
                    }));
                    const switches = Object.fromEntries(tabs.map((item) => [item.id, true]));
                    const next = {
                        chatId,
                        tabs,
                        current: null,
                        groups: {},
                        switches,
                        loading: false,
                        error: null,
                    };
                    cache.current.set(chatId, next);
                    setData(next);
                    return;
                }
                const [allTabs, tab, cachedPages] = await Promise.all([
                    browserAdapter.getAllTabs(),
                    browserAdapter.getCurrentTab(),
                    getCachedWebpagesForChat(chatId),
                ]);
                if (!current()) return;
                const currentTab = allTabs.find((item) => item.id === tab?.id) || tab;
                const switches = await getWebpageSwitchesForChat(chatId, {
                    currentTab,
                    initialize: autoAddCurrentPage,
                });
                const visibleUrls = new Set(allTabs.map((item) => webpageCacheIdentity(item.url)).filter(Boolean));
                const cachedTabs = cachedPages
                    .filter((page) => !visibleUrls.has(webpageCacheIdentity(page.url)))
                    .map((page) => ({
                        id: `cached:${webpageCacheIdentity(page.url)}`,
                        title: page.title,
                        url: page.url,
                        lastAccessed: page.updatedAt || 0,
                        cached: true,
                        tabId: page.tabId,
                    }));
                const tabs = getWebpageSourceTabs([...allTabs, ...cachedTabs], switches);
                const sourceSwitches = { ...switches };
                const cachedUrls = new Set(cachedPages.map((page) => webpageCacheIdentity(page.url)).filter(Boolean));
                for (const item of tabs) {
                    if (cachedUrls.has(webpageCacheIdentity(item.url))) sourceSwitches[item.id] = true;
                }
                const groupIds = [...new Set(tabs.map((tab) => tab.groupId).filter((id) => id >= 0))];
                const groups = await browserAdapter.getTabGroupsByIds(groupIds).catch(() => ({}));
                if (current()) {
                    const next = {
                        chatId,
                        tabs,
                        current: tabs.find((item) => item.id === tab?.id || item.url === tab?.url) || null,
                        groups,
                        switches: sourceSwitches,
                        loading: false,
                        error: null,
                    };
                    cache.current.set(chatId, next);
                    setData(next);
                    if (snapshot && next.tabs.some((item) => next.switches[item.id] === true)) context.refreshSnapshot();
                }
            } catch (error) {
                if (current()) {
                    const cachedPages = await getCachedWebpagesForChat(chatId).catch(() => []);
                    if (!current()) return;
                    const cachedTabs = cachedPages.map((page) => ({
                        id: `cached:${webpageCacheIdentity(page.url)}`,
                        title: page.title,
                        url: page.url,
                        lastAccessed: page.updatedAt || 0,
                        cached: true,
                        tabId: page.tabId,
                    }));
                    const next = cachedPages.length
                        ? {
                              chatId,
                              tabs: cachedTabs,
                              current: null,
                              groups: {},
                              switches: Object.fromEntries(cachedTabs.map((tab) => [tab.id, true])),
                              loading: false,
                              error: null,
                          }
                        : { ...(cache.current.get(chatId) || empty), chatId, loading: false, error };
                    cache.current.set(chatId, next);
                    setData(next);
                }
            }
        };
        const refreshVisible = () => {
            if (!document.hidden) {
                void context.refresh();
                context.refreshSnapshot();
            }
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
            clearTimeout(context.snapshotTimer);
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
            const cachedOnlyTabs = tabs.filter((tab) => tab.cached);
            const realTabs = tabs.filter((tab) => !tab.cached && Number.isSafeInteger(Number(tab.id)));
            const patch = Object.fromEntries([
                ...realTabs.map((tab) => [tab.id, value]),
                ...cachedOnlyTabs.map((tab) => [tab.id, value]),
            ]);
            context.mutation++;
            context.pending++;
            setData((previous) => {
                if (previous.chatId !== chatId) return previous;
                const next = { ...previous, switches: { ...previous.switches, ...patch } };
                cache.current.set(chatId, next);
                return next;
            });
            try {
                if (!value && cachedOnlyTabs.length) {
                    await Promise.all(cachedOnlyTabs.map((tab) => removeCachedWebpageSource(chatId, tab)));
                }
                if (realTabs.length) {
                    await updateWebpageSwitchesForChat(
                        chatId,
                        Object.fromEntries(realTabs.map((tab) => [tab.id, value])),
                        { tabs: realTabs }
                    );
                }
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
    const cached = cache.current.get(chatId);
    const switching = !!chatId && data.chatId !== chatId;
    const visible = data.chatId === chatId ? data : cached || { ...empty, loading: !!chatId };
    const previousHasSources = data.tabs.some((tab) => data.switches[tab.id] === true);
    const reserveSources = switching && !cached && previousHasSources;
    return {
        ...visible,
        available,
        reserveSources,
        reserveHeight: sourceHeight.current,
        selected: visible.tabs.filter((tab) => visible.switches[tab.id] === true),
        toggle,
        refresh,
    };
}
