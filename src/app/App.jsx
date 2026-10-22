import { DropFeedback } from './components/DropFeedback.jsx';
import { ChatSearch } from './components/ChatSearch.jsx';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { chatManager } from '../domain/chat/chat-store.js';
import { t, getActiveLocale, onLocaleChanged } from '../utils/i18n.js';
import { useProgressiveCount } from './hooks/useProgressiveCount.js';
import { useSettingsMenu } from './hooks/useSettingsMenu.js';
import { useComposerDraft } from './hooks/useComposerDraft.js';
import { ComposerControls } from './components/ComposerControls.jsx';
import { applyThemePreference } from '../utils/theme.js';
import { getMathSource, copyChatSelection } from '../render/message/message-clipboard.js';
import { installCodeBlockDelegation } from '../render/message/markdown-enhancements.js';
import { createSession } from './session.js';
import { uiStore, openPage } from './state/ui-store.js';
import { apiStore } from './state/api-configs.js';
import { preferencesStore } from './state/preferences.js';
import { setPlaceholderRestoreResolver } from '../runtime/input/native-editor.js';
import { ApiSettings } from './components/ApiSettings.jsx';
import { Preferences } from './components/Preferences.jsx';
import { ChatNavigation } from './components/ChatNavigation.jsx';
import { useWideLayout } from './hooks/useWideLayout.js';
import { Message } from './components/Messages.jsx';
import { ContextMenu, ImagePreview, Toasts } from './components/Overlays.jsx';
import { Slot } from './components/common.jsx';
import { Icon } from './components/Icon.jsx';
import {
    PluginInputActions,
    PluginSlashCommands,
    PluginPage,
    PluginModals,
} from './components/PluginSurfaces.jsx';
import { PluginSettings } from './components/PluginSettings.jsx';
import { ComposerMenu } from './components/ComposerMenu.jsx';
import { ComposerSources } from './components/ComposerSources.jsx';
import { useWebpageSources } from './hooks/useWebpageSources.js';
import { isNewWebpageConversation } from '../utils/webpage-switches.js';
import { SelectionActions } from './components/SelectionActions.jsx';
import { ComposerFiles } from './components/ComposerFiles.jsx';
import { ComposerQuotes } from './components/ComposerQuotes.jsx';
import { DesktopTitlebar } from './components/DesktopTitlebar.jsx';
import '../utils/viewport.js';

export function App() {
    const ui = useSyncExternalStore(uiStore.subscribe, uiStore.getSnapshot);
    const apis = useSyncExternalStore(apiStore.subscribe, apiStore.getSnapshot);
    const prefs = useSyncExternalStore(preferencesStore.subscribe, preferencesStore.getSnapshot);
    const revision = useSyncExternalStore(chatManager.subscribe, chatManager.getSnapshot);
    const locale = useSyncExternalStore(onLocaleChanged, getActiveLocale);
    const chat = chatManager.getCurrentChat();
    const wide = useWideLayout();
    const selectionScope = useCallback(() => document.getElementById('chat-container'), []);
    const navigationCoversChat = !wide && ui.navigationOpen;
    const messageCount = useProgressiveCount(chat?.id, chat?.messages.length || 0);
    const inputRef = useRef(null),
        composerRowRef = useRef(null),
        imagePickerRef = useRef(null),
        chatRef = useRef(null),
        sessionRef = useRef(null);
    const settingsMenuEvents = useSettingsMenu();
    const sources = useWebpageSources(chat?.id, ui.menu, isNewWebpageConversation(chat));
    const draft = useComposerDraft(inputRef, composerRowRef, sources.selected.length > 0 || sources.reserveSources);
    const [session, setSession] = useState(null);
    const [elapsed, setElapsed] = useState(0);
    const [showScroll, setShowScroll] = useState(false);
    const previousTop = useRef(0);
    useEffect(() => {
        const next = createSession({ messageInput: inputRef.current, chatContainer: chatRef.current });
        sessionRef.current = next;
        setSession(next);
        // 代码块的 hover/复制走容器级事件委托，只注册一次，不随消息数量增长。
        installCodeBlockDelegation(chatRef.current);
        return () => {
            next.dispose();
            sessionRef.current = null;
        };
    }, []);
    useEffect(() => {
        setElapsed(0);
        if (ui.phase !== 'thinking') return;
        const started = Date.now();
        const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
        return () => clearInterval(timer);
    }, [ui.phase]);
    const placeholder = ui.editing
        ? t('message_edit_confirm_aria')
        : ui.phase === 'thinking'
          ? t('message_input_placeholder_thinking_with_elapsed', [elapsed])
          : ui.phase === 'replying'
            ? t('message_input_placeholder_replying')
            : t('message_input_placeholder');
    useEffect(() => {
        const media = matchMedia('(prefers-color-scheme: dark)');
        const change = () => applyThemePreference(preferencesStore.getSnapshot().theme);
        media.addEventListener('change', change);
        return () => media.removeEventListener('change', change);
    }, []);
    useEffect(() => {
        setPlaceholderRestoreResolver(() => placeholder);
    }, [placeholder]);
    useEffect(() => {
        const dismiss = (e) => {
            if (!e.target.closest('#settings-button,#settings-menu,.composer-sources,#context-menu'))
                uiStore.set({ menu: false, webpageMenu: false, context: null });
        };
        const keydown = (e) => {
            if (e.key !== 'Escape') return;
            const state = uiStore.getSnapshot();
            if (state.image) uiStore.set({ image: null });
            else if (state.navigationOpen) uiStore.set({ navigationOpen: false });
            else if (state.context || state.menu || state.webpageMenu) {
                uiStore.set({ context: null, menu: false, webpageMenu: false });
                if (state.menu || state.webpageMenu)
                    document.getElementById('settings-button')?.focus({ preventScroll: true });
            } else if (state.editing) sessionRef.current?.cancelEdit();
            else {
                sessionRef.current?.runtime.dismissPage('escape');
                openPage(null);
            }
            e.preventDefault();
        };
        const dismissContext = () => {
            if (uiStore.getSnapshot().context) uiStore.set({ context: null });
        };
        const onSelection = () => {
            const selection = window.getSelection();
            if (
                selection &&
                !selection.isCollapsed &&
                chatRef.current?.contains(selection.anchorNode) &&
                chatRef.current?.contains(selection.focusNode)
            )
                dismissContext();
        };
        document.addEventListener('wheel', dismissContext, { capture: true, passive: true });
        document.addEventListener('selectionchange', onSelection);
        document.addEventListener('pointerdown', dismiss);
        document.addEventListener('keydown', keydown);
        return () => {
            document.removeEventListener('wheel', dismissContext, true);
            document.removeEventListener('selectionchange', onSelection);
            document.removeEventListener('pointerdown', dismiss);
            document.removeEventListener('keydown', keydown);
        };
    }, []);
    useLayoutEffect(() => {
        const el = chatRef.current;
        if (!el.__cerebrUserPausedAutoScroll) el.scrollTop = el.scrollHeight;
        // Appending offscreen messages need not emit a scroll event. Keep the
        // explicit jump-to-latest control available while preserving the view.
        setShowScroll(el.scrollHeight - el.scrollTop - el.clientHeight > 160);
        document.dispatchEvent(
            new CustomEvent(
                messageCount === chat?.messages.length
                    ? 'cerebr:chatContentLoaded'
                    : 'cerebr:chatContentChunk',
                { detail: { chatId: chat?.id } }
            )
        );
    }, [revision, chat?.id, ui.phase, messageCount]);
    const scrollBottom = () => {
        chatRef.current.__cerebrUserPausedAutoScroll = false;
        chatRef.current.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
    };
    // scroll 事件在触屏/触控板上一帧可以来好几次，而这里要读 scrollHeight/clientHeight，
    // 每次都读就是每次强制同步布局。用 rAF 合并到每帧一次，并且只在布尔值真的翻转时 setState。
    const scrollFrame = useRef(0);
    const onScroll = useCallback((event) => {
        if (uiStore.getSnapshot().context) uiStore.set({ context: null });
        const el = event.currentTarget;
        if (scrollFrame.current) return;
        scrollFrame.current = requestAnimationFrame(() => {
            scrollFrame.current = 0;
            const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
            if (el.scrollTop < previousTop.current) el.__cerebrUserPausedAutoScroll = true;
            else if (remaining < 120) el.__cerebrUserPausedAutoScroll = false;
            previousTop.current = el.scrollTop;
            setShowScroll((prev) => (prev === remaining > 160 ? prev : remaining > 160));
        });
    }, []);
    useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);
    const context = useCallback((event, index) => {
        const target = event.target instanceof Element ? event.target : event.target?.parentElement;
        if (!target) return;
        const mathEl = target.closest('mjx-container');
        const chat = chatManager.getCurrentChat();
        if (!chat) return;
        uiStore.set({
            context: {
                chatId: chat.id,
                message: chat.messages[index],
                placeholder: !chat.messages[index],
                returnFocus: document.activeElement,
                index,
                x: event.clientX,
                y: event.clientY,
                code: target.closest('pre')?.querySelector('code')?.textContent,
                image: target.closest('img')?.src || target.closest('.message-attachment')?.dataset.image,
                math: getMathSource(mathEl),
            },
            menu: false,
            webpageMenu: false,
        });
    }, []);
    const navigate = (page) => {
        session?.runtime.dismissPage();
        if (page === 'history') {
            openPage(null);
            uiStore.set({ navigationOpen: true });
            return;
        }
        openPage(page);
    };
    const close = () => navigate(null);
    const localRequest = ui.localRequests?.[chat?.id];
    const localRequestActive = !!localRequest || (ui.requestChatId === chat?.id && ui.phase !== 'idle');
    const displayedPhase = localRequestActive ? (localRequest?.phase || ui.phase) : ui.remoteProgress[chat?.id] || 'idle';
    const requestActive = displayedPhase !== 'idle';
    const displayedStartedAt = localRequestActive ? (localRequest?.startedAt || ui.requestStartedAt) : ui.remoteStartedAt[chat?.id];
    const messages = chat?.messages || [];
    return (
        <>
            <DesktopTitlebar />
            <ChatNavigation
                wide={wide}
                open={ui.navigationOpen}
                session={session}
                onClose={() => uiStore.set({ navigationOpen: false })}
                onNavigate={navigate}
            />
            <button
                type="button"
                className="chat-navigation-mobile-toggle"
                aria-label={t('nav_open_navigation')}
                aria-expanded={ui.navigationOpen}
                hidden={!!ui.page || ui.navigationOpen}
                onClick={() => navigate('history')}
            >
                <Icon name="sidebar-open" />
            </button>
            <ChatSearch containerRef={chatRef} chatId={chat?.id} disabled={!!ui.page || navigationCoversChat} />
            <Slot name="shell.chat.before" />
            <div
                id="chat-container"
                inert={navigationCoversChat || !!ui.page}
                ref={chatRef}
                onCopy={copyChatSelection}
                onScroll={onScroll}
                onClick={(e) => {
                    if (
                        e.target === e.currentTarget &&
                        !window.getSelection()?.toString() &&
                        matchMedia('(pointer: fine)').matches
                    )
                        session?.editor.focus();
                }}
            >
                {messages.slice(0, messageCount).map((message, index) => (
                    <Message
                        key={`${chat.id}-${index}`}
                        {...message}
                        updating={
                            requestActive &&
                            displayedPhase === 'replying' &&
                            index === messages.length - 1 &&
                            message.role === 'assistant'
                        }
                        index={index}
                        requestStartedAt={
                            requestActive && index === messages.length - 1 ? displayedStartedAt : undefined
                        }
                        onContext={context}
                        editing={ui.editing?.index === index}
                        locale={locale}
                    />
                ))}
                {requestActive && (displayedPhase === 'thinking' || messages.at(-1)?.role !== 'assistant') && (
                    <Message
                        role="assistant"
                        content=""
                        index={messages.length}
                        updating
                        requestStartedAt={displayedStartedAt}
                        onContext={context}
                    />
                )}
            </div>
            <Slot name="shell.chat.after" />
            <SelectionActions
                key={chat?.id}
                scope={selectionScope}
                disabled={!session || !!ui.page || navigationCoversChat}
                onAdd={(text) => {
                    session.editor.addQuote(text);
                    session.editor.focus();
                }}
                onSend={(text, prompt) => session.pipeline.sendSelection(text, prompt)}
            />
            <button
                id="scroll-to-bottom"
                className={showScroll && !ui.page && !navigationCoversChat ? 'visible' : ''}
                type="button"
                tabIndex={showScroll && !ui.page && !navigationCoversChat ? 0 : -1}
                inert={!showScroll || !!ui.page || navigationCoversChat}
                aria-label={t('aria_scroll_to_bottom')}
                onClick={scrollBottom}
            >
                <Icon name="scroll-to-bottom" />
            </button>
            <ContextMenu context={ui.context} session={session} />
            <div
                id="input-container"
                inert={navigationCoversChat || !!ui.page}
                data-composer
                className={`${ui.editing ? 'is-editing-message' : ''}${draft.expanded ? ' is-expanded' : ''}`}
            >
                <ComposerSources sources={sources} onManage={settingsMenuEvents.openSources} />
                <ComposerFiles files={draft.textFiles} inputRef={inputRef} />
                <ComposerQuotes quotes={draft.quotes} inputRef={inputRef} />
                <div
                    className="composer-attachments"
                    data-composer-attachments
                    aria-label={t('composer_images')}
                />
                <input
                    ref={imagePickerRef}
                    type="file"
                    accept="image/*,.txt,text/plain"
                    multiple
                    hidden
                    onChange={(event) => {
                        const files = [...event.target.files];
                        event.target.value = '';
                        void session?.addFiles(files);
                    }}
                />
                <div className="input-container-main-row" ref={composerRowRef}>
                    <Slot name="shell.input.before" />
                    <button
                        id="settings-button"
                        aria-label={t('aria_open_settings')}
                        aria-expanded={ui.menu}
                        title={t('aria_open_settings')}
                        aria-haspopup="menu"
                        aria-controls="settings-menu"
                        type="button"
                        {...settingsMenuEvents.button}
                    >
                        <Icon name="settings-button" />
                    </button>
                    <ComposerMenu
                        ui={ui}
                        sources={sources}
                        events={settingsMenuEvents}
                        onAddImages={() => {
                            uiStore.set({ menu: false, webpageMenu: false });
                            imagePickerRef.current?.click();
                        }}
                        onNewChat={() => void session?.newChat()}
                        onNavigate={navigate}
                        developerMode={prefs.developerMode}
                    />
                    <div id="message-input-shell" className="message-input-shell">
                        <div
                            id="message-input"
                            ref={inputRef}
                            contentEditable
                            suppressContentEditableWarning
                            placeholder={placeholder}
                            data-empty={draft.textEmpty && !draft.composing}
                            enterKeyHint="send"
                            role="textbox"
                            aria-label={t('message_input_aria')}
                            aria-multiline="true"
                            spellCheck
                        />
                        <div className="fake-caret" aria-hidden="true" />
                    </div>
                    <Slot name="shell.input.after" />
                    <ComposerControls
                        apis={apis}
                        chat={chat}
                        session={session}
                        ui={ui}
                        draft={draft}
                        onSettings={() => navigate('api')}
                    />
                </div>
                <PluginSlashCommands />
                <PluginInputActions />
                <Slot name="shell.input.row.after" />
            </div>
            <ApiSettings visible={ui.page === 'api'} onBack={close} chat={chat} onSelectConfig={session?.selectModel} />
            <Preferences
                visible={ui.page === 'preferences'}
                onBack={close}
                saveDraft={() => session?.saveDraft()}
            />
            <PluginSettings visible={ui.page === 'plugins'} onBack={close} session={session} />
            <PluginPage />
            <PluginModals />
            <DropFeedback phase={ui.dropPhase} />
            <ImagePreview image={ui.image} />
            <Toasts toasts={ui.toasts} />
        </>
    );
}
