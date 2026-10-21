import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const data = vi.hoisted(() => ({ memory: {}, listeners: new Set() }));
vi.mock('../src/utils/storage-adapter.js', () => {
    const storage = {
        get: async (keys) =>
            Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, data.memory[key]])),
        set: async (values) => Object.assign(data.memory, structuredClone(values)),
    };
    return { storageAdapter: storage, syncStorageAdapter: storage };
});
vi.mock('../src/utils/i18n.js', () => ({ t: (key) => key }));
import { SelectionActions } from '../src/app/components/SelectionActions.jsx';
import {
    selectionStore,
    setPageSelectionEnabled,
    PAGE_SELECTION_KEY,
    ACTIONS_KEY,
    loadSelectionSettings,
} from '../src/runtime/selection/selection-store.js';
import { readTextSelection } from '../src/runtime/selection/watch-selection.js';
let root, host, passage, add, send;
const surface = () => host.querySelector('[data-selection-actions]')?.shadowRoot;
const scope = () => document.querySelector('#passage');
const tick = () => act(async () => vi.advanceTimersByTimeAsync(40));
const select = async () => {
    await act(async () => {
        const range = document.createRange();
        range.selectNodeContents(passage);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        await vi.advanceTimersByTimeAsync(200);
    });
};
const render = async (page = false) => {
    await act(async () =>
        root.render(<SelectionActions scope={scope} page={page} onAdd={add} onSend={send} />)
    );
    await tick();
};
const click = async (selector) => {
    await act(async () => surface().querySelector(selector).click());
    await tick();
};
const fill = async (selector, value) =>
    act(async () => {
        const el = surface().querySelector(selector);
        Object.getOwnPropertyDescriptor(
            el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
            'value'
        ).set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    });
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    data.memory = {};
    data.listeners.clear();
    vi.stubGlobal('chrome', {
        storage: {
            onChanged: {
                addListener: (fn) => data.listeners.add(fn),
                removeListener: (fn) => data.listeners.delete(fn),
            },
        },
    });
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            disconnect() {}
        }
    );
    Range.prototype.getBoundingClientRect = () => ({
        left: 100,
        top: 200,
        right: 240,
        bottom: 220,
        width: 140,
        height: 20,
    });
    selectionStore.set({ pageEnabled: true, actions: [], ready: false });
    host = document.createElement('div');
    passage = document.createElement('div');
    passage.id = 'passage';
    passage.textContent = 'A selected passage.';
    document.body.append(passage, host);
    root = createRoot(host);
    add = vi.fn();
    send = vi.fn(async () => true);
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    passage.remove();
    window.getSelection().removeAllRanges();
    vi.clearAllTimers();
    vi.useRealTimers();
    delete Range.prototype.getBoundingClientRect;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
it('adds the captured selection or sends a follow-up without IME Enter submitting early', async () => {
    await render();
    await select();
    expect(host.querySelector('[data-selection-actions]')).not.toBeNull();
    await click('[data-action=add]');
    expect(add).toHaveBeenCalledWith('A selected passage.');
    await select();
    await fill('[aria-label=selection_follow_up]', 'Why?');
    const input = surface().querySelector('[aria-label=selection_follow_up]');
    input.focus();
    document.dispatchEvent(new Event('selectionchange'));
    await tick();
    const key = new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
    });
    await act(async () => input.dispatchEvent(key));
    expect(key.defaultPrevented).toBe(true);
    expect(send).not.toHaveBeenCalled();
    await act(async () =>
        surface()
            .querySelector('form')
            .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    );
    expect(send).toHaveBeenCalledWith('A selected passage.', 'Why?');
    expect(host.querySelector('[data-selection-actions]')).toBeNull();
});
it('keeps the toolbar and question when sending is rejected', async () => {
    send.mockResolvedValue(false);
    await render();
    await select();
    await fill('[aria-label=selection_follow_up]', 'Keep this question');
    await click('[aria-label=composer_send]');
    expect(surface().querySelector('[aria-label=selection_follow_up]').value).toBe('Keep this question');
});
it.each([false, true])('preserves the passage while typing and clears it on submission (page=%s)', async (page) => {
    const highlights = new Map();
    vi.stubGlobal('CSS', { highlights });
    vi.stubGlobal('Highlight', class extends Set {
        constructor(...ranges) { super(ranges); }
    });
    await render(page);
    await select();
    expect(highlights.size).toBe(1);
    const [range] = [...highlights.values()][0];
    await act(async () => {
        const input = surface().querySelector('[aria-label=selection_follow_up]');
        input.dispatchEvent(new MouseEvent('pointerdown', {bubbles:true,composed:true}));
        input.focus();
        window.getSelection().removeAllRanges();
        document.dispatchEvent(new Event('selectionchange'));
    });
    await tick();
    await fill('[aria-label=selection_follow_up]', 'Why?');
    expect(highlights.size).toBe(1);
    expect(range.toString()).toBe('A selected passage.');
    expect(passage.innerHTML).toBe('A selected passage.');
    await click('[aria-label=composer_send]');
    expect(host.querySelector('[data-selection-actions]')).toBeNull();
    expect(highlights.size).toBe(0);
    document.dispatchEvent(new Event('selectionchange'));
    window.dispatchEvent(new Event('scroll'));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(host.querySelector('[data-selection-actions]')).toBeNull();
});
it('saves a named icon/prompt action, reloads it and sends it with the selected text', async () => {
    await render();
    await select();
    await click('[aria-label=selection_customize]');
    await click('[data-action=customize]');
    await fill('.selection-customizer input', 'Translate');
    await fill('.selection-customizer textarea', 'Translate into English.');
    await click('.selection-icon-options button:nth-child(3)');
    await act(async () =>
        surface()
            .querySelector('.selection-save')
            .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }))
    );
    window.getSelection().removeAllRanges();
    await click('.selection-save');
    document.dispatchEvent(new Event('selectionchange'));
    await tick();
    expect(host.querySelector('[data-selection-actions]')).not.toBeNull();
    expect(data.memory[ACTIONS_KEY][0]).toMatchObject({
        name: 'Translate',
        icon: 'search',
        prompt: 'Translate into English.',
    });
    await act(async () => loadSelectionSettings());
    await click('[aria-label=selection_customize]');
    await click(`[data-action="${data.memory[ACTIONS_KEY][0].id}"]`);
    expect(send).toHaveBeenCalledWith('A selected passage.', 'Translate into English.');
});
it('enables page selections by default, disables them immediately and keeps chat selections working', async () => {
    await render(true);
    await select();
    expect(host.querySelector('[data-selection-actions]')).not.toBeNull();
    await act(async () => setPageSelectionEnabled(false));
    expect(data.memory[PAGE_SELECTION_KEY]).toBe(false);
    expect(host.querySelector('[data-selection-actions]')).toBeNull();
    await render(false);
    await select();
    expect(host.querySelector('[data-selection-actions]')).not.toBeNull();
    await render(true);
    await act(async () =>
        data.listeners.forEach((listener) => listener({ [PAGE_SELECTION_KEY]: { newValue: true } }, 'sync'))
    );
    await select();
    expect(host.querySelector('[data-selection-actions]')).not.toBeNull();
});
it('ignores editable text and selections crossing outside the chat', async () => {
    passage.setAttribute('contenteditable', 'true');
    await select();
    expect(readTextSelection(passage)).toBeNull();
    passage.removeAttribute('contenteditable');
    const outside = document.createTextNode('outside');
    host.append(outside);
    const range = document.createRange();
    range.setStart(passage.firstChild, 0);
    range.setEnd(outside, 3);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    expect(readTextSelection(passage)).toBeNull();
});

it('treats typed action names as questions and keeps collapsed actions out of keyboard navigation', async () => {
    await render();
    await select();
    expect(surface().querySelector('[data-action=customize]').closest('[inert]')).not.toBeNull();
    await fill('[aria-label=selection_follow_up]', 'explain');
    expect(surface().querySelector('[data-action=add]').closest('[inert]')).not.toBeNull();
    await click('[aria-label=composer_send]');
    expect(send).toHaveBeenCalledWith('A selected passage.', 'explain');
});
it('anchors the toolbar below the final selected line', async () => {
    await render();
    await select();
    expect(host.querySelector('[data-selection-actions]').style.top).toBe('228px');
});
