import { storageAdapter, browserAdapter } from '../utils/storage-adapter.js';
import { chatManager } from '../utils/chat-manager.js';
import { t } from '../utils/i18n.js';
import { getWebpageSwitchesForChat, setWebpageSwitchesForChat } from '../utils/webpage-switches.js';

const YT_TRANSCRIPT_KEY_PREFIX = 'cerebr_youtube_transcript_v1_';

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

async function populateWebpageContentMenu(webpageContentMenu) {
    webpageContentMenu.innerHTML = `<div class="webpage-menu-loading">${t('webpage_tabs_loading')}</div>`;
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

    const hasAnyGroups = finalTabs.some(isGroupedTab);

    if (!hasAnyGroups) {
        for (const tab of finalTabs) {
            if (!tab.title || !tab.url) continue;
            const { item } = createTabMenuItem({ tab, switches, currentTabId });
            webpageContentMenu.appendChild(item);
        }
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

    for (const group of sortedGroups) {
        const groupWrapper = document.createElement('div');
        groupWrapper.className = 'webpage-menu-group';

        const header = document.createElement('div');
        header.className = 'webpage-menu-group-header';

        const meta = document.createElement('div');
        meta.className = 'webpage-menu-group-meta';

        const colorDot = document.createElement('span');
        colorDot.className = 'webpage-menu-group-color';
        const groupInfo = group.id !== -1 ? groupsById?.[group.id] : null;
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

        const updateGroupSwitchState = () => {
            const total = tabSwitchInputs.length;
            const enabledCount = tabSwitchInputs.filter(input => input.checked).length;
            groupSwitchInput.indeterminate = enabledCount > 0 && enabledCount < total;
            groupSwitchInput.checked = total > 0 && enabledCount === total;
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

        header.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.target.closest('.switch')) return;
            void toggleGroup();
        });

        header.appendChild(meta);
        header.appendChild(groupSwitchLabel);
        groupWrapper.appendChild(header);

        for (const tab of group.tabs) {
            const { item, switchInput } = createTabMenuItem({
                tab,
                switches,
                currentTabId,
                indent: group.id !== -1,
                onAfterToggle: () => updateGroupSwitchState()
            });
            tabSwitchInputs.push(switchInput);
            groupWrapper.appendChild(item);
        }

        updateGroupSwitchState();
        webpageContentMenu.appendChild(groupWrapper);
    }
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
    webpageQAContainer.addEventListener('click', async (e) => {
        e.stopPropagation();

        if (webpageContentMenu.classList.contains('visible')) {
            webpageContentMenu.classList.remove('visible');
            webpageContentMenu.style.visibility = 'hidden'; // 确保隐藏
            return;
        }

        // 核心修复：先隐藏，计算完位置再显示，防止闪烁
        webpageContentMenu.style.visibility = 'hidden';
        webpageContentMenu.classList.add('visible');

        await populateWebpageContentMenu(webpageContentMenu);
        const rect = webpageQAContainer.getBoundingClientRect();
        const menuHeight = webpageContentMenu.offsetHeight;
        const windowHeight = window.innerHeight;

        let top = rect.top;
        if (top + menuHeight > windowHeight) {
            top = windowHeight - menuHeight - 150; // 向上调整
        }

        webpageContentMenu.style.top = `${Math.max(8, top)}px`;
        webpageContentMenu.style.left = `${rect.right + 8}px`;

        // 在正确的位置上使其可见
        webpageContentMenu.style.visibility = 'visible';
    });
}
