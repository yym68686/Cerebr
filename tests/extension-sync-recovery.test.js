// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    client: { start: vi.fn(), close: vi.fn(), receive: vi.fn() },
    ensureApiReplica: vi.fn(),
}));
vi.mock('../src/utils/storage-adapter.js', () => ({
    withDb: async (operation) => operation({}),
    storageAdapter: { get: async () => ({}) },
}));
vi.mock('../src/runtime/sync/client.js', () => ({ createSyncClient: async () => mocks.client }));
vi.mock('../src/runtime/sync/api-settings.js', () => ({ ensureApiReplica: mocks.ensureApiReplica }));
vi.mock('../src/runtime/sync/api-settings-extension.js', () => ({ startApiSettingsExtensionBridge: () => () => {} }));
vi.mock('../src/utils/webpage-switches.js', () => ({ subscribeWebpageSwitches: () => () => {} }));

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it('reconnects using the existing pairing when replica setup fails after authentication', async () => {
    vi.useFakeTimers();
    const sockets = [];
    const config = { cerebr_desktop_pairing_v1: { token: 'test-pairing' } };
    const storage = { get: vi.fn(async () => config), set: vi.fn(async () => {}) };
    vi.stubGlobal('chrome', { runtime: { onMessage: { addListener: vi.fn() } }, storage: { local: storage } });
    vi.stubGlobal('WebSocket', class {
        readyState = 1;
        send = vi.fn();
        constructor() { sockets.push(this); }
        close() {
            this.readyState = 3;
            this.onclose?.();
        }
    });
    mocks.ensureApiReplica.mockRejectedValueOnce(new DOMException('Database is closing', 'InvalidStateError'));

    const { startExtensionSync } = await import('../src/runtime/sync/extension-sync.js');
    const sync = startExtensionSync({ browserRequest: vi.fn() });
    try {
        await vi.advanceTimersByTimeAsync(0);
        const authenticated = { data: JSON.stringify({ type: 'authenticated' }) };
        sockets[0].onmessage(authenticated);
        await vi.advanceTimersByTimeAsync(0);
        expect(sockets[0].readyState).toBe(3);
        expect(storage.set).toHaveBeenLastCalledWith({ cerebr_desktop_sync_status_v1: { connected: false, error: 'Database is closing' } });

        await vi.advanceTimersByTimeAsync(5000);
        expect(sockets).toHaveLength(2);
        sockets[1].onopen();
        expect(JSON.parse(sockets[1].send.mock.calls[0][0])).toEqual({ type: 'auth', token: 'test-pairing' });
        sockets[1].onmessage(authenticated);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.client.start).toHaveBeenCalledOnce();
        expect(JSON.parse(sockets[1].send.mock.calls[1][0]).type).toBe('browser-ready');
        expect(storage.set).toHaveBeenLastCalledWith({ cerebr_desktop_sync_status_v1: { connected: true, error: null } });
    } finally {
        sync.dispose();
    }
});
