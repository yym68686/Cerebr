import { storageAdapter, browserAdapter } from '../utils/storage-adapter.js';
import { extractTextFromPDF } from '../utils/pdf-parser.js';

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
    webpageContentMenu.innerHTML = ''; // 清空现有内容
    let allTabs = await browserAdapter.getAllTabs();

    // 1. 过滤掉无法连接的标签页
    const connectedTabs = [];
    for (const tab of allTabs) {
        if (await browserAdapter.isTabConnected(tab.id)) {
            connectedTabs.push(tab);
        }
    }

    // 2. 按照 lastAccessed 时间降序排序
    connectedTabs.sort((a, b) => b.lastAccessed - a.lastAccessed);

    // 3. 过滤掉重复的 URL
    const finalTabs = getUniqueTabsByUrl(connectedTabs);

    const { webpageSwitches: switches } = await storageAdapter.get('webpageSwitches');
    const currentTab = await browserAdapter.getCurrentTab();

    for (const tab of finalTabs) {

        if (!tab.title || !tab.url) continue;

        const item = document.createElement('div');
        item.className = 'webpage-menu-item';

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
        const isEnabled = switches && switches[tab.id] !== undefined ? switches[tab.id] : (tab.id === currentTab.id);
        switchInput.checked = isEnabled;

        switchInput.addEventListener('change', async (e) => {
            const { webpageSwitches: currentSwitches } = await storageAdapter.get('webpageSwitches');
            const newSwitches = { ...currentSwitches, [tab.id]: e.target.checked };
            await storageAdapter.set({ webpageSwitches: newSwitches });
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
    let combinedContent = null;

    // 1. 过滤掉无法连接的标签页
    const connectedTabs = [];
    for (const tab of allTabs) {
        if (await browserAdapter.isTabConnected(tab.id)) {
            connectedTabs.push(tab);
        }
    }

    // 2. 按照 lastAccessed 时间降序排序
    connectedTabs.sort((a, b) => b.lastAccessed - a.lastAccessed);

    // 3. 过滤掉重复的 URL
    const finalTabs = getUniqueTabsByUrl(connectedTabs);

    for (const tab of finalTabs) {

        const isEnabled = switches && switches[tab.id] !== undefined ? switches[tab.id] : (tab.id === currentTab.id);
        if (isEnabled) {
            try {
                let pageData = null;
                // 检查是否为 PDF 标签页
                if (tab.url.toLowerCase().endsWith('.pdf') || tab.url.includes('.pdf?')) {
                    // 对于 PDF，直接在 sidebar 中调用解析器
                    console.log(`Webpage-menu: Detected PDF tab ${tab.id}, parsing directly.`);
                    const pdfContent = await extractTextFromPDF(tab.url); // 无需 placeholder 更新
                    if (pdfContent) {
                        pageData = {
                            title: tab.title,
                            content: pdfContent
                        };
                    }
                } else {
                    // 对于普通网页，通过 background 请求 content script 提取内容
                    console.log(`Webpage-menu: Detected regular tab ${tab.id}, sending message.`);
                    pageData = await browserAdapter.sendMessage({
                        type: 'GET_PAGE_CONTENT_FROM_SIDEBAR',
                        tabId: tab.id,
                        skipWaitContent: true // 明确要求立即提取
                    });
                }

                if (pageData && pageData.content) {
                    if (!combinedContent) {
                        combinedContent = { pages: [] };
                    }
                    combinedContent.pages.push({
                        title: pageData.title,
                        url: tab.url,
                        content: pageData.content
                    });
                }
            } catch (e) {
                console.warn(`Could not get content from tab ${tab.id} (${tab.url}): ${e}`);
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