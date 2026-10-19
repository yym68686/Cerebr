import {
    useCallback,
    useDeferredValue,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react';
import { chatManager } from '../../domain/chat/chat-store.js';
import { chatOrganization } from '../../domain/chat/chat-organization.js';
import { t } from '../../utils/i18n.js';
import { notify, uiStore } from '../state/ui-store.js';
import { useProgressiveCount } from '../hooks/useProgressiveCount.js';
import { Icon } from './Icon.jsx';
import { NavigationDialog, NavigationMenu } from './NavigationOverlays.jsx';

function GlideList({ children, resetKey, scrollRef, pinnedRow = null }) {
    const pinned = useRef(pinnedRow);
    pinned.current = pinnedRow;
    const ref = useRef(null),
        pointer = useRef(null),
        frame = useRef(0);
    const [highlight, setHighlight] = useState(null);
    const highlightTarget = useCallback((target, instant = false) => {
        const row = (pinned.current || target)?.closest('[data-nav-row]');
        if (!row || !ref.current?.contains(row)) {
            setHighlight(null);
            return;
        }
        const rect = row.getBoundingClientRect(),
            parent = ref.current.getBoundingClientRect();
        const next = { y: rect.top - parent.top, height: rect.height, instant };
        setHighlight((previous) =>
            previous?.y === next.y && previous.height === next.height && previous.instant === instant
                ? previous
                : next
        );
    }, []);
    const syncPointer = useCallback(() => {
        frame.current = 0;
        if (!pointer.current) return;
        const { x, y } = pointer.current;
        highlightTarget(ref.current?.ownerDocument.elementFromPoint(x, y), true);
    }, [highlightTarget]);
    const move = (event) => {
        if (event.pointerType === 'touch') return;
        pointer.current = { x: event.clientX, y: event.clientY };
        highlightTarget(event.target);
    };
    useEffect(() => {
        const scroller = scrollRef?.current;
        const scroll = () => {
            if (pointer.current && !frame.current) frame.current = requestAnimationFrame(syncPointer);
        };
        scroller?.addEventListener('scroll', scroll, { passive: true });
        return () => {
            scroller?.removeEventListener('scroll', scroll);
            cancelAnimationFrame(frame.current);
            frame.current = 0;
        };
    }, [scrollRef, syncPointer]);
    useLayoutEffect(() => {
        if (pinnedRow) highlightTarget(pinnedRow, true);
        else if (pointer.current) syncPointer();
        else if (ref.current?.contains(document.activeElement)) highlightTarget(document.activeElement, true);
        else setHighlight(null);
    }, [resetKey, syncPointer, pinnedRow, highlightTarget]);
    return (
        <div
            className={`navigation-glide${highlight ? ' is-hovering' : ''}`}
            ref={ref}
            onPointerOver={move}
            onPointerMove={move}
            onFocus={(event) => highlightTarget(event.target)}
            onKeyDownCapture={() => {
                pointer.current = null;
            }}
            onBlur={(event) => {
                if (!pinned.current && !event.currentTarget.contains(event.relatedTarget)) {
                    setHighlight(null);
                }
            }}
            onPointerLeave={() => {
                pointer.current = null;
                cancelAnimationFrame(frame.current);
                frame.current = 0;
                if (!pinned.current) setHighlight(null);
            }}
        >
            {highlight && (
                <div
                    className="navigation-glide-highlight"
                    aria-hidden="true"
                    style={{
                        transform: `translateY(${highlight.y}px)`,
                        height: highlight.height,
                        ...(highlight.instant ? { transition: 'none' } : {}),
                    }}
                />
            )}
            {children}
        </div>
    );
}

export function ChatNavigation({ wide, open, session, onClose, onNavigate }) {
    const version = useSyncExternalStore(chatManager.subscribe, chatManager.getSnapshot);
    const organization = useSyncExternalStore(chatOrganization.subscribe, chatOrganization.getSnapshot);
    const ui = useSyncExternalStore(uiStore.subscribe, uiStore.getSnapshot);
    const [searchOpen, setSearchOpen] = useState(false),
        [search, setSearch] = useState('');
    const [menu, setMenu] = useState(null),
        [dialog, setDialog] = useState(null),
        [loadError, setLoadError] = useState(null);
    const searchRef = useRef(null),
        closeRef = useRef(null),
        listRef = useRef(null),
        longPress = useRef(null),
        pressPoint = useRef(null);
    const desktop = !!globalThis.cerebrDesktop;
    const [preview, setPreview] = useState(false);
    const hoverTimer = useRef(null),
        suppressHover = useRef(false),
        hovering = useRef(false);
    const collapsed = wide && organization.sidebarCollapsed;
    const floating = wide && collapsed && (preview || open);
    const visible = (wide && !collapsed) || floating || (!wide && open);
    const showToggle = desktop || (wide && collapsed);
    const cancelHoverClose = () => clearTimeout(hoverTimer.current);
    const leavePreview = () => {
        hovering.current = false;
        suppressHover.current = false;
        cancelHoverClose();
        hoverTimer.current = setTimeout(() => {
            if (!menuTarget.current && !dialog) setPreview(false);
        }, 180);
    };
    const enterPreview = (event) => {
        hovering.current = true;
        cancelHoverClose();
        if (wide && collapsed && !suppressHover.current && event.pointerType !== 'touch') setPreview(true);
    };
    const menuTarget = useRef(null);
    menuTarget.current = menu;
    const query = useDeferredValue(search.trim().toLowerCase());
    const loaded = visible && chatManager.allChatsLoaded && organization.ready;
    const report = useCallback((error) => notify(t(error.message), { type: 'error' }), []);
    const run = useCallback(
        (callback) => {
            Promise.resolve().then(callback).catch(report);
        },
        [report]
    );
    const load = useCallback(async () => {
        setLoadError(null);
        try {
            await Promise.all([chatManager.loadAllChats(), chatOrganization.load()]);
        } catch (error) {
            setLoadError(error);
        }
    }, []);
    useEffect(() => {
        if (visible) void load();
    }, [visible, load]);
    useEffect(() => {
        const refresh = () => {
            if (!document.hidden && visible) run(() => chatOrganization.load());
        };
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', refresh);
        return () => {
            window.removeEventListener('focus', refresh);
            document.removeEventListener('visibilitychange', refresh);
        };
    }, [visible, run]);
    useLayoutEffect(() => {
        document.body.dataset.navigationCollapsed = String(collapsed);
        return () => {
            delete document.body.dataset.navigationCollapsed;
        };
    }, [collapsed]);
    useLayoutEffect(() => {
        if (!visible) return;
        if (searchOpen) searchRef.current?.focus({ preventScroll: true });
    }, [searchOpen, visible]);
    useLayoutEffect(() => {
        if (!open || wide) return;
        const before = document.activeElement;
        closeRef.current?.focus({ preventScroll: true });
        return () => {
            if (before?.isConnected) before.focus?.({ preventScroll: true });
        };
    }, [open, wide]);
    useEffect(() => {
        setMenu(null);
        setDialog(null);
    }, [wide, visible]);
    useEffect(() => () => clearTimeout(longPress.current), []);
    const chats = useMemo(() => (loaded ? chatManager.getAllChats() : []), [loaded, version]);
    const folderById = useMemo(
        () => new Map(organization.folders.map((folder) => [folder.id, folder])),
        [organization.folders]
    );
    const entries = useMemo(() => {
        if (!loaded || (organization.chatsCollapsed && !query)) return [];
        const byFolder = new Map(organization.folders.map((folder) => [folder.id, []]));
        const unfiled = [];
        for (const chat of chats) {
            const folderId = organization.assignments[chat.id],
                folder = folderById.get(folderId);
            const matches =
                !query ||
                `${chat.title}\n${folder?.name || ''}`.toLowerCase().includes(query) ||
                chat.messages?.some((message) =>
                    (typeof message.content === 'string'
                        ? message.content
                        : (message.content || [])
                              .filter((part) => part.type === 'text')
                              .map((part) => part.text || '')
                              .join('\n')
                    )
                        .toLowerCase()
                        .includes(query)
                );
            if (!matches) continue;
            (byFolder.get(folderId) || unfiled).push(chat);
        }
        const rows = [];
        for (const folder of organization.folders) {
            const members = byFolder.get(folder.id);
            if (query && !members.length && !folder.name.toLowerCase().includes(query)) continue;
            rows.push({ kind: 'folder', id: folder.id, folder, count: members.length });
            if (!folder.collapsed || query) {
                if (!members.length) rows.push({ kind: 'empty', id: `empty-${folder.id}` });
                for (const chat of members) rows.push({ kind: 'chat', id: chat.id, chat, nested: true });
            }
        }
        if (organization.folders.length && unfiled.length) rows.push({ kind: 'label', id: 'unfiled' });
        for (const chat of unfiled) rows.push({ kind: 'chat', id: chat.id, chat });
        return rows;
    }, [chats, organization, query, folderById, loaded]);
    const count = useProgressiveCount(`${query}:${organization.chatsCollapsed}`, entries.length, 50);
    const closeMenu = useCallback((restore = true) => {
        if (restore && menuTarget.current?.returnFocus?.isConnected)
            menuTarget.current.returnFocus.focus({ preventScroll: true });
        setMenu(null);
    }, []);
    const showMenu = (event, entry) => {
        event.preventDefault();
        event.stopPropagation();
        const row = event.currentTarget.closest('[data-nav-row]') || event.currentTarget;
        const rect = row.getBoundingClientRect();
        uiStore.set({ context: null, menu: false, webpageMenu: false });
        setMenu({
            ...entry,
            x: event.clientX || rect.left + 24,
            y: event.clientY || rect.bottom,
            returnFocus: row.querySelector('button') || row,
        });
    };
    const pickChat = (chatId) =>
        run(async () => {
            if (chatManager.currentChatId !== chatId) await session?.switchChat(chatId);
            else onNavigate(null);
            setPreview(false);
            onClose();
        });
    const newChat = () =>
        run(async () => {
            await session?.newChat();
            setPreview(false);
            onClose();
        });
    useEffect(() => {
        if (!menu && !dialog && !hovering.current) leavePreview();
        return () => clearTimeout(hoverTimer.current);
    }, [menu, dialog]);
    const toggleSidebar = () => {
        cancelHoverClose();
        suppressHover.current = true;
        setPreview(false);
        if (!wide) uiStore.set({ navigationOpen: !open });
        else {
            onClose();
            run(() => chatOrganization.setCollapsed('sidebar', !collapsed));
        }
    };
    useEffect(() => {
        if (!wide || !collapsed) setPreview(false);
        return () => clearTimeout(hoverTimer.current);
    }, [wide, collapsed]);
    useEffect(() => {
        if (!floating) return;
        const outside = (event) => {
            if (
                !event.target.closest(
                    '#chat-navigation,.navigation-window-toggle,.navigation-menu,.navigation-dialog'
                )
            ) {
                setPreview(false);
                onClose();
            }
        };
        document.addEventListener('pointerdown', outside);
        return () => document.removeEventListener('pointerdown', outside);
    }, [floating, onClose]);
    const rename = () =>
        setDialog({
            type: menu.kind === 'chat' ? 'renameChat' : 'renameFolder',
            id: menu.id,
            name: menu.kind === 'chat' ? menu.chat.title : menu.folder.name,
        });
    const submitDialog = async (value) => {
        const data = dialog;
        if (data.type === 'createFolder') await chatOrganization.createFolder(value, data.chatId);
        else if (data.type === 'renameFolder') await chatOrganization.renameFolder(data.id, value);
        else if (data.type === 'deleteFolder') await chatOrganization.deleteFolder(data.id);
        else if (data.type === 'renameChat') {
            chatManager.renameChat(data.id, value);
            await chatManager.flushNow();
        } else if (data.type === 'deleteChat') {
            await session?.removeChat(data.id);
            await chatOrganization.moveChat(data.id, null);
        }
    };
    return (
        <>
            {showToggle && (
                <button
                    ref={desktop ? closeRef : undefined}
                    type="button"
                    className="navigation-window-toggle"
                    aria-label={t(wide && !collapsed ? 'nav_collapse_sidebar' : 'nav_expand_sidebar')}
                    aria-expanded={wide ? !collapsed : open}
                    aria-controls="chat-navigation"
                    onPointerEnter={enterPreview}
                    onPointerLeave={leavePreview}
                    onClick={toggleSidebar}
                >
                    <Icon name={wide && !collapsed ? 'sidebar-close' : 'sidebar-open'} />
                </button>
            )}
            <aside
                id="chat-navigation"
                className={`${visible ? 'is-visible' : ''}${floating ? ' is-floating' : ''}${!wide && open ? ' is-fullscreen' : ''}`}
                aria-label={t('nav_chat_navigation')}
                inert={!visible}
                onPointerEnter={() => {
                    hovering.current = true;
                    cancelHoverClose();
                }}
                onPointerLeave={leavePreview}
                onKeyDown={(event) => {
                    if (event.key === 'Tab' && !wide && open) {
                        const items = [...event.currentTarget.querySelectorAll('button, input')].filter(
                            (item) => !item.disabled
                        );
                        if (event.shiftKey && document.activeElement === items[0]) {
                            event.preventDefault();
                            items.at(-1)?.focus();
                        } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
                            event.preventDefault();
                            items[0]?.focus();
                        }
                    }
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        if (menu) closeMenu();
                        else if (searchOpen) {
                            setSearchOpen(false);
                            setSearch('');
                        } else {
                            setPreview(false);
                            onClose();
                        }
                    }
                }}
            >
                <div className="navigation-header">
                    {!desktop &&
                        (wide ? (
                            <button
                                type="button"
                                className="navigation-icon-button"
                                aria-label={t(collapsed ? 'nav_expand_sidebar' : 'nav_collapse_sidebar')}
                                onClick={toggleSidebar}
                            >
                                <Icon name={collapsed ? 'sidebar-open' : 'sidebar-close'} />
                            </button>
                        ) : (
                            <button
                                ref={closeRef}
                                type="button"
                                className="navigation-icon-button"
                                aria-label={t('nav_close_navigation')}
                                onClick={onClose}
                            >
                                <Icon name="close" />
                            </button>
                        ))}
                </div>
                <GlideList>
                    <button
                        data-nav-row
                        type="button"
                        className="navigation-primary-row"
                        aria-label={t('settings_new_chat')}
                        disabled={!session}
                        onClick={newChat}
                    >
                        <Icon name="compose" />
                        <span>{t('settings_new_chat')}</span>
                    </button>
                </GlideList>
                <>
                    <div className={`navigation-chats-header${searchOpen ? ' is-searching' : ''}`}>
                        {searchOpen ? (
                            <div className="navigation-search">
                                <Icon name="search" />
                                <input
                                    ref={searchRef}
                                    type="search"
                                    aria-label={t('nav_search_chats')}
                                    placeholder={t('nav_search_chats')}
                                    value={search}
                                    onChange={(event) => setSearch(event.target.value)}
                                />
                                <button
                                    type="button"
                                    className="navigation-icon-button"
                                    aria-label={t('chat_clear_search_aria')}
                                    onClick={() => {
                                        setSearch('');
                                        setSearchOpen(false);
                                    }}
                                >
                                    <Icon name="close" />
                                </button>
                            </div>
                        ) : (
                            <>
                                <button
                                    className="navigation-chats-toggle"
                                    type="button"
                                    aria-expanded={!organization.chatsCollapsed}
                                    onClick={() =>
                                        run(() =>
                                            chatOrganization.setCollapsed(
                                                'chats',
                                                !organization.chatsCollapsed
                                            )
                                        )
                                    }
                                >
                                    <Icon name="chevron-down" />
                                    <span>{t('nav_chats')}</span>
                                </button>
                                <button
                                    type="button"
                                    className="navigation-icon-button"
                                    aria-label={t('nav_new_folder')}
                                    title={t('nav_new_folder')}
                                    onClick={() => setDialog({ type: 'createFolder' })}
                                >
                                    <Icon name="folder-plus" />
                                </button>
                                <button
                                    type="button"
                                    className="navigation-icon-button"
                                    aria-label={t('nav_search_chats')}
                                    title={t('nav_search_chats')}
                                    onClick={() => setSearchOpen(true)}
                                >
                                    <Icon name="search" />
                                </button>
                            </>
                        )}
                    </div>
                    <div className="navigation-chat-list" ref={listRef} onScroll={() => closeMenu(false)}>
                        {loadError ? (
                            <div className="navigation-empty" role="alert">
                                {t('nav_load_error')}
                                <button type="button" onClick={load}>
                                    {t('composer_retry')}
                                </button>
                            </div>
                        ) : !loaded ? (
                            <div className="navigation-empty" role="status">
                                {t('nav_loading')}
                            </div>
                        ) : null}
                        <GlideList
                            scrollRef={listRef}
                            pinnedRow={menu?.returnFocus?.closest('[data-nav-row]') || null}
                            resetKey={`${query}:${entries.length}:${count}:${organization.chatsCollapsed}`}
                        >
                            {entries.slice(0, count).map((entry) => {
                                if (entry.kind === 'label')
                                    return (
                                        <div className="navigation-group-label" key={entry.id}>
                                            {t('nav_unfiled')}
                                        </div>
                                    );
                                if (entry.kind === 'empty')
                                    return (
                                        <div className="navigation-folder-empty" key={entry.id}>
                                            {t('nav_folder_empty')}
                                        </div>
                                    );
                                const isChat = entry.kind === 'chat';
                                const active = isChat && entry.id === chatManager.currentChatId;
                                const running =
                                    isChat &&
                                    ((ui.phase !== 'idle' && ui.requestChatId === entry.id) ||
                                        ['thinking', 'replying'].includes(ui.remoteProgress?.[entry.id]));
                                const label = isChat ? entry.chat.title : entry.folder.name;
                                return (
                                    <div
                                        key={`${entry.kind}:${entry.id}`}
                                        data-nav-row
                                        data-chat-id={isChat ? entry.id : undefined}
                                        data-folder-id={!isChat ? entry.id : undefined}
                                        className={`navigation-item${active ? ' is-active' : ''}${entry.nested ? ' is-nested' : ''}`}
                                        onContextMenu={(event) => showMenu(event, entry)}
                                        onKeyDown={(event) => {
                                            if (
                                                event.key === 'ContextMenu' ||
                                                (event.key === 'F10' && event.shiftKey)
                                            )
                                                showMenu(event, entry);
                                        }}
                                        onPointerDown={(event) => {
                                            if (event.pointerType !== 'touch') return;
                                            pressPoint.current = { x: event.clientX, y: event.clientY };
                                            const target = {
                                                preventDefault() {},
                                                stopPropagation() {},
                                                currentTarget: event.currentTarget,
                                                clientX: event.clientX,
                                                clientY: event.clientY,
                                            };
                                            longPress.current = setTimeout(() => {
                                                pressPoint.current = null;
                                                showMenu(target, entry);
                                            }, 500);
                                        }}
                                        onPointerMove={(event) => {
                                            if (
                                                pressPoint.current &&
                                                Math.hypot(
                                                    event.clientX - pressPoint.current.x,
                                                    event.clientY - pressPoint.current.y
                                                ) > 8
                                            )
                                                clearTimeout(longPress.current);
                                        }}
                                        onPointerUp={() => clearTimeout(longPress.current)}
                                        onPointerCancel={() => clearTimeout(longPress.current)}
                                    >
                                        <button
                                            type="button"
                                            className="navigation-item-label"
                                            title={label}
                                            aria-current={active ? 'page' : undefined}
                                            aria-expanded={
                                                !isChat ? !entry.folder.collapsed || !!query : undefined
                                            }
                                            onClick={() => {
                                                if (menu?.id === entry.id) return;
                                                if (isChat) pickChat(entry.id);
                                                else
                                                    run(() =>
                                                        chatOrganization.setCollapsed(
                                                            entry.id,
                                                            !entry.folder.collapsed
                                                        )
                                                    );
                                            }}
                                        >
                                            {!isChat && (
                                                <>
                                                    <Icon name="chevron-down" />
                                                    <Icon name="folder" />
                                                </>
                                            )}
                                            <span>{label}</span>
                                            {!isChat && (
                                                <span className="navigation-count">{entry.count}</span>
                                            )}
                                        </button>
                                        {running && (
                                            <span
                                                className="navigation-reply-spinner"
                                                role="status"
                                                aria-label={t('nav_replying')}
                                            />
                                        )}
                                        <button
                                            type="button"
                                            className="navigation-item-more navigation-icon-button"
                                            aria-label={t('nav_item_actions', [label])}
                                            onClick={(event) => showMenu(event, entry)}
                                        >
                                            <Icon name="more" />
                                        </button>
                                    </div>
                                );
                            })}
                        </GlideList>
                        {loaded && !entries.length && (!organization.chatsCollapsed || query) && (
                            <div className="navigation-empty">
                                {t(query ? 'chat_list_no_match' : 'chat_list_empty')}
                            </div>
                        )}
                    </div>
                </>
            </aside>
            {visible && menu && (
                <NavigationMenu
                    target={menu}
                    folders={organization.folders}
                    assigned={organization.assignments[menu.id]}
                    onClose={closeMenu}
                    onMove={(folderId) => run(() => chatOrganization.moveChat(menu.id, folderId))}
                    onCreateFolder={() => setDialog({ type: 'createFolder', chatId: menu.id })}
                    onRename={rename}
                    onDelete={() =>
                        setDialog({
                            type: menu.kind === 'chat' ? 'deleteChat' : 'deleteFolder',
                            id: menu.id,
                            name: menu.kind === 'chat' ? menu.chat.title : menu.folder.name,
                        })
                    }
                />
            )}
            {visible && dialog && (
                <NavigationDialog
                    key={`${dialog.type}:${dialog.id || ''}`}
                    dialog={dialog}
                    onClose={() => setDialog(null)}
                    onSubmit={submitDialog}
                />
            )}
        </>
    );
}
