import { act, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsMenu } from '../src/app/hooks/useSettingsMenu.js';
import { uiStore } from '../src/app/state/ui-store.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, host, button;

function Menu() {
    const state = useSyncExternalStore(uiStore.subscribe, uiStore.getSnapshot);
    const events = useSettingsMenu();
    return (
        <>
            <button id="settings-button" {...events.button} aria-expanded={state.menu} />
            {state.menu && <div id="settings-menu" />}
            {state.webpageMenu && <div id="webpage-content-menu" />}
        </>
    );
}

beforeEach(async () => {
    vi.useFakeTimers();
    uiStore.set({ menu: false, webpageMenu: false });
    const rects = {
        'settings-button': [0, 500, 44, 48],
        'settings-menu': [0, 200, 200, 290],
        'webpage-content-menu': [210, 200, 200, 200],
    };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
        const [left, top, width, height] = rects[this.id] || [0, 0, 0, 0];
        return { left, top, width, height, right: left + width, bottom: top + height };
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Menu />));
    button = host.querySelector('button');
});

afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

async function pointer(target, type, options = {}, pointerType = 'mouse') {
    const event = new MouseEvent(type, { bubbles: true, ...options });
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    await act(async () => target.dispatchEvent(event));
}
const advance = (ms) => act(async () => vi.advanceTimersByTime(ms));
const move = (x, y) => pointer(document, 'pointermove', { clientX: x, clientY: y });
const expanded = () => button.getAttribute('aria-expanded') === 'true';
async function hover() {
    await pointer(button, 'pointerover', { relatedTarget: document.body });
    await advance(140);
    expect(expanded()).toBe(true);
}

describe('settings menu hover and click behavior', () => {
    it('closes the hover-opened menu and submenu after leaving for 280 ms', async () => {
        await hover();
        await act(async () => uiStore.set({ webpageMenu: true }));
        await move(600, 100);
        await advance(279);
        expect(expanded()).toBe(true);
        await advance(1);
        expect(expanded()).toBe(false);
        expect(host.querySelector('#webpage-content-menu')).toBeNull();
    });

    it.each([
        [100, 300],
        [65, 520],
        [300, 300],
    ])('cancels closing when returning to a safe region at %i, %i', async (x, y) => {
        await hover();
        await act(async () => uiStore.set({ webpageMenu: true }));
        await move(600, 100);
        await advance(200);
        await move(x, y);
        await advance(300);
        expect(expanded()).toBe(true);
        await move(600, 100);
        await advance(280);
        expect(expanded()).toBe(false);
    });

    it('keeps the first hover click open and pinned, then closes on the second click', async () => {
        await hover();
        await move(600, 100);
        await act(async () => button.click());
        await advance(300);
        expect(expanded()).toBe(true);
        await move(600, 100);
        await advance(300);
        expect(expanded()).toBe(true);
        await act(async () => button.click());
        expect(expanded()).toBe(false);
        await hover();
        await move(600, 100);
        await advance(280);
        expect(expanded()).toBe(false);
    });

    it('does not reopen from a pending hover after a quick click toggle', async () => {
        await pointer(button, 'pointerover', { relatedTarget: document.body });
        await act(async () => button.click());
        expect(expanded()).toBe(true);
        await act(async () => button.click());
        await advance(300);
        expect(expanded()).toBe(false);
    });

    it('ignores touch hover and cancels opening when the pointer leaves early', async () => {
        await pointer(button, 'pointerover', {}, 'touch');
        await advance(300);
        expect(expanded()).toBe(false);
        await pointer(button, 'pointerover', { relatedTarget: document.body });
        await advance(100);
        await pointer(button, 'pointerout', { relatedTarget: document.body });
        await advance(300);
        expect(expanded()).toBe(false);
    });

    it('closes when leaving the document and cancels timers after external dismissal', async () => {
        await hover();
        await pointer(button, 'pointerout', { relatedTarget: null });
        await advance(280);
        expect(expanded()).toBe(false);
        await hover();
        await move(600, 100);
        await act(async () => uiStore.set({ menu: false, webpageMenu: false }));
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => button.click());
        await advance(300);
        expect(expanded()).toBe(true);
    });
});
