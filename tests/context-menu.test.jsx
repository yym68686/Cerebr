import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const data = vi.hoisted(() => ({ chat: null }));
vi.mock('../src/domain/chat/chat-store.js', () => ({
    chatManager: { getCurrentChat: () => data.chat, subscribe: () => () => {}, getSnapshot: () => 0 },
}));
vi.mock('../src/utils/i18n.js', () => ({ t: (key) => key }));
import { ContextMenu } from '../src/app/components/Overlays.jsx';
import { uiStore } from '../src/app/state/ui-store.js';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, host, session;
beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    data.chat = {
        id: 'menu-chat',
        messages: [
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'answer' },
        ],
    };
    uiStore.set({ phase: 'idle', requestChatId: null, context: null, toasts: [] });
    session = {
        startEdit: vi.fn(),
        deleteMessage: vi.fn(),
        regenerateMessage: vi.fn(),
        pipeline: { abortActiveReply: vi.fn() },
    };
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: vi.fn(async () => {}) },
    });
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
});
async function render(index = 1, extra = {}, phase = 'idle', chatId = data.chat.id) {
    const context = {
        chatId: data.chat.id,
        index,
        message: data.chat.messages[index],
        placeholder: !data.chat.messages[index],
        x: 20,
        y: 20,
        ...extra,
    };
    await act(async () => {
        uiStore.set({ phase, requestChatId: phase === 'idle' ? null : chatId });
        root.render(<ContextMenu context={context} session={session} />);
    });
    return context;
}
function ids() {
    return [...host.querySelectorAll('[role="menuitem"]')].map((el) => el.id);
}
describe('message context menu availability', () => {
    it.each([0, 1])('includes edit and delete on default example %i', async (index) => {
        data.chat.messages[index].seedLocaleBound = true;
        const context = await render(index);
        expect(ids()).toEqual(['copy-message', 'edit-message', 'delete-message']);
        await act(async () => host.querySelector('#edit-message').click());
        expect(session.startEdit).toHaveBeenCalledWith(context);
        await act(async () => host.querySelector('#delete-message').click());
        expect(session.deleteMessage).toHaveBeenCalledWith(context);
    });
    it('offers and invokes regeneration on normal messages', async () => {
        const context = await render();
        expect(ids()).toEqual(['copy-message', 'edit-message', 'regenerate-message', 'delete-message']);
        await act(async () => host.querySelector('#regenerate-message').click());
        expect(session.regenerateMessage).toHaveBeenCalledWith(context);
    });
    it('shows stop only for the selected active response, not older bubbles or another chat', async () => {
        await render(0, {}, 'replying');
        expect(ids()).not.toContain('stop-update');
        expect(ids()).toContain('edit-message');
        await render(1, {}, 'replying');
        expect(ids()).toContain('stop-update');
        expect(ids()).not.toContain('edit-message');
        expect(ids()).toContain('delete-message');
        await act(async () => host.querySelector('#stop-update').click());
        expect(session.pipeline.abortActiveReply).toHaveBeenCalledOnce();
        await render(1, {}, 'replying', 'another-chat');
        expect(ids()).not.toContain('stop-update');
    });
    it('offers stop and delete before the first token', async () => {
        data.chat.messages.pop();
        await render(1, {}, 'thinking');
        expect(ids()).toEqual(['stop-update', 'delete-message']);
    });
    it.each([
        ['code', 'const a = 1', 'copy-code', 'toast_copied_code'],
        ['math', 'E=mc^2', 'copy-math', 'toast_copied_math'],
    ])('copies the selected %s with the correct feedback', async (kind, value, id, toast) => {
        await render(1, { [kind]: value });
        expect(ids()).toContain('edit-message');
        expect(ids()).toContain('delete-message');
        await act(async () => host.querySelector(`#${id}`).click());
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(value);
        expect(uiStore.getSnapshot().toasts.at(-1).message).toBe(toast);
    });
    it('offers image copy alongside message actions', async () => {
        await render(1, { image: 'data:image/png;base64,AQ==' });
        expect(ids()).toContain('copy-image');
        expect(ids()).toContain('edit-message');
        expect(ids()).toContain('delete-message');
    });
    it('opens without choosing an action, then supports arrow navigation and Enter', async () => {
        await render();
        const menu = host.querySelector('#context-menu');
        const press = async (key) =>
            act(async () =>
                document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
            );
        expect(document.activeElement).toBe(menu);
        await press('Enter');
        expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
        await press('ArrowDown');
        expect(document.activeElement.id).toBe('copy-message');
        await press('ArrowUp');
        expect(document.activeElement.id).toBe('delete-message');
        await press('ArrowDown');
        expect(document.activeElement.id).toBe('copy-message');
        await press('Enter');
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('answer');
        expect(session.deleteMessage).not.toHaveBeenCalled();
    });
    it('starts at the last action when ArrowUp is the first navigation key', async () => {
        await render();
        await act(async () =>
            document.activeElement.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })
            )
        );
        expect(document.activeElement.id).toBe('delete-message');
    });
    it('keeps focus during request changes and recovers it when the focused action disappears', async () => {
        await render();
        host.querySelector('#regenerate-message').focus();
        await act(async () => uiStore.set({ phase: 'replying', requestChatId: data.chat.id }));
        expect(document.activeElement.id).toBe('regenerate-message');
        host.querySelector('#stop-update').focus();
        await act(async () => uiStore.set({ phase: 'idle', requestChatId: null }));
        expect(document.activeElement).toBe(host.querySelector('#context-menu'));
    });
    it('supports Home, End and Escape with focus restored', async () => {
        const input = document.createElement('input');
        document.body.append(input);
        input.focus();
        await render(1, { returnFocus: input });
        const menu = host.querySelector('#context-menu');
        await act(async () =>
            menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
        );
        expect(document.activeElement.id).toBe('delete-message');
        await act(async () =>
            menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
        );
        expect(document.activeElement.id).toBe('copy-message');
        await act(async () =>
            menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        );
        expect(document.activeElement).toBe(input);
        input.remove();
    });
});
