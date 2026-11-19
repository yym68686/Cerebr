import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    client: { start: vi.fn(), close: vi.fn(), receive: vi.fn(), reconcile: vi.fn(async () => {}) },
    sockets: [],
}));
vi.mock('../src/utils/storage-adapter.js', () => ({
    isExtensionEnvironment: false,
    getDb: async () => ({}),
    storageAdapter: {
        get: async (key) => ({
            [key]:
                key === 'cerebr_cloud_auth_v1'
                    ? { token: 'test', expiresAt: '2000-01-01T00:00:00Z', user: { username: 'test' } }
                    : { id: 'test-device' },
        }),
        set: async () => {},
        remove: async () => {},
    },
}));
vi.mock('../src/runtime/sync/client.js', () => ({
    createSyncClient: async ({ onStatus }) => {
        onStatus({ connected: true });
        return mocks.client;
    },
}));
vi.mock('../src/runtime/sync/api-settings.js', () => ({ ensureApiReplica: async () => {} }));
beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.sockets.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal(
        'WebSocket',
        class {
            readyState = 1;
            send = vi.fn();
            close = vi.fn();
            constructor() {
                mocks.sockets.push(this);
            }
        }
    );
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it('catches up a resumed tab and replaces sockets that stop responding despite remaining open', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    );
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

it('stops retrying an explicitly invalid session until login provides a new token', async () => {
    const user = { username: 'legacy-admin' };
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ token: 'replacement', user }) }));
    vi.stubGlobal('fetch', fetch);
    const { startCloudSync, cloudSyncAction, cloudSyncStore } =
        await import('../src/runtime/sync/cloud-sync.js');
    await startCloudSync();
    await vi.advanceTimersByTimeAsync(0);
    const [socket] = mocks.sockets;
    socket.onmessage({
        data: JSON.stringify({
            type: 'auth-error',
            status: 401,
            code: 'SESSION_INVALID',
            error: 'Login invalid',
        }),
    });
    await vi.advanceTimersByTimeAsync(0);
    socket.onclose({ code: 4001 });
    expect(cloudSyncStore.getSnapshot()).toMatchObject({
        user: { username: 'test' },
        needsLogin: true,
        connected: false,
        connecting: false,
    });
    await cloudSyncAction('connect');
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.sockets).toHaveLength(1);

    await cloudSyncAction('login', { username: user.username, password: 'test-password' });
    await vi.advanceTimersByTimeAsync(0);
    const retry = mocks.sockets[1];
    retry.onopen();
    expect(JSON.parse(retry.send.mock.lastCall[0])).toMatchObject({ type: 'auth', token: 'replacement' });
    retry.onmessage({ data: JSON.stringify({ type: 'authenticated', user }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(cloudSyncStore.getSnapshot()).toMatchObject({ user, needsLogin: false, connected: true });
    await cloudSyncAction('logout');
});

it('reuses the stored token without login when reconnecting from an older server', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetch);
    const { startCloudSync, cloudSyncAction, cloudSyncStore } =
        await import('../src/runtime/sync/cloud-sync.js');
    await startCloudSync();
    await vi.advanceTimersByTimeAsync(0);
    const [socket] = mocks.sockets;
    socket.onmessage({ data: JSON.stringify({ type: 'auth-error', status: 401, error: 'Login expired' }) });
    await vi.advanceTimersByTimeAsync(0);
    socket.onclose({ code: 4001 });
    expect(cloudSyncStore.getSnapshot().needsLogin).toBe(false);
    await cloudSyncAction('connect');
    await vi.advanceTimersByTimeAsync(0);
    const retry = mocks.sockets[1];
    retry.onopen();
    expect(JSON.parse(retry.send.mock.lastCall[0])).toMatchObject({ type: 'auth', token: 'test' });
    retry.onmessage({ data: JSON.stringify({ type: 'authenticated', user: { username: 'test' } }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(cloudSyncStore.getSnapshot()).toMatchObject({ needsLogin: false, connected: true });
    expect(fetch).not.toHaveBeenCalled();
    await cloudSyncAction('logout');
});

it.each([
    { status: 403, close: 4003, retry: false },
    { status: 500, close: 4001, retry: true },
])(
    'does not mistake a $status authentication response for expired credentials',
    async ({ status, close, retry }) => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true, json: async () => ({}) }))
        );
        const { startCloudSync, cloudSyncAction, cloudSyncStore } =
            await import('../src/runtime/sync/cloud-sync.js');
        await startCloudSync();
        await vi.advanceTimersByTimeAsync(0);
        const [socket] = mocks.sockets;
        socket.onmessage({
            data: JSON.stringify({ type: 'auth-error', status, error: 'Unable to connect' }),
        });
        await vi.advanceTimersByTimeAsync(0);
        socket.onclose({ code: close });
        expect(cloudSyncStore.getSnapshot().needsLogin).toBe(false);
        await vi.advanceTimersByTimeAsync(5000);
        expect(mocks.sockets).toHaveLength(retry ? 2 : 1);
        await cloudSyncAction('logout');
    }
);
