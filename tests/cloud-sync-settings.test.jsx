import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
vi.mock('../src/utils/i18n.js', () => ({ t: key => key }));
vi.mock('../src/runtime/sync/cloud-sync.js', async () => {
    const { createStore } = await import('../src/app/state/store.js');
    return { cloudSyncStore: createStore({}), cloudSyncAction: vi.fn() };
});
import { CloudSyncSettings } from '../src/app/components/CloudSyncSettings.jsx';
import { cloudSyncStore } from '../src/runtime/sync/cloud-sync.js';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

it('updates visible chat and message totals while syncing instead of waiting for the final summary', async () => {
    const host = document.createElement('div'), root = createRoot(host);
    document.body.append(host);
    try {
        cloudSyncStore.set({ user: { username: 'test' }, connecting: true, connected: false, syncing: true,
            summary: { chats: 0, messages: 0 }, localSummary: { chats: 3, messages: 12 } });
        await act(async () => root.render(<CloudSyncSettings />));
        expect([...host.querySelectorAll('.sync-stat strong')].map(el => el.textContent)).toEqual(['3', '12']);
        expect(host.querySelector('[role="status"]').textContent).toBe('cloud_sync_syncing');
        await act(async () => cloudSyncStore.set({ localSummary: { chats: 8, messages: 27 } }));
        expect([...host.querySelectorAll('.sync-stat strong')].map(el => el.textContent)).toEqual(['8', '27']);
        await act(async () => cloudSyncStore.set({ connected: true, connecting: false, syncing: false }));
        expect(host.querySelector('[role="status"]').textContent).toBe('desktop_sync_connected');
    } finally { await act(async () => root.unmount()); host.remove(); }
});
