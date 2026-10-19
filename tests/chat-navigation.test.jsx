import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const data = vi.hoisted(() => ({ memory: {}, chats: [], revision: 0, listeners: new Set() }));
vi.mock('../src/utils/storage-adapter.js', () => ({
    storageAdapter: {
        get: async (key) => ({ [key]: structuredClone(data.memory[key]) }),
        set: async (values) => Object.assign(data.memory, structuredClone(values)),
    },
}));
vi.mock('../src/domain/chat/chat-store.js', () => ({
    chatManager: {
        currentChatId: 'a',
        allChatsLoaded: true,
        loadAllChats: async () => {},
        subscribe: (listener) => {
            data.listeners.add(listener);
            return () => data.listeners.delete(listener);
        },
        getSnapshot: () => data.revision,
        getAllChats: () => data.chats,
        renameChat: vi.fn(),
        flushNow: async () => {},
    },
}));
vi.mock('../src/utils/i18n.js', () => ({ t: (key, args = []) => `${key} ${args.join(' ')}`.trim() }));
import { ChatNavigation } from '../src/app/components/ChatNavigation.jsx';
import { chatOrganization } from '../src/domain/chat/chat-organization.js';
import { uiStore } from '../src/app/state/ui-store.js';
import { chatManager } from '../src/domain/chat/chat-store.js';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, host, session, close, navigate;
const tick = () => act(async () => vi.advanceTimersByTimeAsync(40));
const render = async (wide = true, open = false) => {
    await act(async () =>
        root.render(
            <ChatNavigation wide={wide} open={open} session={session} onClose={close} onNavigate={navigate} />
        )
    );
    await tick();
};
const click = async (selector) => {
    await act(async () => host.querySelector(selector).click());
    await tick();
};
const button = (label) => `[aria-label="${label}"]`;
const textInput = async (selector, value) =>
    act(async () => {
        const input = host.querySelector(selector);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    data.memory = {};
    data.chats = [
        { id: 'a', title: 'Alpha', messages: [] },
        { id: 'b', title: 'Beta', messages: [{ content: 'find this message' }] },
    ];
    await chatOrganization.load();
    session = {
        newChat: vi.fn(async () => {}),
        switchChat: vi.fn(async () => {}),
        removeChat: vi.fn(async () => {}),
    };
    close = vi.fn();
    navigate = vi.fn();
    uiStore.set({ phase: 'idle', requestChatId: null });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete document.elementFromPoint;
});
function mockHoverLayout() {
    const scroller = host.querySelector('.navigation-chat-list');
    const list = scroller.querySelector('.navigation-glide');
    const rows = [...list.querySelectorAll('[data-nav-row]')];
    let offset = 0;
    vi.spyOn(list, 'getBoundingClientRect').mockImplementation(() => ({ top: 100 - offset }));
    rows.forEach((row, index) => {
        vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => ({
            top: 100 + index * 40 - offset,
            height: 40,
        }));
    });
    const hitTest = vi.fn((_x, y) => {
        if (y < 100 || y >= 180) return scroller;
        return rows[Math.floor((y - 100 + offset) / 40)]?.querySelector('button') || scroller;
    });
    document.elementFromPoint = hitTest;
    const point = async (type, row, x, y, pointerType = 'mouse', relatedTarget) => {
        const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, relatedTarget });
        Object.defineProperty(event, 'pointerType', { value: pointerType });
        await act(async () => row.dispatchEvent(event));
    };
    return {
        scroller,
        list,
        rows,
        point,
        hitTest,
        scroll: async (nextOffset) => {
            offset = nextOffset;
            await act(async () => scroller.dispatchEvent(new Event('scroll')));
        },
    };
}
it('updates the hovered chat during scrolling even when the mouse stays still', async () => {
    await render();
    const hover = mockHoverLayout();
    await hover.point('pointerover', hover.rows[0], 20, 105);
    await hover.point('pointermove', hover.rows[0], 20, 125);
    expect(hover.list.querySelector('.navigation-glide-highlight').style.transform).toBe('translateY(0px)');
    await hover.scroll(10);
    await hover.scroll(30);
    expect(hover.hitTest).not.toHaveBeenCalled();
    await tick();
    expect(hover.hitTest).toHaveBeenCalledExactlyOnceWith(20, 125);
    const highlight = hover.list.querySelector('.navigation-glide-highlight');
    expect(highlight.style.transform).toBe('translateY(40px)');
    expect(highlight.style.transition).toBe('none');
    await hover.scroll(0);
    await tick();
    expect(highlight.style.transform).toBe('translateY(0px)');
    await hover.point('pointermove', hover.rows[1], 20, 155);
    expect(highlight.style.transform).toBe('translateY(40px)');
    expect(highlight.style.transition).toBe('');
    expect(session.switchChat).not.toHaveBeenCalled();
});
it('clears hover over blank or covered space and does not restore it after the mouse leaves', async () => {
    await render();
    const hover = mockHoverLayout();
    await hover.point('pointerover', hover.rows[0], 20, 125);
    hover.hitTest.mockReturnValue(document.body);
    await hover.scroll(30);
    await tick();
    expect(hover.list.querySelector('.navigation-glide-highlight')).toBeNull();
    await hover.point('pointerover', hover.rows[0], 20, 125);
    await hover.scroll(40);
    await hover.point('pointerout', hover.rows[0], 300, 125, 'mouse', document.body);
    hover.hitTest.mockReturnValue(hover.rows[1]);
    await tick();
    expect(hover.list.querySelector('.navigation-glide-highlight')).toBeNull();
});
it('keeps keyboard focus highlighting and does not create hover from touch scrolling', async () => {
    await render();
    const hover = mockHoverLayout();
    await hover.point('pointerover', hover.rows[0], 20, 125, 'touch');
    await hover.scroll(30);
    await tick();
    expect(hover.list.querySelector('.navigation-glide-highlight')).toBeNull();
    expect(hover.hitTest).not.toHaveBeenCalled();
    await act(async () => hover.rows[1].querySelector('button').focus());
    expect(hover.list.querySelector('.navigation-glide-highlight').style.transform).toBe('translateY(40px)');
});
it('pins the menu target highlight when focus and pointer move into its context menu', async () => {
    await render();
    const hover = mockHoverLayout();
    await hover.point('pointerover', hover.rows[1], 20, 155);
    await act(async () => hover.rows[1].querySelector('.navigation-item-more').click());
    const menu = host.querySelector('.navigation-menu');
    expect(menu).not.toBeNull();
    await hover.point('pointerout', hover.rows[1], 300, 155, 'mouse', menu);
    await act(async () => menu.querySelector('button').focus());
    expect(hover.list.querySelector('.navigation-glide-highlight').style.transform).toBe('translateY(40px)');
    expect(hover.list.classList.contains('is-hovering')).toBe(true);
    expect(chatManager.currentChatId).toBe('a');
    expect(session.switchChat).not.toHaveBeenCalled();
    await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('.navigation-menu')).toBeNull();
});
it('shares the same navigation in a wide sidebar and a narrow fullscreen view', async () => {
    await render();
    expect(host.querySelector('#chat-navigation').classList.contains('is-visible')).toBe(true);
    await click('[data-chat-id="b"] .navigation-item-label');
    expect(session.switchChat).toHaveBeenCalledWith('b');
    await render(false, false);
    expect(host.querySelector('#chat-navigation').hasAttribute('inert')).toBe(true);
    await render(false, true);
    expect(host.querySelector('#chat-navigation').classList.contains('is-fullscreen')).toBe(true);
    await click('[data-chat-id="b"] .navigation-item-label');
    expect(close).toHaveBeenCalled();
});
it('creates a folder, moves a chat from its context menu and can collapse Chats and folders', async () => {
    await render();
    await click(button('nav_new_folder'));
    await textInput('.navigation-dialog input', 'Project');
    await act(async () =>
        host
            .querySelector('.navigation-dialog')
            .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    );
    await tick();
    const folder = chatOrganization.getSnapshot().folders[0];
    expect(folder.name).toBe('Project');
    await act(async () =>
        host
            .querySelector('[data-chat-id="a"]')
            .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 40 }))
    );
    await tick();
    expect(document.activeElement).toBe(host.querySelector('.navigation-menu'));
    await click('.navigation-menu [role="menuitem"]');
    await click('.navigation-menu [role="menuitemradio"]:nth-of-type(3)');
    expect(chatOrganization.getSnapshot().assignments.a).toBe(folder.id);
    expect(host.querySelector('[data-chat-id="a"]').classList.contains('is-nested')).toBe(true);
    await click(`[data-folder-id="${folder.id}"] .navigation-item-label`);
    expect(host.querySelector('[data-chat-id="a"]')).toBeNull();
    await click('.navigation-chats-toggle');
    expect(host.querySelectorAll('[data-chat-id]')).toHaveLength(0);
    await click('.navigation-chats-toggle');
    expect(host.querySelector('[data-chat-id="b"]')).not.toBeNull();
});
it('shows a spinner only beside the chat whose response is in progress', async () => {
    await render();
    await act(async () => uiStore.set({ phase: 'thinking', requestChatId: 'b' }));
    expect(host.querySelector('[data-chat-id="b"] [role="status"]')).not.toBeNull();
    expect(host.querySelector('[data-chat-id="a"] [role="status"]')).toBeNull();
    await act(async () => uiStore.set({ phase: 'replying', requestChatId: 'b' }));
    expect(host.querySelectorAll('.navigation-reply-spinner')).toHaveLength(1);
    await act(async () => uiStore.set({ phase: 'idle', requestChatId: null }));
    expect(host.querySelector('.navigation-reply-spinner')).toBeNull();
});
it('searches message content and restores the full list when search closes', async () => {
    await render();
    await click(button('nav_search_chats'));
    await textInput('.navigation-search input', 'find this');
    await tick();
    expect(host.querySelectorAll('[data-chat-id]')).toHaveLength(1);
    expect(host.querySelector('[data-chat-id="b"]')).not.toBeNull();
    await click(button('chat_clear_search_aria'));
    expect(host.querySelectorAll('[data-chat-id]')).toHaveLength(2);
});
it('supports keyboard context menus without activating or deleting a chat', async () => {
    await render();
    const row = host.querySelector('[data-chat-id="a"] .navigation-item-label');
    row.focus();
    await act(async () =>
        row.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })
        )
    );
    await act(async () =>
        document.activeElement.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
        )
    );
    expect(document.activeElement.textContent).toBe('nav_move_to_folder');
    await act(async () =>
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    expect(host.querySelector('.navigation-menu')).toBeNull();
    expect(session.removeChat).not.toHaveBeenCalled();
});
it('fully hides collapsed navigation and keeps the narrow full screen navigation usable', async () => {
    await render();
    await click(button('nav_collapse_sidebar'));
    expect(host.querySelector('#chat-navigation').classList.contains('is-visible')).toBe(false);
    expect(document.body.dataset.navigationCollapsed).toBe('true');
    expect(host.querySelector('.navigation-window-toggle')).not.toBeNull();
    await render(false, true);
    expect(host.querySelector('#chat-navigation').classList.contains('is-fullscreen')).toBe(true);
    expect(host.querySelectorAll('[data-chat-id]')).toHaveLength(2);
    await click(button('settings_new_chat'));
    expect(session.newChat).toHaveBeenCalledOnce();
});
it('previews without changing the saved collapsed preference and pins only on click', async () => {
    await render();
    await click(button('nav_collapse_sidebar'));
    const toggle = host.querySelector('.navigation-window-toggle');
    await act(async () =>
        toggle.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
    );
    await act(async () => toggle.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
    expect(host.querySelector('#chat-navigation').classList.contains('is-floating')).toBe(true);
    expect(chatOrganization.getSnapshot().sidebarCollapsed).toBe(true);
    expect(document.body.dataset.navigationCollapsed).toBe('true');
    await act(async () =>
        toggle.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
    );
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(host.querySelector('#chat-navigation').classList.contains('is-visible')).toBe(false);
    await act(async () => toggle.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
    await click('.navigation-window-toggle');
    expect(chatOrganization.getSnapshot().sidebarCollapsed).toBe(false);
    expect(host.querySelector('#chat-navigation').classList.contains('is-floating')).toBe(false);
    expect(host.querySelector('#chat-navigation').classList.contains('is-visible')).toBe(true);
});
it('keeps the preview open while hovering the toggle or moving between it and the panel', async () => {
    await act(async () => chatOrganization.setCollapsed('sidebar', true));
    await render();
    const toggle = host.querySelector('.navigation-window-toggle');
    const panel = host.querySelector('#chat-navigation');
    const move = async (from, to) => {
        await act(async () => {
            from.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: to }));
            to.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: from }));
        });
    };
    await move(document.body, toggle);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(panel.classList.contains('is-floating')).toBe(true);
    await move(toggle, panel);
    await act(async () => vi.advanceTimersByTimeAsync(700));
    expect(panel.classList.contains('is-floating')).toBe(true);
    await move(panel, toggle);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(panel.classList.contains('is-floating')).toBe(true);
    expect(chatOrganization.getSnapshot().sidebarCollapsed).toBe(true);
    await move(toggle, document.body);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(panel.classList.contains('is-visible')).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(panel.classList.contains('is-visible')).toBe(false);
});
it('cancels a pending close when the pointer returns and does not reopen after click-to-collapse', async () => {
    vi.stubGlobal('cerebrDesktop', { platform: 'darwin' });
    try {
        await act(async () => chatOrganization.setCollapsed('sidebar', true));
        await render();
        const toggle = host.querySelector('.navigation-window-toggle');
        const panel = host.querySelector('#chat-navigation');
        const over = () =>
            act(async () =>
                toggle.dispatchEvent(
                    new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body })
                )
            );
        const out = () =>
            act(async () =>
                toggle.dispatchEvent(
                    new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })
                )
            );
        await over();
        await out();
        await act(async () => vi.advanceTimersByTimeAsync(100));
        await over();
        await act(async () => vi.advanceTimersByTimeAsync(1000));
        expect(panel.classList.contains('is-floating')).toBe(true);
        await click('.navigation-window-toggle');
        expect(chatOrganization.getSnapshot().sidebarCollapsed).toBe(false);
        await click('.navigation-window-toggle');
        await over(); // Layout changes can generate another enter without movement.
        await act(async () => vi.advanceTimersByTimeAsync(1000));
        expect(panel.classList.contains('is-visible')).toBe(false);
        await out();
        await over();
        expect(panel.classList.contains('is-floating')).toBe(true);
    } finally {
        vi.unstubAllGlobals();
    }
});
