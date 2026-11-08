import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/storage-adapter.js', () => ({ isExtensionEnvironment: true }));
import { attachSidebarDrag } from '../src/platform/sidebar-drag.js';

let chat, parent, detach, captured;
const browserWindow = window;
beforeEach(() => {
    vi.useFakeTimers();
    parent = { postMessage: vi.fn() };
    vi.stubGlobal('window', {
        top: {}, parent,
        addEventListener: browserWindow.addEventListener.bind(browserWindow),
    });
    chat = document.createElement('div');
    chat.innerHTML = '<div class="message">Selectable message</div><button>Action</button><div class="blank"></div>';
    document.body.append(chat);
    captured = new Set();
    chat.setPointerCapture = vi.fn((id) => captured.add(id));
    chat.hasPointerCapture = (id) => captured.has(id);
    chat.releasePointerCapture = vi.fn((id) => captured.delete(id));
    detach = attachSidebarDrag(chat);
});
afterEach(() => {
    detach();
    chat.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
const pointer = (type, x, y, options = {}, target = chat) => {
    const event = new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
        screenX: x, screenY: y, ...options,
    });
    Object.defineProperties(event, {
        pointerId: { value: options.pointerId ?? 7 },
        pointerType: { value: options.pointerType || 'mouse' },
    });
    target.dispatchEvent(event);
    return event;
};
const messages = () => parent.postMessage.mock.calls.map(([message]) => message);
const start = () => {
    pointer('pointerdown', 500, 300);
    pointer('pointermove', 510, 310);
};

describe('extension sidebar drag pointer ownership', () => {
    it('prevents native selection from pointerdown and sends absolute screen coordinates despite iframe-local changes', () => {
        const down = pointer('pointerdown', 500, 300, {}, chat.querySelector('.blank'));
        expect(down.defaultPrevented).toBe(true);
        expect(captured.has(7)).toBe(true);
        pointer('pointermove', 502, 301);
        expect(messages()).toEqual([]);
        const move = pointer('pointermove', 510, 310, { clientX: 100, clientY: 100 });
        expect(move.defaultPrevented).toBe(true);
        pointer('pointermove', 530, 320, { clientX: 90, clientY: 95 });
        expect(messages()).toEqual([
            { type: 'CEREBR_SIDEBAR_DRAG_START', screenX: 500, screenY: 300 },
            { type: 'CEREBR_SIDEBAR_DRAG_MOVE', screenX: 510, screenY: 310 },
            { type: 'CEREBR_SIDEBAR_DRAG_MOVE', screenX: 530, screenY: 320 },
        ]);
        expect(document.documentElement.classList.contains('cerebr-sidebar-dragging')).toBe(true);
        for (const type of ['selectstart', 'dragstart']) {
            const event = new Event(type, { bubbles: true, cancelable: true });
            chat.querySelector('.message').dispatchEvent(event);
            expect(event.defaultPrevented).toBe(true);
        }
        pointer('pointerup', 540, 330);
        expect(messages().slice(-2)).toEqual([
            { type: 'CEREBR_SIDEBAR_DRAG_MOVE', screenX: 540, screenY: 330 },
            { type: 'CEREBR_SIDEBAR_DRAG_END' },
        ]);
        expect(captured.size).toBe(0);
        expect(document.documentElement.classList.contains('cerebr-sidebar-dragging')).toBe(false);
    });

    it.each(['.message', 'button'])('leaves native selection and controls untouched when starting on %s', (selector) => {
        expect(pointer('pointerdown', 500, 300, {}, chat.querySelector(selector)).defaultPrevented).toBe(false);
        pointer('pointermove', 520, 320);
        expect(chat.setPointerCapture).not.toHaveBeenCalled();
        expect(messages()).toEqual([]);
        const selection = new Event('selectstart', { bubbles: true, cancelable: true });
        chat.dispatchEvent(selection);
        expect(selection.defaultPrevented).toBe(false);
    });

    it('ignores touch, secondary buttons and unrelated pointer IDs', () => {
        pointer('pointerdown', 500, 300, { pointerType: 'touch' });
        pointer('pointerdown', 500, 300, { button: 2 });
        expect(captured.size).toBe(0);
        pointer('pointerdown', 500, 300);
        pointer('pointermove', 550, 350, { pointerId: 8 });
        pointer('pointerup', 550, 350, { pointerId: 8 });
        expect(messages()).toEqual([]);
        expect(captured.has(7)).toBe(true);
    });

    it.each(['pointercancel', 'lostpointercapture', 'blur', 'buttons', 'parent', 'dispose'])(
        'releases capture and selection locks on %s', (reason) => {
            start();
            if (reason === 'blur') browserWindow.dispatchEvent(new Event('blur'));
            else if (reason === 'buttons') pointer('pointermove', 520, 320, { buttons: 0 });
            else if (reason === 'parent') browserWindow.dispatchEvent(new MessageEvent('message', {
                source: parent, data: { type: 'CEREBR_SIDEBAR_DRAG_CANCEL' },
            }));
            else if (reason === 'dispose') detach();
            else pointer(reason, 520, 320);
            expect(captured.size).toBe(0);
            expect(document.documentElement.classList.contains('cerebr-sidebar-dragging')).toBe(false);
            expect(messages().at(-1)).toEqual({ type: 'CEREBR_SIDEBAR_DRAG_END' });
            const count = messages().length;
            pointer('pointermove', 530, 330);
            expect(messages()).toHaveLength(count);
        }
    );

    it('suppresses the release click even after a long drag, then allows deliberate clicks', async () => {
        start();
        await vi.advanceTimersByTimeAsync(2000);
        pointer('pointerup', 530, 330);
        const click = () => {
            const event = new MouseEvent('click', { bubbles: true, cancelable: true });
            chat.dispatchEvent(event);
            return event;
        };
        expect(click().defaultPrevented).toBe(true);
        await vi.advanceTimersByTimeAsync(500);
        expect(click().defaultPrevented).toBe(false);
    });
});
