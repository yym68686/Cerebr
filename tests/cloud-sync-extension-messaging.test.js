// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/utils/storage-adapter.js', () => ({
    isExtensionEnvironment: true,
    getDb: vi.fn(async () => ({})),
    storageAdapter: {
        get: vi.fn(async (key) => ({ [key]: undefined })),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
    },
}));
vi.mock('../src/runtime/sync/client.js', () => ({ createSyncClient: vi.fn() }));
vi.mock('../src/runtime/sync/api-settings.js', () => ({ ensureApiReplica: vi.fn() }));

let chromeApi, listeners;

beforeEach(() => {
    vi.resetModules();
    listeners = [];
    chromeApi = {
        runtime: {
            id: 'test-extension',
            getURL: (path) => `moz-extension://test-extension/${path}`,
            getManifest: () => ({ version: '1.0.0' }),
            onMessage: { addListener: (listener) => listeners.push(listener) },
            sendMessage: vi.fn(async () => undefined),
        },
        storage: { local: { set: vi.fn(async () => {}) } },
    };
    vi.stubGlobal('chrome', chromeApi);
    vi.stubGlobal('document', {
        visibilityState: 'visible',
        addEventListener: vi.fn(),
    });
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('registers the background message handler when Firefox provides a document', async () => {
    const { startCloudSync } = await import('../src/runtime/sync/cloud-sync.js');
    await startCloudSync({ isBackground: true });

    const listener = listeners[0];
    expect(listener).toBeTypeOf('function');
    let response;
    const keepResponseChannelOpen = listener(
        { type: 'CEREBR_CLOUD_ACTION', action: 'logout' },
        { id: 'test-extension', url: 'moz-extension://test-extension/index.html' },
        (value) => { response = value; },
    );

    expect(keepResponseChannelOpen).toBe(true);
    await vi.waitFor(() => expect(response).toEqual({ ok: true }));
});

it('reports a missing background response instead of treating it as successful login', async () => {
    const { cloudSyncAction } = await import('../src/runtime/sync/cloud-sync.js');

    await expect(cloudSyncAction('login', { username: 'demo', password: 'password' }))
        .rejects.toThrow('云端同步请求未收到响应');
});
