import { storageAdapter, browserAdapter } from '../utils/storage-adapter.js';
import { chatManager } from '../utils/chat-manager.js';
import { t } from '../utils/i18n.js';

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

    // 1. 过滤掉浏览器自身的特殊页面
    allTabs = allTabs.filter(tab => tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://') && !tab.url.startsWith('about:'));

    // 2. 按照 lastAccessed 时间降序排序
    allTabs.sort((a, b) => b.lastAccessed - a.lastAccessed);

    // 2. 过滤掉重复的 URL
    const finalTabs = getUniqueTabsByUrl(allTabs);

    const { webpageSwitches: switches } = await storageAdapter.get('webpageSwitches');

    webpageContentMenu.innerHTML = '';

    if (finalTabs.length === 0) {
        webpageContentMenu.innerHTML = `<div class="webpage-menu-empty">${t('webpage_tabs_empty')}</div>`;
        return;
    }

    for (const tab of finalTabs) {
        if (!tab.title || !tab.url) continue;

        const item = document.createElement('div');
        item.className = 'webpage-menu-item';

        // 添加 Favicon
        if (tab.favIconUrl) {
            const favicon = document.createElement('img');
            favicon.src = tab.favIconUrl;
            favicon.className = 'favicon';
            item.appendChild(favicon);
        }

        const title = document.createElement('span');
        title.className = 'title';
        title.textContent = tab.title;
        title.title = tab.title; // for tooltip on long titles

        const switchId = `webpage-switch-${tab.id}`;
        const switchLabel = document.createElement('label');
        switchLabel.className = 'switch';
        switchLabel.setAttribute('for', switchId);

        // Stop the click event from bubbling up, which would close the main menu.
        switchLabel.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        const switchInput = document.createElement('input');
        switchInput.type = 'checkbox';
        switchInput.id = switchId;

        // 确定开关状态
        const isEnabled = switches && switches[tab.id] !== undefined ? switches[tab.id] : false;
        switchInput.checked = isEnabled;

        switchInput.addEventListener('change', async (e) => {
            const isChecked = e.target.checked;
            const { webpageSwitches: currentSwitches } = await storageAdapter.get('webpageSwitches');
            const newSwitches = { ...currentSwitches, [tab.id]: isChecked };
            await storageAdapter.set({ webpageSwitches: newSwitches });

            // 如果是开启，且标签页未连接，则刷新它
            if (isChecked) {
                const isConnected = await browserAdapter.isTabConnected(tab.id);
                if (!isConnected) {
                    await browserAdapter.reloadTab(tab.id);
                    console.log(`Webpage-menu: populateWebpageContentMenu Reloaded tab ${tab.id} ${tab.title} (${tab.url}).`);
                    // 可选：刷新后可以给个提示或自动重新打开菜单
                }
            }
        });

        // 允许点击整行（除开关本身）来切换，避免误关一级菜单且提升可用性
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            // 点击开关区域时交给默认行为
            if (e.target.closest('.switch')) return;
            switchInput.checked = !switchInput.checked;
            switchInput.dispatchEvent(new Event('change', { bubbles: true }));
        });

        const slider = document.createElement('span');
        slider.className = 'slider';

        switchLabel.appendChild(switchInput);
        switchLabel.appendChild(slider);
        item.appendChild(title);
        item.appendChild(switchLabel);
        webpageContentMenu.appendChild(item);
    }
}

export async function getEnabledTabsContent() {
    const { webpageSwitches: switches } = await storageAdapter.get('webpageSwitches');
    let allTabs = await browserAdapter.getAllTabs();
    const currentTab = await browserAdapter.getCurrentTab();
    const activeChatId = chatManager.getCurrentChat()?.id || null;
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
