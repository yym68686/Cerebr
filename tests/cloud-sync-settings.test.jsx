import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
vi.mock('../src/utils/i18n.js', () => ({ t: key => key }));
vi.mock('../src/runtime/sync/cloud-sync.js', async () => {
    const { createStore } = await import('../src/app/state/store.js');
    return { cloudSyncStore: createStore({}), cloudSyncAction: vi.fn() };
});
import { SyncSettings } from '../src/app/components/SyncSettings.jsx';
vi.mock('../src/runtime/sync/ui-sync.js', async () => {
 const { createStore } = await import('../src/app/state/store.js');
 return {desktopSyncStore:createStore({}),isDesktop:false};
});
vi.mock('../src/utils/storage-adapter.js',()=>({isExtensionEnvironment:false}));
import { cloudSyncStore, cloudSyncAction } from '../src/runtime/sync/cloud-sync.js';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

it('updates visible chat and message totals while syncing instead of waiting for the final summary', async () => {
    const host = document.createElement('div'), root = createRoot(host);
    document.body.append(host);
    try {
        cloudSyncStore.set({ user: { username: 'test' }, connecting: true, connected: false, syncing: true,
            summary: { chats: 0, messages: 0 }, localSummary: { chats: 3, messages: 12 } });
        await act(async () => root.render(<SyncSettings />));
        expect([...host.querySelectorAll('.sync-stat strong')].map(el => el.textContent)).toEqual(['3', '12']);
        expect(host.querySelector('[role="status"]').textContent).toBe('cloud_sync_syncing');
        await act(async () => cloudSyncStore.set({ localSummary: { chats: 8, messages: 27 } }));
        expect([...host.querySelectorAll('.sync-stat strong')].map(el => el.textContent)).toEqual(['8', '27']);
        await act(async () => cloudSyncStore.set({ connected: true, connecting: false, syncing: false }));
        expect(host.querySelector('[role="status"]').textContent).toBe('desktop_sync_connected');
    } finally { await act(async () => root.unmount()); host.remove(); }
});

it('shows an active sync action and a real mismatch rather than waiting indefinitely', async () => {
    const host = document.createElement('div'), root = createRoot(host);
    let finish;
    cloudSyncAction.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    try {
        cloudSyncStore.set({ user: { username: 'test' }, connected: true, connecting: false, syncing: false, verification: { matches: false } });
        await act(async () => root.render(<SyncSettings />));
        const button = host.querySelector('.sync-actions button');
        expect(button.textContent).toBe('cloud_sync_now');
        expect(host.querySelector('.cloud-verification').textContent).toBe('sync_integrity_pending');
        await act(async () => button.click());
        expect(button.disabled).toBe(true);
        expect(button.textContent).toBe('cloud_sync_syncing');
        expect(cloudSyncAction).toHaveBeenLastCalledWith('verify', undefined);
        await act(async () => finish({ matches: true }));
        expect(button.disabled).toBe(false);
    } finally { await act(async () => root.unmount()); }
});
