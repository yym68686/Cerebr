import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { applyRemoteRecord, upgradeReplica } from '../src/runtime/sync/replica.js';

const progressKey = 'cerebr_reading_progress_v1_test';
const chatKey = 'cerebr_chat_v2_test';
const draftKey = 'cerebr_draft_v1_test';
const invalidated = () => new Error('Extension context invalidated.');
let adapter, runtime, local, errors, db;

beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('indexedDB', new IDBFactory());
    runtime = { getManifest: vi.fn(() => ({ version: '2.5.14' })) };
    local = {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
    };
    vi.stubGlobal('chrome', { runtime, storage: { local } });
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    adapter = (await import('../src/utils/storage-adapter.js')).storageAdapter;
    db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('CerebrData', 2);
        request.onupgradeneeded = () => { request.result.createObjectStore('keyValueStore'); upgradeReplica(request.result); };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
});

afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function readIdb(key) {
    return new Promise((resolve, reject) => {
        const request = db.transaction('keyValueStore').objectStore('keyValueStore').get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

describe('chat storage during extension reload', () => {
    it('does not restore a remotely deleted chat from old chrome.storage data', async () => {
        const value={id:'test',title:'Test',messages:[]};
        local.get.mockResolvedValue({[chatKey]:value});
        await applyRemoteRecord(db,{key:chatKey,value:null,deleted:true,version:{clock:1,actor:'desktop'}});
        expect(await adapter.get(chatKey)).toEqual({[chatKey]:undefined});
        expect(await adapter.get([chatKey])).toEqual({[chatKey]:undefined});
        expect(local.get).not.toHaveBeenCalled();
    });
    it('reopens IndexedDB after a transient open failure', async () => {
        const failure = new Error('IndexedDB temporarily unavailable');
        const open = vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
            const request = {};
            queueMicrotask(() => request.onerror({ target: { error: failure } }));
            return request;
        });
        await expect(adapter.set({ [chatKey]: { content: 'answer' } })).rejects.toBe(failure);
        await adapter.set({ [chatKey]: { content: 'answer' } });
        expect(await readIdb(chatKey)).toEqual({ content: 'answer' });
        expect(open).toHaveBeenCalledTimes(2);
    });

    it('reopens its connection after a database version change', async () => {
        const open = vi.spyOn(indexedDB, 'open');
        await adapter.set({ [chatKey]: { content: 'partial' } });
        const connection = open.mock.results[0].value.result;
        connection.onversionchange();
        await adapter.set({ [chatKey]: { content: 'answer' } });
        expect(await readIdb(chatKey)).toEqual({ content: 'answer' });
        expect(open).toHaveBeenCalledTimes(2);
    });

    it.each([progressKey, draftKey, [chatKey, progressKey, draftKey]])(
        'skips legacy reads after context invalidation: %j',
        async (keys) => {
            runtime.getManifest.mockImplementation(() => {
                throw invalidated();
            });
            const expected = Object.fromEntries(
                (Array.isArray(keys) ? keys : [keys]).map((k) => [k, undefined])
            );
            expect(await adapter.get(keys)).toEqual(expected);
            expect(local.get).not.toHaveBeenCalled();
            expect(errors).not.toHaveBeenCalled();
        }
    );

    it.each([progressKey, [chatKey, progressKey]])(
        'handles invalidation during a legacy read: %j',
        async (keys) => {
            local.get.mockRejectedValueOnce(invalidated());
            const result = await adapter.get(keys);
            expect(result[progressKey]).toBeUndefined();
            expect(local.get).toHaveBeenCalledOnce();
            expect(errors).not.toHaveBeenCalled();
        }
    );

    it('keeps stored chat data when another key needs legacy fallback during reload', async () => {
        const chat = { id: 'test', messages: [{ role: 'user', content: 'Saved message' }] };
        await adapter.set({ [chatKey]: chat });
        local.get.mockRejectedValueOnce(invalidated());
        expect(await adapter.get([chatKey, progressKey])).toEqual({
            [chatKey]: chat,
            [progressKey]: undefined,
        });
        expect(errors).not.toHaveBeenCalled();
    });

    it.each([progressKey, [progressKey], draftKey, [draftKey]])(
        'still migrates legacy progress while the extension is available: %j',
        async (keys) => {
            const progress = { v: 1, anchorIndex: 2, anchorOffsetPx: 30 };
            const key = Array.isArray(keys) ? keys[0] : keys;
            local.get.mockResolvedValueOnce({ [key]: progress });
            expect(await adapter.get(keys)).toEqual({ [key]: progress });
            expect(await readIdb(key)).toEqual(progress);
            expect(local.remove).toHaveBeenCalledOnce();
            local.get.mockClear();
            expect(await adapter.get(keys)).toEqual({ [key]: progress });
            expect(local.get).not.toHaveBeenCalled();
        }
    );

    it.each([progressKey, [progressKey]])(
        'returns migrated data if legacy cleanup loses its context: %j',
        async (keys) => {
            const progress = { v: 1, anchorIndex: 4, anchorOffsetPx: 12 };
            local.get.mockResolvedValueOnce({ [progressKey]: progress });
            local.remove.mockRejectedValueOnce(invalidated());
            expect(await adapter.get(keys)).toEqual({ [progressKey]: progress });
            expect(await readIdb(progressKey)).toEqual(progress);
            expect(errors).not.toHaveBeenCalled();
        }
    );

    it('persists IDB updates and deletes without accessing an invalidated extension', async () => {
        runtime.getManifest.mockImplementation(() => {
            throw invalidated();
        });
        const progress = { v: 1, anchorIndex: 1, anchorOffsetPx: 5 };
        await expect(adapter.set({ [progressKey]: progress })).resolves.toBeUndefined();
        expect(await readIdb(progressKey)).toEqual(progress);
        await expect(adapter.remove(progressKey)).resolves.toBeUndefined();
        expect(await readIdb(progressKey)).toBeUndefined();
        expect(local.remove).not.toHaveBeenCalled();
        expect(errors).not.toHaveBeenCalled();
    });

    it('handles invalidation between an IDB write and legacy cleanup', async () => {
        local.remove.mockRejectedValue(invalidated());
        await expect(adapter.set({ [progressKey]: { anchorIndex: 1 } })).resolves.toBeUndefined();
        expect(await readIdb(progressKey)).toEqual({ anchorIndex: 1 });
        await expect(adapter.remove(progressKey)).resolves.toBeUndefined();
        expect(await readIdb(progressKey)).toBeUndefined();
    });

    it('preserves diagnostics and rejections for other storage failures', async () => {
        const failure = new Error('Storage access denied');
        local.get.mockRejectedValue(failure);
        await adapter.get(progressKey);
        expect(errors).toHaveBeenCalledWith(expect.stringContaining(progressKey), failure);
        local.remove.mockRejectedValue(failure);
        await expect(adapter.set({ [progressKey]: {} })).rejects.toBe(failure);
    });

    it('does not report success for extension-only writes after invalidation', async () => {
        local.set.mockRejectedValue(invalidated());
        local.remove.mockRejectedValue(invalidated());
        await expect(adapter.set({ apiConfigs: [] })).rejects.toThrow(
            'Extension context invalidated'
        );
        await expect(adapter.remove('apiConfigs')).rejects.toThrow('Extension context invalidated');
    });

    it('saves drafts after extension reload and does not resurrect a cleared legacy draft', async () => {
        local.get.mockResolvedValue({ [draftKey]: { content: 'old draft' } });
        runtime.getManifest.mockImplementation(() => { throw invalidated(); });
        await adapter.set({ [draftKey]: { content: 'new draft' } });
        expect(await adapter.get(draftKey)).toEqual({ [draftKey]: { content: 'new draft' } });
        expect(await readIdb(draftKey)).toEqual({ content: 'new draft' });
        await adapter.remove(draftKey);
        runtime.getManifest.mockReturnValue({ version: '2.5.14' });
        expect(await adapter.get(draftKey)).toEqual({ [draftKey]: null });
        expect(local.get).not.toHaveBeenCalled();
        expect(local.set).not.toHaveBeenCalled();
        expect(errors).not.toHaveBeenCalled();
    });
});
