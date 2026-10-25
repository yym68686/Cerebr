import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const environment = vi.hoisted(() => ({ desktop: true, extension: false }));
vi.mock('../src/utils/i18n.js', () => ({ t: (key) => key }));
vi.mock('../src/utils/storage-adapter.js', () => ({
    get isExtensionEnvironment() {
        return environment.extension;
    },
}));
vi.mock('../src/runtime/sync/cloud-sync.js', async () => {
    const { createStore } = await import('../src/app/state/store.js');
    return { cloudSyncStore: createStore({}), cloudSyncAction: vi.fn() };
});
vi.mock('../src/runtime/sync/ui-sync.js', async () => {
    const { createStore } = await import('../src/app/state/store.js');
    return {
        desktopSyncStore: createStore({}),
        get isDesktop() {
            return environment.desktop;
        },
        pairDesktop: vi.fn(),
        refreshDesktopPairing: vi.fn(),
        verifyDesktopSync: vi.fn(),
        disconnectDesktopSync: vi.fn(),
    };
});
import { SyncSettings } from '../src/app/components/SyncSettings.jsx';
import {
    desktopSyncStore,
    pairDesktop,
    refreshDesktopPairing,
    verifyDesktopSync,
    disconnectDesktopSync,
} from '../src/runtime/sync/ui-sync.js';
import { cloudSyncStore, cloudSyncAction } from '../src/runtime/sync/cloud-sync.js';
let host, root;
const click = (selector) => act(async () => host.querySelector(selector).click());
const fill = (selector, value) =>
    act(async () => {
        const input = host.querySelector(selector);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    environment.desktop = true;
    environment.extension = false;
    vi.clearAllMocks();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    desktopSyncStore.set({
        connected: true,
        peers: 1,
        pairingCode: 'ABCDEF0123',
        localSummary: { chats: 4, messages: 11 },
        verification: null,
    });
    cloudSyncStore.set({
        user: { username: 'demo' },
        connected: true,
        localSummary: { chats: 4, messages: 11 },
    });
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
});
it('shares one live total and keeps desktop pairing and integrity actions available when connected', async () => {
    await act(async () => root.render(<SyncSettings />));
    expect(host.querySelectorAll('.sync-stat')).toHaveLength(2);
    expect(host.querySelectorAll('.sync-channel')).toHaveLength(2);
    expect(host.querySelector('#local-sync-detail')).toBeNull();
    await click('[aria-controls="local-sync-detail"]');
    expect(refreshDesktopPairing).toHaveBeenCalledOnce();
    expect(host.querySelector('.sync-pairing-code').textContent).toBe('ABCDE F0123');
    await click('#local-sync-detail .sync-actions button');
    expect(verifyDesktopSync).toHaveBeenCalledOnce();
    await click('[aria-controls="local-sync-detail"]');
    expect(host.querySelector('#local-sync-detail')).toBeNull();
});
it('pairs an extension with the entered code and exposes disconnect after connection', async () => {
    environment.desktop = false;
    environment.extension = true;
    desktopSyncStore.set({ connected: false });
    await act(async () => root.render(<SyncSettings />));
    await click('[aria-controls="local-sync-detail"]');
    expect(host.querySelector('button[type="submit"]').disabled).toBe(true);
    await fill('#desktop-pairing-code', 'abcdef0123');
    expect(host.querySelector('button[type="submit"]').disabled).toBe(false);
    await act(async () =>
        host
            .querySelector('#local-sync-detail form')
            .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    );
    expect(pairDesktop).toHaveBeenCalledWith('ABCDEF0123');
    await act(async () => desktopSyncStore.set({ connected: true }));
    expect(host.querySelector('#desktop-pairing-code')).toBeNull();
    await click('.sync-disconnect');
    expect(disconnectDesktopSync).toHaveBeenCalledOnce();
});
it('retains registration behind the cloud login disclosure on the web', async () => {
    environment.desktop = false;
    cloudSyncStore.set({ user: null, connected: false });
    await act(async () => root.render(<SyncSettings />));
    expect(host.querySelector('#desktop-sync-settings')).toBeNull();
    await click('[aria-controls="cloud-sync-auth"]');
    await click('[role="tab"]:nth-child(2)');
    await fill('[autocomplete="username"]', 'new_user');
    await fill('[type="password"]', 'test-password-123');
    cloudSyncAction.mockResolvedValueOnce({ ok: true });
    await act(async () =>
        host
            .querySelector('#cloud-sync-auth')
            .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    );
    expect(cloudSyncAction).toHaveBeenCalledWith('register', {
        username: 'new_user',
        password: 'test-password-123',
    });
    expect(host.querySelector('[type="password"]').value).toBe('');
});

it('keeps the password and shows an error when cloud login does not complete', async () => {
    environment.desktop = false;
    cloudSyncStore.set({ user: null, connected: false });
    await act(async () => root.render(<SyncSettings />));
    await click('[aria-controls="cloud-sync-auth"]');
    await fill('[autocomplete="username"]', 'demo_user');
    await fill('[type="password"]', 'test-password-123');
    cloudSyncAction.mockRejectedValueOnce(new Error('云端同步请求未收到响应。'));

    await act(async () =>
        host
            .querySelector('#cloud-sync-auth')
            .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    );

    expect(host.querySelector('[type="password"]').value).toBe('test-password-123');
    expect(host.querySelector('[role="alert"]').textContent).toBe('云端同步请求未收到响应。');
});
