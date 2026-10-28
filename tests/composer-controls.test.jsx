import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/utils/i18n.js', () => ({ t: (key) => key }));
vi.mock('../src/app/state/api-configs.js', () => ({ selectConfig: vi.fn(async () => {}) }));
import { selectConfig } from '../src/app/state/api-configs.js';
import { ComposerControls } from '../src/app/components/ComposerControls.jsx';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, host, session, settings, resize;
const apis = {
    selected: 0,
    configs: [
        { id: 'a', modelName: 'Model A' },
        { id: 'b', modelName: 'Model B' },
    ],
};
beforeEach(() => {
    vi.stubGlobal(
        'ResizeObserver',
        class {
            constructor(callback) {
                resize = callback;
            }
            observe() {}
            disconnect() {}
        }
    );
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    session = { confirmEdit: vi.fn(), pipeline: { sendMessage: vi.fn(), abortActiveReply: vi.fn() } };
    settings = vi.fn();
    vi.clearAllMocks();
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
const render = async (draft = { empty: false, composing: false }, ui = { phase: 'idle' }) =>
    act(async () =>
        root.render(
            <ComposerControls apis={apis} session={session} ui={ui} draft={draft} onSettings={settings} />
        )
    );
const click = async (selector) => act(async () => host.querySelector(selector).click());
describe('Prompt Bar controls', () => {
    it('displays the conversation’s model and routes explicit switches through the session', async () => {
        session.selectModel=vi.fn(async()=>{});
        const chat={id:'old',modelSelection:{configId:'b',modelName:'Model B'}};
        await act(async()=>root.render(<ComposerControls apis={apis} chat={chat} session={session} ui={{phase:'idle'}} draft={{empty:false}} onSettings={settings}/>));
        expect(host.querySelector('.composer-model').title).toBe('Model B');
        await click('.composer-model');
        const entries=host.querySelectorAll('[role="menuitemradio"]');
        expect(entries[1].getAttribute('aria-checked')).toBe('true');
        await act(async()=>entries[0].click());
        expect(session.selectModel).toHaveBeenCalledWith(0);
        expect(selectConfig).not.toHaveBeenCalled();
    });
    it('replaces a label that does not fit with an icon and restores it when there is space', async () => {
        await render();
        const button = host.querySelector('.composer-model');
        const label = host.querySelector('.composer-model-label');
        vi.spyOn(label, 'getBoundingClientRect').mockReturnValue({ width: 120 });
        button.style.maxWidth = '119px';
        await act(async () => resize());
        expect(button.classList.contains('is-icon-only')).toBe(true);
        expect(button.title).toBe('Model A');
        expect(button.getAttribute('aria-label')).toContain('Model A');
        await click('.composer-model');
        expect(host.querySelector('#composer-model-menu')).not.toBeNull();
        await act(async () => resize());
        expect(button.classList.contains('is-icon-only')).toBe(true);
        button.style.maxWidth = '120px';
        await act(async () => resize());
        expect(button.classList.contains('is-icon-only')).toBe(false);
        expect(label.textContent).toBe('Model A');
        expect(host.querySelector('#composer-model-menu')).not.toBeNull();
    });
    it('disables empty and composing drafts but sends nonempty drafts', async () => {
        await render({ empty: true });
        expect(host.querySelector('.composer-send').disabled).toBe(true);
        await render({ empty: false, composing: true });
        expect(host.querySelector('.composer-send').disabled).toBe(true);
        await render();
        await click('.composer-send');
        expect(session.pipeline.sendMessage).toHaveBeenCalledOnce();
    });
    it('stops an active response with an empty draft and confirms message edits', async () => {
        await render({ empty: true }, { phase: 'replying' });
        expect(host.querySelector('.composer-send').disabled).toBe(false);
        await click('.composer-send');
        expect(session.pipeline.abortActiveReply).toHaveBeenCalledOnce();
        await render({ empty: false }, { phase: 'idle', editing: { index: 1 } });
        await click('#confirm-edit-button');
        expect(session.confirmEdit).toHaveBeenCalledOnce();
        expect(session.pipeline.sendMessage).not.toHaveBeenCalled();
    });
    it('blocks sending and edit confirmation during file parsing but still allows stopping a response', async () => {
        await render({ empty: false, readingFiles: true });
        expect(host.querySelector('.composer-send').disabled).toBe(true);
        await render({ empty: false, readingFiles: true }, { phase: 'replying' });
        expect(host.querySelector('.composer-send').disabled).toBe(false);
        await click('.composer-send');
        expect(session.pipeline.abortActiveReply).toHaveBeenCalledOnce();
        await render({ empty: false, readingFiles: true }, { phase: 'replying', editing: { index: 1 } });
        expect(host.querySelector('.composer-send').disabled).toBe(true);
        expect(session.confirmEdit).not.toHaveBeenCalled();
    });
    it('navigates real model configs, persists selection, and restores focus on Escape', async () => {
        await render();
        await click('.composer-model');
        const key = async (key) =>
            act(async () =>
                document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
            );
        expect(document.activeElement.id).toBe('composer-model-menu');
        await key('ArrowDown');
        expect(document.activeElement.textContent).toBe('Model A');
        await key('ArrowDown');
        await act(async () => document.activeElement.click());
        expect(selectConfig).toHaveBeenCalledWith(1);
        expect(document.activeElement).toBe(host.querySelector('.composer-model'));
        await click('.composer-model');
        await key('Escape');
        expect(host.querySelector('#composer-model-menu')).toBeNull();
        expect(document.activeElement).toBe(host.querySelector('.composer-model'));
    });
});
