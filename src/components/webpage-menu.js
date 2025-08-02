import { storageAdapter, browserAdapter } from '../utils/storage-adapter.js';

function contentExtractionFunc() {
    // 在这里不能使用外部作用域的变量，所以需要一个纯函数
    const selectorsToRemove = [
        'script', 'style', 'nav', 'header', 'footer',
        'iframe', 'noscript', 'img', 'svg', 'video',
        '[role="complementary"]', '[role="navigation"]',
        '.sidebar', '.nav', '.footer', '.header'
    ];
    const tempContainer = document.createElement('div');
    tempContainer.innerHTML = document.body.innerHTML;
    selectorsToRemove.forEach(selector => {
        const elements = tempContainer.querySelectorAll(selector);
        elements.forEach(element => element.remove());
    });
    let mainContent = tempContainer.innerText.replace(/\s+/g, ' ').trim();
    if (mainContent.length < 40) return null;
    return {
        title: document.title,
        content: mainContent
    };
}

async function populateWebpageContentMenu(webpageContentMenu) {
    webpageContentMenu.innerHTML = ''; // 清空现有内容
    const tabs = await browserAdapter.getAllTabs();
    const { webpageSwitches: switches } = await storageAdapter.get('webpageSwitches');
    const currentTab = await browserAdapter.getCurrentTab();

    for (const tab of tabs) {
        if (!tab.title || !tab.url) continue;

        const item = document.createElement('div');
        item.className = 'webpage-menu-item';

        const title = document.createElement('span');
        title.className = 'title';
        title.textContent = tab.title;
        title.title = tab.title; // for tooltip on long titles

        const switchLabel = document.createElement('label');
        switchLabel.className = 'switch';

        const switchInput = document.createElement('input');
        switchInput.type = 'checkbox';

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
    const tabs = await browserAdapter.getAllTabs();
    const currentTab = await browserAdapter.getCurrentTab();
    let combinedContent = null;

    for (const tab of tabs) {
        const isEnabled = switches && switches[tab.id] !== undefined ? switches[tab.id] : (tab.id === currentTab.id);
        if (isEnabled) {
            try {
                const pageData = await browserAdapter.executeScriptInTab(tab.id, contentExtractionFunc);
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
                console.warn(`Could not get content from tab ${tab.id}: ${e}`);
            }
        }
    }
    return combinedContent;
}

export function initWebpageMenu({ webpageQAContainer, webpageContentMenu }) {
    webpageQAContainer.addEventListener('click', async (e) => {
        e.stopPropagation();
        const isVisible = webpageContentMenu.classList.toggle('visible');
        if (isVisible) {
            await populateWebpageContentMenu(webpageContentMenu);
            const rect = webpageQAContainer.getBoundingClientRect();
            const menuHeight = webpageContentMenu.offsetHeight;
            const windowHeight = window.innerHeight;

            let top = rect.top;
            if (top + menuHeight > windowHeight) {
                top = windowHeight - menuHeight - 150;
            }

            webpageContentMenu.style.top = `${Math.max(8, top)}px`;
            webpageContentMenu.style.left = `${rect.right + 8}px`;
        }
    });
}