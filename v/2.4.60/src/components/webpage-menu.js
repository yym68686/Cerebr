import { storageAdapter, browserAdapter } from '../utils/storage-adapter.js';
import { chatManager } from '../utils/chat-manager.js';
import { t } from '../utils/i18n.js';
import { getWebpageSwitchesForChat, setWebpageSwitchesForChat } from '../utils/webpage-switches.js';

const YT_TRANSCRIPT_KEY_PREFIX = 'cerebr_youtube_transcript_v1_';
const collapsedGroupStates = new Map();
const DEFAULT_WEBPAGE_MENU_SEARCH_HEIGHT = 46;

function isYouTubeHost(hostname) {
    if (!hostname) return false;
    const host = String(hostname).toLowerCase();
    return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
}

function getYouTubeVideoIdFromUrl(urlString) {
    try {
        const url = new URL(urlString);
        if (!isYouTubeHost(url.hostname)) return null;

        if (url.pathname === '/watch') return url.searchParams.get('v');
        if (url.hostname === 'youtu.be') {
            const id = url.pathname.replace(/^\/+/, '').split('/')[0];
            return id || null;
        }
        const shortsMatch = url.pathname.match(/^\/shorts\/([^/?#]+)/);
        if (shortsMatch) return shortsMatch[1];
        const embedMatch = url.pathname.match(/^\/embed\/([^/?#]+)/);
        if (embedMatch) return embedMatch[1];
        return null;
    } catch {
        return null;
    }
}

function sanitizeKeyPart(value) {
    return String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

function makeYouTubeTranscriptKey({ videoId, lang }) {
    const vid = sanitizeKeyPart(videoId);
    const language = sanitizeKeyPart(lang || 'und');
    return `${YT_TRANSCRIPT_KEY_PREFIX}${vid}_${language}`;
}

async function loadYouTubeTranscriptText(key) {
    if (!key) return null;
    const result = await storageAdapter.get(key);
    const payload = result?.[key];
    if (!payload) return null;
    if (typeof payload === 'string') return payload;
    return payload?.text || null;
}

async function saveYouTubeTranscript({ key, videoId, lang, text }) {
    if (!key || !text) return;
    await storageAdapter.set({
        [key]: {
            v: 1,
            videoId,
            lang: lang || null,
            text,
            updatedAt: Date.now()
        }
    });
}

function getTabSwitchChecked(switches, tabId, currentTabId) {
    if (switches && switches[tabId] !== undefined) return switches[tabId];
    if (typeof currentTabId === 'number' && tabId === currentTabId) return true;
    return false;
}

function isGroupedTab(tab) {
    return typeof tab?.groupId === 'number' && Number.isFinite(tab.groupId) && tab.groupId !== -1;
}

function getGroupedTabIds(tabs) {
    return [...new Set(tabs.map(t => t?.groupId).filter((id) => typeof id === 'number' && Number.isFinite(id) && id !== -1))];
}

function getGroupStateKey(group, groupInfo) {
    if (!group || group.id === -1) return 'ungrouped';
    const windowId = groupInfo?.windowId ?? group.tabs?.[0]?.windowId ?? 'unknown';
    return `${windowId}:${group.id}`;
}

function normalizeWebpageMenuSearchText(value) {
    return String(value || '').trim().toLocaleLowerCase();
}

function createWebpageMenuSearchElements() {
    const searchWrapper = document.createElement('div');
    searchWrapper.className = 'webpage-menu-search';

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'webpage-menu-search-input';
    searchInput.autocomplete = 'off';
    searchInput.spellcheck = false;
    searchInput.placeholder = t('webpage_tabs_search_placeholder');
    searchInput.setAttribute('aria-label', t('webpage_tabs_search_placeholder'));

    searchInput.addEventListener('click', (e) => e.stopPropagation());
    searchInput.addEventListener('keydown', (e) => e.stopPropagation());

    const emptyState = document.createElement('div');
    emptyState.className = 'webpage-menu-empty webpage-menu-empty--search';
    emptyState.textContent = t('webpage_tabs_no_match');
    emptyState.hidden = true;

    searchWrapper.appendChild(searchInput);
    return { searchWrapper, searchInput, emptyState };
}

function cleanupWebpageMenuSearchVisibility(webpageContentMenu) {
    if (!webpageContentMenu) return;

    if (typeof webpageContentMenu.__searchVisibilityCleanup === 'function') {
        webpageContentMenu.__searchVisibilityCleanup();
    }
    if (webpageContentMenu.__searchTransitionRaf) {
        cancelAnimationFrame(webpageContentMenu.__searchTransitionRaf);
    }
    if (webpageContentMenu.__searchTransitionRaf2) {
        cancelAnimationFrame(webpageContentMenu.__searchTransitionRaf2);
    }

    webpageContentMenu.__searchVisibilityCleanup = null;
    webpageContentMenu.__searchTransitionRaf = 0;
    webpageContentMenu.__searchTransitionRaf2 = 0;
    webpageContentMenu.__searchLastScrollTop = 0;
    webpageContentMenu.__searchIgnoreScrollUntil = 0;
    webpageContentMenu.__searchTouchY = null;
    webpageContentMenu.classList.remove('search-visibility-ready', 'is-search-booting', 'is-search-visible', 'has-active-search', 'is-search-focused');
    webpageContentMenu.style.removeProperty('--webpage-menu-search-height');
}

function prepareWebpageMenuSearchVisibility(webpageContentMenu, searchHeight = DEFAULT_WEBPAGE_MENU_SEARCH_HEIGHT) {
    if (!webpageContentMenu) return;

    if (webpageContentMenu.__searchTransitionRaf) {
        cancelAnimationFrame(webpageContentMenu.__searchTransitionRaf);
        webpageContentMenu.__searchTransitionRaf = 0;
    }
    if (webpageContentMenu.__searchTransitionRaf2) {
        cancelAnimationFrame(webpageContentMenu.__searchTransitionRaf2);
        webpageContentMenu.__searchTransitionRaf2 = 0;
    }

    webpageContentMenu.__searchLastScrollTop = webpageContentMenu.scrollTop;
    webpageContentMenu.__searchIgnoreScrollUntil = 0;
    webpageContentMenu.__searchTouchY = null;
    webpageContentMenu.style.setProperty('--webpage-menu-search-height', `${searchHeight}px`);
    webpageContentMenu.classList.add('search-visibility-ready', 'is-search-booting');
    webpageContentMenu.classList.remove('is-search-visible', 'has-active-search', 'is-search-focused');
}

function armWebpageMenuSearchVisibilityTransitions(webpageContentMenu) {
    if (!webpageContentMenu) return;

    if (webpageContentMenu.__searchTransitionRaf) {
        cancelAnimationFrame(webpageContentMenu.__searchTransitionRaf);
    }
    if (webpageContentMenu.__searchTransitionRaf2) {
        cancelAnimationFrame(webpageContentMenu.__searchTransitionRaf2);
    }

    webpageContentMenu.__searchTransitionRaf = requestAnimationFrame(() => {
        webpageContentMenu.__searchTransitionRaf = 0;
        webpageContentMenu.__searchTransitionRaf2 = requestAnimationFrame(() => {
            webpageContentMenu.__searchTransitionRaf2 = 0;
            if (!webpageContentMenu.classList.contains('visible')) return;
            webpageContentMenu.classList.remove('is-search-booting');
        });
    });
}

function getWebpageMenuSearchHeight(webpageContentMenu) {
    const value = webpageContentMenu?.style?.getPropertyValue('--webpage-menu-search-height') || '';
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function setWebpageMenuSearchVisibility({ webpageContentMenu, visible, onLayoutChange } = {}) {
    if (!webpageContentMenu?.classList.contains('search-visibility-ready')) return;

    const prevVisible = webpageContentMenu.classList.contains('is-search-visible');
    const nextVisible = !!visible;
    if (prevVisible === nextVisible) return;

    const prevScrollTop = webpageContentMenu.scrollTop;
    const searchHeight = getWebpageMenuSearchHeight(webpageContentMenu);

    webpageContentMenu.classList.toggle('is-search-visible', nextVisible);

    if (searchHeight > 0 && prevScrollTop > 0) {
        const offset = nextVisible ? searchHeight : -searchHeight;
        webpageContentMenu.scrollTop = Math.max(0, prevScrollTop + offset);
    }
    webpageContentMenu.__searchIgnoreScrollUntil = Date.now() + 120;
    webpageContentMenu.__searchLastScrollTop = webpageContentMenu.scrollTop;

    if (typeof onLayoutChange === 'function') {
        onLayoutChange();
    }
}

function setupWebpageMenuSearchVisibility({ webpageContentMenu, searchWrapper, searchInput, onLayoutChange } = {}) {
    if (!webpageContentMenu || !searchWrapper || !searchInput) return;

    const searchInputHeight = Math.ceil(searchInput.getBoundingClientRect().height || 0);
    const searchWrapperHeight = Math.ceil(searchWrapper.getBoundingClientRect().height || 0);
    const measuredHeight = Math.max(searchWrapperHeight, searchInputHeight + 12, 40);
    webpageContentMenu.style.setProperty('--webpage-menu-search-height', `${measuredHeight}px`);
    webpageContentMenu.classList.add('search-visibility-ready');
    webpageContentMenu.__searchLastScrollTop = webpageContentMenu.scrollTop;
    webpageContentMenu.__searchIgnoreScrollUntil = 0;

    const isSearchPinned = () => (
        webpageContentMenu.classList.contains('has-active-search') ||
        webpageContentMenu.classList.contains('is-search-focused')
    );

    const updateSearchVisibilityByDelta = (delta) => {
        if (Math.abs(delta) < 6) return;
        if (delta > 0) {
            if (!isSearchPinned()) {
                setWebpageMenuSearchVisibility({ webpageContentMenu, visible: false, onLayoutChange });
            }
            return;
        }
        setWebpageMenuSearchVisibility({ webpageContentMenu, visible: true, onLayoutChange });
    };

    const syncActiveSearchState = () => {
        const hasActiveQuery = !!normalizeWebpageMenuSearchText(searchInput.value);
        webpageContentMenu.classList.toggle('has-active-search', hasActiveQuery);
        if (hasActiveQuery) {
            setWebpageMenuSearchVisibility({ webpageContentMenu, visible: true, onLayoutChange });
        }
    };

    const handleWheel = (event) => {
        updateSearchVisibilityByDelta(event.deltaY);
    };

    const handleScroll = () => {
        const currentScrollTop = webpageContentMenu.scrollTop;
        if ((webpageContentMenu.__searchIgnoreScrollUntil || 0) > Date.now()) {
            webpageContentMenu.__searchLastScrollTop = currentScrollTop;
            return;
        }
        const delta = currentScrollTop - (webpageContentMenu.__searchLastScrollTop || 0);
        webpageContentMenu.__searchLastScrollTop = currentScrollTop;
        updateSearchVisibilityByDelta(delta);
    };

    const handleTouchStart = (event) => {
        webpageContentMenu.__searchTouchY = event.touches?.[0]?.clientY ?? null;
    };

    const handleTouchMove = (event) => {
        const currentTouchY = event.touches?.[0]?.clientY;
        if (typeof currentTouchY !== 'number') return;

        const prevTouchY = webpageContentMenu.__searchTouchY;
        webpageContentMenu.__searchTouchY = currentTouchY;
        if (typeof prevTouchY !== 'number') return;

        updateSearchVisibilityByDelta(prevTouchY - currentTouchY);
    };

    const handleTouchEnd = () => {
        webpageContentMenu.__searchTouchY = null;
    };

    const handleFocus = () => {
        webpageContentMenu.classList.add('is-search-focused');
        setWebpageMenuSearchVisibility({ webpageContentMenu, visible: true, onLayoutChange });
    };

    const handleBlur = () => {
        webpageContentMenu.classList.remove('is-search-focused');
        syncActiveSearchState();
    };

    const handleInput = () => {
        syncActiveSearchState();
    };

    webpageContentMenu.addEventListener('wheel', handleWheel, { passive: true });
    webpageContentMenu.addEventListener('scroll', handleScroll, { passive: true });
    webpageContentMenu.addEventListener('touchstart', handleTouchStart, { passive: true });
    webpageContentMenu.addEventListener('touchmove', handleTouchMove, { passive: true });
    webpageContentMenu.addEventListener('touchend', handleTouchEnd, { passive: true });
    searchInput.addEventListener('focus', handleFocus);
    searchInput.addEventListener('blur', handleBlur);
    searchInput.addEventListener('input', handleInput);

    webpageContentMenu.__searchVisibilityCleanup = () => {
        webpageContentMenu.removeEventListener('wheel', handleWheel);
        webpageContentMenu.removeEventListener('scroll', handleScroll);
        webpageContentMenu.removeEventListener('touchstart', handleTouchStart);
        webpageContentMenu.removeEventListener('touchmove', handleTouchMove);
        webpageContentMenu.removeEventListener('touchend', handleTouchEnd);
        searchInput.removeEventListener('focus', handleFocus);
        searchInput.removeEventListener('blur', handleBlur);
        searchInput.removeEventListener('input', handleInput);
        webpageContentMenu.__searchLastScrollTop = 0;
        webpageContentMenu.__searchIgnoreScrollUntil = 0;
        webpageContentMenu.__searchTouchY = null;
        webpageContentMenu.classList.remove('search-visibility-ready', 'is-search-booting', 'is-search-visible', 'has-active-search', 'is-search-focused');
        webpageContentMenu.style.removeProperty('--webpage-menu-search-height');
    };
}

function getWebpageMenuViewportBounds() {
    const vv = window.visualViewport;
    const top = vv?.offsetTop ?? 0;
    const left = vv?.offsetLeft ?? 0;
    const width = vv?.width ?? window.innerWidth;
    const height = vv?.height ?? window.innerHeight;

    return {
        top,
        left,
        right: left + width,
        bottom: top + height
    };
}

function positionWebpageContentMenu({ webpageQAContainer, webpageContentMenu }) {
    if (!webpageQAContainer?.isConnected || !webpageContentMenu?.isConnected) return;
    if (!webpageContentMenu.classList.contains('visible')) return;

    const rect = webpageQAContainer.getBoundingClientRect();
    const viewport = getWebpageMenuViewportBounds();
    const inputRect = document.getElementById('input-container')?.getBoundingClientRect() || null;
    const margin = 8;
    const horizontalGap = 8;
    const maxMenuHeight = 300;

    const bottomLimit = Math.min(
        viewport.bottom - margin,
        (inputRect?.top ?? viewport.bottom) - margin
    );
    const availableHeight = Math.max(96, Math.floor(bottomLimit - viewport.top - margin));
    webpageContentMenu.style.maxHeight = `${Math.min(maxMenuHeight, availableHeight)}px`;

    const menuWidth = webpageContentMenu.offsetWidth;
    const menuHeight = webpageContentMenu.offsetHeight;
    webpageContentMenu.style.width = `${menuWidth}px`;

    let top = rect.top;
    if (top + menuHeight > bottomLimit) {
        top = bottomLimit - menuHeight;
    }
    top = Math.max(viewport.top + margin, top);

    let left = rect.right + horizontalGap;
    if (left + menuWidth > viewport.right - margin) {
        left = Math.max(viewport.left + margin, viewport.right - margin - menuWidth);
    }

    webpageContentMenu.style.top = `${Math.round(top)}px`;
    webpageContentMenu.style.left = `${Math.round(left)}px`;
}

function scheduleWebpageContentMenuPosition({ webpageQAContainer, webpageContentMenu }) {
    if (!webpageContentMenu) return;
    if (webpageContentMenu.__cerebrPositionRaf) {
        cancelAnimationFrame(webpageContentMenu.__cerebrPositionRaf);
    }

    webpageContentMenu.__cerebrPositionRaf = requestAnimationFrame(() => {
        webpageContentMenu.__cerebrPositionRaf = 0;
        positionWebpageContentMenu({ webpageQAContainer, webpageContentMenu });
    });
}

function createSwitchElements({ id, initialChecked, onToggle }) {
    const switchLabel = document.createElement('label');
    switchLabel.className = 'switch';
    switchLabel.setAttribute('for', id);

    switchLabel.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    const switchInput = document.createElement('input');
    switchInput.type = 'checkbox';
    switchInput.id = id;
    switchInput.checked = !!initialChecked;

    if (typeof onToggle === 'function') {
        switchInput.addEventListener('change', onToggle);
    }

    const slider = document.createElement('span');
    slider.className = 'slider';

    switchLabel.appendChild(switchInput);
    switchLabel.appendChild(slider);

    return { switchLabel, switchInput };
}

function createTabMenuItem({ tab, switches, currentTabId, onAfterToggle, indent = false }) {
    const item = document.createElement('div');
    item.className = indent ? 'webpage-menu-item webpage-menu-item--indented' : 'webpage-menu-item';

    if (tab.favIconUrl) {
        const favicon = document.createElement('img');
        favicon.src = tab.favIconUrl;
        favicon.className = 'favicon';
        item.appendChild(favicon);
    }

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = tab.title;
    title.title = tab.title;

    const { switchLabel, switchInput } = createSwitchElements({
        id: `webpage-switch-${tab.id}`,
        initialChecked: getTabSwitchChecked(switches, tab.id, currentTabId),
        onToggle: async (e) => {
            const isChecked = e.target.checked;
            const activeChatId = chatManager.getCurrentChat()?.id || null;
            const currentSwitches = await getWebpageSwitchesForChat(activeChatId);
            const newSwitches = { ...currentSwitches, [tab.id]: isChecked };
            await setWebpageSwitchesForChat(activeChatId, newSwitches);

            if (isChecked) {
                const isConnected = await browserAdapter.isTabConnected(tab.id);
                if (!isConnected) {
                    await browserAdapter.reloadTab(tab.id);
                    console.log(`Webpage-menu: populateWebpageContentMenu Reloaded tab ${tab.id} ${tab.title} (${tab.url}).`);
                }
            }

            if (typeof onAfterToggle === 'function') onAfterToggle();
        }
    });

    item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.target.closest('.switch')) return;
        switchInput.checked = !switchInput.checked;
        switchInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    item.appendChild(title);
    item.appendChild(switchLabel);

    return { item, switchInput };
}

// 过滤重复的标签页，只保留每个 URL 最新访问的标签页
function getUniqueTabsByUrl(tabs) {
    const seenUrls = new Set();
    return tabs.filter(tab => {
        if (!tab.url || seenUrls.has(tab.url)) {
            return false;
        }
        seenUrls.add(tab.url);
        return true;
    });
}

async function populateWebpageContentMenu(webpageContentMenu, { onLayoutChange } = {}) {
    webpageContentMenu.innerHTML = `<div class="webpage-menu-loading">${t('webpage_tabs_loading')}</div>`;
    webpageContentMenu.__searchQueryNormalized = '';
    cleanupWebpageMenuSearchVisibility(webpageContentMenu);
    let allTabs = await browserAdapter.getAllTabs();
    const currentTab = await browserAdapter.getCurrentTab();
    const activeChatId = chatManager.getCurrentChat()?.id || null;

    // 1. 过滤掉浏览器自身的特殊页面
    allTabs = allTabs.filter(tab => tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://') && !tab.url.startsWith('about:'));

    // 2. 按照 lastAccessed 时间降序排序
    allTabs.sort((a, b) => b.lastAccessed - a.lastAccessed);

    // 2. 过滤掉重复的 URL
    const finalTabs = getUniqueTabsByUrl(allTabs);

    const switches = await getWebpageSwitchesForChat(activeChatId);
    const currentTabId = currentTab?.id;

    webpageContentMenu.innerHTML = '';

    if (finalTabs.length === 0) {
        webpageContentMenu.innerHTML = `<div class="webpage-menu-empty">${t('webpage_tabs_empty')}</div>`;
        return;
    }

    const { searchWrapper, searchInput, emptyState } = createWebpageMenuSearchElements();
    const resultsContainer = document.createElement('div');
    resultsContainer.className = 'webpage-menu-results';

    prepareWebpageMenuSearchVisibility(webpageContentMenu);
    webpageContentMenu.appendChild(searchWrapper);
    webpageContentMenu.appendChild(resultsContainer);
    webpageContentMenu.appendChild(emptyState);
    setupWebpageMenuSearchVisibility({ webpageContentMenu, searchWrapper, searchInput, onLayoutChange });

    const hasAnyGroups = finalTabs.some(isGroupedTab);

    if (!hasAnyGroups) {
        const searchEntries = [];
        for (const tab of finalTabs) {
            if (!tab.title || !tab.url) continue;
            const { item } = createTabMenuItem({ tab, switches, currentTabId });
            searchEntries.push({
                item,
                searchText: normalizeWebpageMenuSearchText(tab.title)
            });
            resultsContainer.appendChild(item);
        }

        const applySearchFilter = (rawQuery) => {
            const queryNormalized = normalizeWebpageMenuSearchText(rawQuery);
            webpageContentMenu.__searchQueryNormalized = queryNormalized;

            let visibleCount = 0;
            searchEntries.forEach(({ item, searchText }) => {
                const isVisible = !queryNormalized || searchText.includes(queryNormalized);
                item.hidden = !isVisible;
                if (isVisible) visibleCount++;
            });

            emptyState.hidden = visibleCount > 0;
        };

        searchInput.addEventListener('input', () => {
            applySearchFilter(searchInput.value);
            if (typeof onLayoutChange === 'function') onLayoutChange();
        });

        applySearchFilter('');
        return;
    }

    const groupIds = getGroupedTabIds(finalTabs);
    let groupsById = {};
    try {
        groupsById = await browserAdapter.getTabGroupsByIds(groupIds);
    } catch {
        groupsById = {};
    }

    const groups = new Map(); // groupId -> { id, tabs, maxLastAccessed }
    for (const tab of finalTabs) {
        if (!tab.title || !tab.url) continue;
        const groupId = isGroupedTab(tab) ? tab.groupId : -1;
        const existing = groups.get(groupId) || { id: groupId, tabs: [], maxLastAccessed: -1 };
        existing.tabs.push(tab);
        existing.maxLastAccessed = Math.max(existing.maxLastAccessed, tab.lastAccessed || 0);
        groups.set(groupId, existing);
    }

    const sortedGroups = [...groups.values()].sort((a, b) => {
        if (a.id === -1 && b.id !== -1) return 1;
        if (b.id === -1 && a.id !== -1) return -1;
        return (b.maxLastAccessed || 0) - (a.maxLastAccessed || 0);
    });

    const ensureTabsConnected = (tabsToEnsure) => {
        const queue = tabsToEnsure.slice();
        const limit = 4;
        let active = 0;

        const runNext = () => {
            while (active < limit && queue.length > 0) {
                const tab = queue.shift();
                active++;
                (async () => {
                    try {
                        const isConnected = await browserAdapter.isTabConnected(tab.id);
                        if (!isConnected) {
                            await browserAdapter.reloadTab(tab.id);
                            console.log(`Webpage-menu: Group toggle reloaded tab ${tab.id} ${tab.title} (${tab.url}).`);
                        }
                    } catch {
                        // ignore
                    } finally {
                        active--;
                        runNext();
                    }
                })();
            }
        };
        runNext();
    };

    const groupFilterEntries = [];

    for (const group of sortedGroups) {
        const groupWrapper = document.createElement('div');
        groupWrapper.className = 'webpage-menu-group';

        const header = document.createElement('div');
        header.className = 'webpage-menu-group-header';

        const groupInfo = group.id !== -1 ? groupsById?.[group.id] : null;
        const groupStateKey = getGroupStateKey(group, groupInfo);
        const initialCollapsed = collapsedGroupStates.has(groupStateKey)
            ? !!collapsedGroupStates.get(groupStateKey)
            : (group.id !== -1 ? !!groupInfo?.collapsed : false);

        const itemsContainer = document.createElement('div');
        itemsContainer.className = 'webpage-menu-group-items';
        itemsContainer.id = group.id === -1 ? 'webpage-group-items-ungrouped' : `webpage-group-items-${group.id}`;

        const groupTrigger = document.createElement('button');
        groupTrigger.type = 'button';
        groupTrigger.className = 'webpage-menu-group-trigger';
        groupTrigger.setAttribute('aria-controls', itemsContainer.id);

        const meta = document.createElement('div');
        meta.className = 'webpage-menu-group-meta';

        const colorDot = document.createElement('span');
        colorDot.className = 'webpage-menu-group-color';
        if (groupInfo?.color) {
            colorDot.style.backgroundColor = groupInfo.color;
        } else {
            colorDot.classList.add('is-hidden');
        }

        const groupTitle = document.createElement('span');
        groupTitle.className = 'webpage-menu-group-title';
        if (group.id === -1) {
            groupTitle.textContent = t('webpage_group_ungrouped');
        } else {
            const title = (groupInfo?.title || '').trim();
            groupTitle.textContent = title ? title : `${t('webpage_group_default_name')} ${group.id}`;
        }
        const normalizedGroupSearchText = normalizeWebpageMenuSearchText(groupTitle.textContent);
        groupTitle.title = groupTitle.textContent;

        const groupCount = document.createElement('span');
        groupCount.className = 'webpage-menu-group-count';
        groupCount.textContent = `(${group.tabs.length})`;

        meta.appendChild(colorDot);
        meta.appendChild(groupTitle);
        meta.appendChild(groupCount);

        const tabSwitchInputs = [];

        const groupSwitchId = group.id === -1 ? 'webpage-group-switch-ungrouped' : `webpage-group-switch-${group.id}`;
        const { switchLabel: groupSwitchLabel, switchInput: groupSwitchInput } = createSwitchElements({
            id: groupSwitchId,
            initialChecked: false
        });
        groupSwitchLabel.classList.add('webpage-menu-group-switch');

        const updateGroupSwitchState = () => {
            const total = tabSwitchInputs.length;
            const enabledCount = tabSwitchInputs.filter(input => input.checked).length;
            groupSwitchInput.indeterminate = enabledCount > 0 && enabledCount < total;
            groupSwitchInput.checked = total > 0 && enabledCount === total;
        };

        const syncGroupCollapsedState = () => {
            const isSearchActive = !!webpageContentMenu.__searchQueryNormalized;
            const isCollapsed = !!collapsedGroupStates.get(groupStateKey) && !isSearchActive;
            groupWrapper.classList.toggle('is-collapsed', isCollapsed);
            groupTrigger.setAttribute('aria-expanded', String(!isCollapsed));
            itemsContainer.setAttribute('aria-hidden', String(isCollapsed));
        };

        const applyGroupCollapsedState = (collapsed, { notifyLayout = true } = {}) => {
            collapsedGroupStates.set(groupStateKey, !!collapsed);
            syncGroupCollapsedState();
            if (notifyLayout && typeof onLayoutChange === 'function') {
                onLayoutChange();
            }
        };

        const setGroupSwitchChecked = async (checked) => {
            const activeChatId = chatManager.getCurrentChat()?.id || null;
            const currentSwitches = await getWebpageSwitchesForChat(activeChatId);
            const newSwitches = { ...currentSwitches };
            for (const tab of group.tabs) {
                newSwitches[tab.id] = checked;
            }
            await setWebpageSwitchesForChat(activeChatId, newSwitches);

            tabSwitchInputs.forEach((input) => {
                input.checked = checked;
            });
            updateGroupSwitchState();

            if (checked) {
                ensureTabsConnected(group.tabs);
            }
        };

        const toggleGroup = async () => {
            const total = tabSwitchInputs.length;
            const enabledCount = tabSwitchInputs.filter(input => input.checked).length;
            const shouldEnable = enabledCount !== total;
            await setGroupSwitchChecked(shouldEnable);
        };

        groupSwitchInput.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            void toggleGroup();
        });

        groupTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            if (webpageContentMenu.__searchQueryNormalized) return;
            applyGroupCollapsedState(!groupWrapper.classList.contains('is-collapsed'));
        });

        header.addEventListener('click', (e) => {
            if (e.target.closest('.switch')) return;
            if (e.target.closest('.webpage-menu-group-trigger')) return;
            e.stopPropagation();
            if (webpageContentMenu.__searchQueryNormalized) return;
            applyGroupCollapsedState(!groupWrapper.classList.contains('is-collapsed'));
        });

        groupTrigger.appendChild(meta);
        header.appendChild(groupTrigger);
        header.appendChild(groupSwitchLabel);
        groupWrapper.appendChild(header);
        groupWrapper.appendChild(itemsContainer);

        const tabSearchEntries = [];
        for (const tab of group.tabs) {
            const { item, switchInput } = createTabMenuItem({
                tab,
                switches,
                currentTabId,
                indent: group.id !== -1,
                onAfterToggle: () => updateGroupSwitchState()
            });
            tabSwitchInputs.push(switchInput);
            tabSearchEntries.push({
                item,
                searchText: normalizeWebpageMenuSearchText(tab.title)
            });
            itemsContainer.appendChild(item);
        }

        updateGroupSwitchState();
        applyGroupCollapsedState(initialCollapsed, { notifyLayout: false });
        groupFilterEntries.push({
            groupWrapper,
            groupCount,
            totalCount: group.tabs.length,
            groupSearchText: normalizedGroupSearchText,
            tabEntries: tabSearchEntries,
            syncGroupCollapsedState
        });
        resultsContainer.appendChild(groupWrapper);
    }

    const applySearchFilter = (rawQuery) => {
        const queryNormalized = normalizeWebpageMenuSearchText(rawQuery);
        webpageContentMenu.__searchQueryNormalized = queryNormalized;

        let visibleGroupCount = 0;

        groupFilterEntries.forEach((entry) => {
            const isGroupMatched = !!queryNormalized && entry.groupSearchText.includes(queryNormalized);
            let visibleTabCount = 0;

            entry.tabEntries.forEach(({ item, searchText }) => {
                const isVisible = !queryNormalized || isGroupMatched || searchText.includes(queryNormalized);
                item.hidden = !isVisible;
                if (isVisible) visibleTabCount++;
            });

            const isGroupVisible = !queryNormalized || isGroupMatched || visibleTabCount > 0;
            entry.groupWrapper.hidden = !isGroupVisible;

            if (isGroupVisible) {
                entry.groupCount.textContent = !queryNormalized || isGroupMatched || visibleTabCount === entry.totalCount
                    ? `(${entry.totalCount})`
                    : `(${visibleTabCount}/${entry.totalCount})`;
                entry.syncGroupCollapsedState();
                visibleGroupCount++;
            } else {
                entry.groupCount.textContent = `(${entry.totalCount})`;
            }
        });

        emptyState.hidden = visibleGroupCount > 0;
    };

    searchInput.addEventListener('input', () => {
        applySearchFilter(searchInput.value);
        if (typeof onLayoutChange === 'function') onLayoutChange();
    });

    applySearchFilter('');
}

export async function getEnabledTabsContent() {
    let allTabs = await browserAdapter.getAllTabs();
    const currentTab = await browserAdapter.getCurrentTab();
    const activeChatId = chatManager.getCurrentChat()?.id || null;
    const switches = await getWebpageSwitchesForChat(activeChatId);
    let combinedContent = null;

    // 1. 过滤掉浏览器自身的特殊页面
    allTabs = allTabs.filter(tab => tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://') && !tab.url.startsWith('about:'));

    // 2. 按照 lastAccessed 时间降序排序
    allTabs.sort((a, b) => b.lastAccessed - a.lastAccessed);

    // 2. 过滤掉重复的 URL
    const finalTabs = getUniqueTabsByUrl(allTabs);

    for (const tab of finalTabs) {
        const isEnabled = switches && switches[tab.id] !== undefined ? switches[tab.id] : (tab.id === currentTab.id);
        if (isEnabled) {
            let isConnected = await browserAdapter.isTabConnected(tab.id);

            // 如果未连接，尝试重新加载并再次检查
            if (!isConnected) {
                await browserAdapter.reloadTab(tab.id);
                // 等待一段时间让标签页加载
                await new Promise(resolve => setTimeout(resolve, 1000));
                isConnected = await browserAdapter.isTabConnected(tab.id);
                console.log(`Webpage-menu: getEnabledTabsContent Reloaded tab ${tab.id} ${tab.title} (${tab.url}) isConnected: ${isConnected}.`);
            }

            if (isConnected) {
                try {
                    let pageData = null;
                    console.log(`Webpage-menu: getting content ${tab.id} ${tab.title} (${tab.url}).`);
                    pageData = await browserAdapter.sendMessage({
                        type: 'GET_PAGE_CONTENT_FROM_SIDEBAR',
                        tabId: tab.id,
                        skipWaitContent: true // 明确要求立即提取
                    });

                    if (pageData && (pageData.content || pageData.youtubeTranscript?.transcript)) {
                        let content = pageData.content || '';

                        // YouTube 字幕：优先使用本次提取结果；失败时回退到“当前对话已缓存的字幕”
                        const videoId = tab?.url ? getYouTubeVideoIdFromUrl(tab.url) : null;
                        const isYouTubeTab = (() => {
                            if (!tab?.url) return false;
                            try {
                                return isYouTubeHost(new URL(tab.url).hostname);
                            } catch {
                                return false;
                            }
                        })();

                        if (videoId && isYouTubeTab) {
                            const youtubeTranscript = pageData.youtubeTranscript;
                            let transcriptText = youtubeTranscript?.transcript || null;
                            const lang = youtubeTranscript?.lang || null;
                            const key = transcriptText
                                ? makeYouTubeTranscriptKey({ videoId, lang })
                                : (chatManager.getYouTubeTranscriptRef(activeChatId, videoId)?.key || null);

                            if (transcriptText && key) {
                                await saveYouTubeTranscript({ key, videoId, lang, text: transcriptText });
                                if (activeChatId) {
                                    chatManager.addYouTubeTranscriptRef(activeChatId, { key, videoId, lang });
                                }
                            }

                            if (!transcriptText && key) {
                                transcriptText = await loadYouTubeTranscriptText(key);
                            }

                            if (transcriptText) {
                                content = `${content}\n\n${t('youtube_transcript_prefix')}\n${transcriptText}`.trim();
                            }
                        }

                        if (!combinedContent) {
                            combinedContent = { pages: [] };
                        }
                        combinedContent.pages.push({
                            title: pageData.title,
                            url: tab.url,
                            content,
                            isCurrent: tab.id === currentTab.id
                        });
                    }
                } catch (e) {
                    console.warn(`Could not get content from tab ${tab.id} (${tab.url}): ${e}`);
                }
            }
        }
    }
    return combinedContent;
}

export function initWebpageMenu({ webpageQAContainer, webpageContentMenu }) {
    const repositionMenu = () => {
        scheduleWebpageContentMenuPosition({ webpageQAContainer, webpageContentMenu });
    };

    const stopMenuEventPropagation = (event) => {
        event.stopPropagation();
    };

    webpageContentMenu.addEventListener('wheel', stopMenuEventPropagation, { passive: true });
    webpageContentMenu.addEventListener('touchstart', stopMenuEventPropagation, { passive: true });
    webpageContentMenu.addEventListener('touchmove', stopMenuEventPropagation, { passive: true });
    webpageContentMenu.addEventListener('pointerdown', stopMenuEventPropagation, { passive: true });

    window.addEventListener('resize', repositionMenu);
    window.visualViewport?.addEventListener('resize', repositionMenu);
    window.visualViewport?.addEventListener('scroll', repositionMenu);

    webpageQAContainer.addEventListener('click', async (e) => {
        e.stopPropagation();

        if (webpageContentMenu.classList.contains('visible')) {
            webpageContentMenu.classList.remove('visible');
            webpageContentMenu.style.visibility = 'hidden'; // 确保隐藏
            return;
        }

        // 核心修复：先隐藏，计算完位置再显示，防止闪烁
        webpageContentMenu.style.visibility = 'hidden';
        webpageContentMenu.style.width = '';
        webpageContentMenu.style.maxHeight = '';
        webpageContentMenu.classList.add('visible');

        await populateWebpageContentMenu(webpageContentMenu, { onLayoutChange: repositionMenu });
        positionWebpageContentMenu({ webpageQAContainer, webpageContentMenu });

        // 在正确的位置上使其可见
        webpageContentMenu.style.visibility = 'visible';
        armWebpageMenuSearchVisibilityTransitions(webpageContentMenu);
    });
}
