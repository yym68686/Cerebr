import { startUISync } from './runtime/sync/ui-sync.js';
import { Component } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.jsx';
import { initI18n } from './utils/i18n.js';
import { chatManager } from './domain/chat/chat-store.js';
import { loadApiConfigs, apiStore } from './app/state/api-configs.js';
import { getChatModelSelection } from './domain/chat/model-selection.js';
import { loadPreferences, preferencesStore, syncLocalizedChats } from './app/state/preferences.js';
import { openPage } from './app/state/ui-store.js';
import { ensureMarkdownReady } from '../htmd/latex.js';
import '../styles/main.css';
if(globalThis.cerebrDesktop)document.body.dataset.desktopPlatform=globalThis.cerebrDesktop.platform;

class ErrorBoundary extends Component {
    state = { error: null };
    static getDerivedStateFromError(error) {
        return { error };
    }
    componentDidCatch(error, info) {
        console.error('[Cerebr] React UI failed', error, info);
    }
    render() {
        if (this.state.error)
            return (
                <div role="alert" style={{ padding: 24 }}>
                    Cerebr could not load.<button onClick={() => location.reload()}>Reload</button>
                    <pre>{this.state.error.message}</pre>
                </div>
            );
        return this.props.children;
    }
}
// 补齐其余对话要读全部存储（几千条对话时几百毫秒），放到首帧画出来之后，打开侧栏时就不会先空白
function afterFirstPaint(callback) {
    let done = false;
    const run = () => {
        if (done) return;
        done = true;
        callback();
    };
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(run, 0)));
    // 不可见的 iframe / 后台标签页里 requestAnimationFrame 可能一直不触发
    setTimeout(run, 1000);
}
async function start() {
    // 模块加载时 ChatManager 已开始初始化（首次打开只读当前对话，很快）。必须在第一次 await 之前
    // 拿到这次初始化：等它结束后再调用 initialize() 会重新初始化，把全部对话读两遍
    const chatsReady = chatManager.initialize();
    // marked + highlight.js（约 155KB）不再由 index.html 同步阻塞加载，改在这里和存储初始化
    // 并行拉取：两边都是 IO，通常存储更慢，所以首屏基本等不到它。不 await，失败也不该拖住启动。
    void ensureMarkdownReady().catch((error) => console.error('Markdown 渲染器预加载失败:', error));
    await initI18n();
    await Promise.all([chatsReady, loadApiConfigs(), loadPreferences()]);
    chatManager.getDefaultModelSelection = () => apiStore.getSnapshot().defaultSelection;
    const initialChat = chatManager.getCurrentChat();
    if (initialChat && !initialChat.modelSelection && apiStore.getSnapshot().defaultSelection) {
        void chatManager.setChatModel(initialChat.id, getChatModelSelection(initialChat, apiStore.getSnapshot()));
    }
    await syncLocalizedChats();
    void startUISync().catch((error) => console.error('[Cerebr] Desktop sync failed', error));
    if (
        new URLSearchParams(location.search).get('open') === 'plugins' &&
        preferencesStore.getSnapshot().developerMode
    )
        openPage('plugins');
    createRoot(document.getElementById('root')).render(
        <ErrorBoundary>
            <App />
        </ErrorBoundary>
    );
    afterFirstPaint(() =>
        chatManager
            .loadAllChats()
            .then(syncLocalizedChats)
            .catch((error) => console.error('加载全部对话失败:', error))
    );
}
start().catch((error) => {
    console.error(error);
    document.getElementById('root').textContent = `Cerebr could not load: ${error.message}`;
});
