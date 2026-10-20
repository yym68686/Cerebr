import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    client: { start: vi.fn(), close: vi.fn(), receive: vi.fn(), reconcile: vi.fn(async () => {}) },
    sockets: [],
}));
vi.mock('../src/utils/storage-adapter.js', () => ({
    isExtensionEnvironment: false, getDb: async () => ({}),
    storageAdapter: {
        get: async key => ({ [key]: key === 'cerebr_cloud_auth_v1' ? { token: 'test', user: { username: 'test' } } : { id: 'test-device' } }),
        set: async () => {},
        remove: async () => {},
    },
}));
vi.mock('../src/runtime/sync/client.js', () => ({ createSyncClient: async ({ onStatus }) => { onStatus({ connected: true }); return mocks.client; } }));
vi.mock('../src/runtime/sync/api-settings.js', () => ({ ensureApiReplica: async () => {} }));
vi.stubGlobal('WebSocket', class {
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
    constructor() { mocks.sockets.push(this); }
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('catches up a resumed tab and replaces sockets that stop responding despite remaining open', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    const { startCloudSync, cloudSyncAction } = await import('../src/runtime/sync/cloud-sync.js');
    await startCloudSync();
    await vi.advanceTimersByTimeAsync(0);
    const socket = mocks.sockets[0];
    socket.onmessage({ data: JSON.stringify({ type: 'authenticated', user: { username: 'test' } }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.client.start).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.client.reconcile).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(31000);
    expect(mocks.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(mocks.sockets).toHaveLength(2);
    expect(socket.close).toHaveBeenCalled();
    await cloudSyncAction('logout');
});
