import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
    PluginPage,
    PluginInputActions,
    PluginMenuItems,
    PluginSlashCommands,
    PluginModals,
} from '../src/app/components/PluginSurfaces.jsx';
import { createShellHostManager } from '../src/runtime/ui/shell-host-manager.js';
import { pluginUiStore } from '../src/runtime/ui/plugin-ui-store.js';
import { createEditorController } from '../src/runtime/input/editor-controller.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, host, manager;
beforeEach(async () => {
    document.body.innerHTML =
        '<div id="test-root"></div><div id="input-container"><div id="message-input" contenteditable="true"></div></div><div id="slot"></div>';
    pluginUiStore.set({ actions: [], menu: [], commands: null, page: null, modals: [] });
    host = document.getElementById('test-root');
    root = createRoot(host);
    await act(async () =>
        root.render(
            <>
                <PluginPage />
                <PluginInputActions />
                <PluginMenuItems />
                <PluginSlashCommands />
                <PluginModals />
            </>
        )
    );
    const messageInput = document.getElementById('message-input');
    manager = createShellHostManager({
        messageInput,
        inputContainer: document.getElementById('input-container'),
        editor: createEditorController({ messageInput }),
        pageElements: {
            root: document.getElementById('plugin-shell-page'),
            bodyElement: document.getElementById('plugin-shell-page-body'),
        },
    });
});
afterEach(async () => {
    await act(async () => {
        manager.dispose();
        root.unmount();
    });
});
const view = (value) => ({
    sections: [
        {
            id: 'form',
            kind: 'card',
            title: 'Settings',
            body: [
                { kind: 'form', id: 'inputs', fields: [{ id: 'name', type: 'text', value, label: 'Name' }] },
                { kind: 'actions', id: 'buttons', actions: [{ id: 'save', label: 'Save' }] },
            ],
        },
    ],
});
describe('React plugin host contract', () => {
    it('retains edited fields across view updates, emits current values, and honors resetViewState', async () => {
        const listener = vi.fn();
        manager.onPageEvent('test', listener);
        await act(async () =>
            manager.openPage('test', null, { id: 'settings', title: 'Settings', view: view('initial') })
        );
        const input = host.querySelector('input');
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'edited');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => manager.updatePage('test', { view: view('initial') }));
        expect(host.querySelector('input')).toBe(input);
        expect(input.value).toBe('edited');
        await act(async () => host.querySelector('[data-action-id="save"]').click());
        expect(listener.mock.calls.at(-1)[0]).toMatchObject({
            type: 'action',
            actionId: 'save',
            values: { name: 'edited' },
            page: { id: 'settings' },
        });
        await act(async () => manager.updatePage('test', { view: view('reset'), resetViewState: true }));
        expect(host.querySelector('input').value).toBe('reset');
        await act(async () => manager.closeActivePage('back'));
        expect(listener.mock.calls.at(-1)[0]).toMatchObject({ type: 'close', reason: 'back' });
    });
    it('keeps input-action and menu payloads and removes unsafe SVG attributes', async () => {
        const action = vi.fn(),
            menu = vi.fn();
        manager.onInputAction('test', action);
        manager.onMenuAction('test', menu);
        await act(async () => {
            manager.setInputActions('test', [{ id: 'run', label: 'Run' }]);
            manager.setMenuItems('test', [
                {
                    id: 'open',
                    label: 'Open',
                    iconSvg:
                        '<svg onload="alert(1)"><script>bad()</script><path d="M0 0" onclick="bad()"/></svg>',
                },
            ]);
        });
        await act(async () => {
            host.querySelector('[data-action-id="run"]').click();
            host.querySelector('[data-plugin-menu-item="open"]').click();
        });
        expect(action.mock.calls[0][0]).toMatchObject({ actionId: 'run', action: { label: 'Run' } });
        expect(menu.mock.calls[0][0]).toMatchObject({ itemId: 'open' });
        expect(host.querySelector('script,[onload],[onclick]')).toBe(null);
    });
    it('returns a synchronous modal element and restores the exact plugin node on dismissal', async () => {
        const node = document.createElement('div');
        node.textContent = 'plugin';
        document.getElementById('slot').append(node);
        let handle;
        await act(async () => {
            handle = manager.showModal('test', node, { fillHeight: true });
            expect(handle.element).toBeInstanceOf(HTMLElement);
        });
        expect(handle.element.contains(node)).toBe(true);
        await act(async () => {
            manager.hideModal('test');
            expect(document.getElementById('slot').firstChild).toBe(node);
        });
        expect(document.getElementById('slot').firstChild).toBe(node);
    });
    it('expands slash commands through the existing editor without submitting a chat', async () => {
        const listener = vi.fn();
        manager.onSlashCommandEvent(listener);
        await act(async () =>
            manager.setSlashCommands('test', [
                { id: 'ask', name: 'ask', label: 'Ask', prompt: 'Explain', separator: '\n' },
            ])
        );
        const input = document.getElementById('message-input');
        await act(async () => {
            input.textContent = '/ask topic';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () =>
            input.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
            )
        );
        expect(createEditorController({ messageInput: input }).getDraft()).toBe('Explain\ntopic');
        expect(listener.mock.calls.at(-1)[0]).toMatchObject({
            type: 'select',
            commandId: 'ask',
            trailingText: 'topic',
        });
    });
});
