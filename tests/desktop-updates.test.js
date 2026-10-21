// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
    isNewerVersion,
    selectRelease,
    parseChecksums,
    downloadVerified,
    validateSquirrelFeed,
} from '../desktop/src/update-release.js';
import { attachDesktopUpdates, desktopUpdateStore } from '../src/platform/desktop-updates.js';
import { createStore } from '../src/app/state/store.js';
import { requestUpdate, retryUpdate, updateError, updateErrorCode } from '../desktop/src/update-request.js';

const folders = [],
    detach = [];
afterEach(async () => {
    detach.splice(0).forEach((fn) => fn());
    await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});
const version = '2.6.0';
const names = [
    `Cerebr-darwin-arm64-${version}.zip`,
    `Cerebr-${version}-darwin-arm64-SHA256SUMS.txt`,
    'RELEASES',
    `Cerebr-${version}-full.nupkg`,
    `Cerebr-${version}-win32-x64-SHA256SUMS.txt`,
];
const release = () => ({
    tag_name: `v${version}`,
    assets: names.map((name) => ({
        name,
        size: 100,
        browser_download_url: `https://github.com/yym68686/Cerebr/releases/download/v${version}/${name}`,
    })),
});
describe('release selection', () => {
    it('compares numeric versions, without downgrading or installing previews', () => {
        expect(isNewerVersion('2.10.0', '2.9.99')).toBe(true);
        expect(selectRelease(release(), version, 'darwin', 'arm64')).toBeNull();
        expect(selectRelease(release(), '3.0.0', 'darwin', 'arm64')).toBeNull();
        expect(selectRelease({ ...release(), prerelease: true }, '2.5.0', 'darwin', 'arm64')).toBeNull();
        expect(() => isNewerVersion('2.6.0-beta', '2.5.0')).toThrow();
    });
    it('selects the exact architecture and requires a complete Windows update feed', () => {
        expect(selectRelease(release(), '2.5.0', 'darwin', 'arm64').files[0].name).toBe(names[0]);
        expect(selectRelease(release(), '2.5.0', 'win32', 'x64').files.map((f) => f.name)).toEqual([
            'RELEASES',
            names[3],
        ]);
        expect(() => selectRelease(release(), '2.5.0', 'darwin', 'x64')).toThrow();
        const incomplete = release();
        incomplete.assets.splice(2, 1);
        expect(() => selectRelease(incomplete, '2.5.0', 'win32', 'x64')).toThrow();
    });
    it('rejects arbitrary URLs and duplicate/missing checksums', () => {
        const bad = release();
        bad.assets[0].browser_download_url = 'https://example.com/installer.zip';
        expect(() => selectRelease(bad, '2.5.0', 'darwin', 'arm64')).toThrow();
        expect(() =>
            parseChecksums(`${'a'.repeat(64)}  x.zip\n${'b'.repeat(64)}  x.zip`, [{ name: 'x.zip' }])
        ).toThrow();
        expect(() => parseChecksums(`${'a'.repeat(64)}  other.zip`, [{ name: 'x.zip' }])).toThrow();
    });
});
describe('verified downloads', () => {
    async function download(data, expected = data, size = expected.length) {
        const folder = await mkdtemp(path.join(tmpdir(), 'cerebr-update-test-'));
        folders.push(folder);
        const destination = path.join(folder, 'update.zip');
        const result = downloadVerified({
            response: new Response(data),
            file: { size },
            destination,
            sha256: createHash('sha256').update(expected).digest('hex'),
        });
        return { result, destination };
    }
    it('writes and hashes the streamed file', async () => {
        const { result, destination } = await download(Buffer.alloc(128000, 7));
        expect(await result).toBe(createHash('sha1').update(Buffer.alloc(128000, 7)).digest('hex'));
        expect((await readFile(destination)).length).toBe(128000);
    });
    it('restarts a disconnected streamed download from a clean file and verifies the result', async () => {
        const folder = await mkdtemp(path.join(tmpdir(), 'cerebr-update-test-'));
        folders.push(folder);
        const destination = path.join(folder, 'retry.zip');
        const bytes = Buffer.from('complete-installer');
        let attempt = 0;
        const operation = vi.fn(async () => {
            attempt++;
            let sent = false;
            const response = attempt === 1 ? new Response(new ReadableStream({
                pull(controller) {
                    if (sent) controller.error(new Error('net::ERR_CONNECTION_RESET'));
                    else { sent = true; controller.enqueue(bytes.subarray(0, 4)); }
                },
            })) : new Response(bytes);
            return downloadVerified({response, file:{size:bytes.length}, destination,
                sha256:createHash('sha256').update(bytes).digest('hex')});
        });
        await retryUpdate(operation, {sleep:async()=>{}});
        expect(operation).toHaveBeenCalledTimes(2);
        expect(await readFile(destination)).toEqual(bytes);
    });
    it.each(['tampered', 'too-large', 'truncated'])(
        'deletes a %s download before installation',
        async (kind) => {
            const data = Buffer.from('installer');
            const { result, destination } = await download(
                data,
                kind === 'tampered' ? Buffer.from('Installer') : data,
                kind === 'too-large' ? 3 : kind === 'truncated' ? 100 : data.length
            );
            await expect(result).rejects.toThrow(/mismatch/);
            await expect(access(destination)).rejects.toThrow();
        }
    );
    it('rejects Windows feed paths, different payloads and sizes', () => {
        const file = { name: 'Cerebr-2.6.0-full.nupkg', size: 100 };
        validateSquirrelFeed(`${'a'.repeat(40)} ${file.name} 100`, file, 'a'.repeat(40));
        for (const line of [
            `${'a'.repeat(40)} ../${file.name} 100`,
            `${'a'.repeat(40)} ${file.name} 101`,
            `${'b'.repeat(40)} ${file.name} 100`,
        ])
            expect(() => validateSquirrelFeed(line, file, 'a'.repeat(40))).toThrow();
    });
});
describe('update requests and failure reporting', () => {
    const url = 'https://api.github.com/repos/yym68686/Cerebr/releases/latest';
    it('recovers from a transient service failure and reports each retry', async () => {
        const fetch = vi.fn()
            .mockResolvedValueOnce(new Response('', {status:503}))
            .mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'))
            .mockResolvedValueOnce(new Response('{}'));
        const onRetry = vi.fn();
        await retryUpdate(async () => (await requestUpdate(fetch, url, version)).json(),
            {sleep:async()=>{}, onRetry});
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(onRetry.mock.calls.map(([error])=>updateErrorCode(error))).toEqual(['server','network']);
        expect(fetch.mock.calls[0][1].cache).toBe('no-store');
    });
    it.each([403,429])('reports HTTP %s rate limits without retrying them', async status => {
        const fetch = vi.fn(async () => new Response('', {status,headers:{'x-ratelimit-remaining':'0'}}));
        await expect(retryUpdate(()=>requestUpdate(fetch,url,version), {sleep:async()=>{}}))
            .rejects.toMatchObject({updateCode:'rate_limit'});
        expect(fetch).toHaveBeenCalledOnce();
    });
    it('bounds network retries and does not retry validation or missing release files', async () => {
        for (const [code, count] of [['network',3],['integrity',1],['release',1]]) {
            const operation = vi.fn(async () => {throw updateError(code,'test error');});
            await expect(retryUpdate(operation, {sleep:async()=>{}})).rejects.toMatchObject({updateCode:code});
            expect(operation).toHaveBeenCalledTimes(count);
        }
        await expect(requestUpdate(async()=>new Response('',{status:404}),url,version))
            .rejects.toMatchObject({updateCode:'release'});
    });
    it('distinguishes request timeouts from network failures', async () => {
        const fetch = (_url,{signal}) => new Promise((resolve,reject)=>{
            signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
        });
        await expect(requestUpdate(fetch,url,version,5)).rejects.toMatchObject({updateCode:'timeout'});
    });
});
describe('restart coordination', () => {
    function setup({ phase = 'idle', editing = null, persist = vi.fn(async () => {}) } = {}) {
        desktopUpdateStore.set({ phase: 'idle' });
        const uiStore = createStore({ phase, editing });
        let receive;
        const api = {
            subscribe: (fn) => {
                receive = fn;
                return vi.fn();
            },
            status: async () => ({ phase: 'idle' }),
            ready: vi.fn(async () => {}),
            saveFailed: vi.fn(),
        };
        const blockInput = vi.fn();
        detach.push(attachDesktopUpdates({ uiStore, persist, api, blockInput }));
        return { uiStore, api, persist, blockInput, receive: (s) => receive(s) };
    }
    it('waits for the reply and edit, then saves before asking the host to restart', async () => {
        const state = setup({ phase: 'replying', editing: 'message' });
        state.receive({ phase: 'waiting' });
        expect(state.persist).not.toHaveBeenCalled();
        state.uiStore.set({ phase: 'idle' });
        expect(state.persist).not.toHaveBeenCalled();
        state.uiStore.set({ editing: null });
        await vi.waitFor(() => expect(state.api.ready).toHaveBeenCalledTimes(1));
        expect(state.persist.mock.invocationCallOrder[0]).toBeLessThan(
            state.api.ready.mock.invocationCallOrder[0]
        );
        expect(state.blockInput).toHaveBeenCalledWith(true);
    });
    it('never exits on a failed save', async () => {
        const state = setup({
            persist: vi.fn(async () => {
                throw new Error('Storage full');
            }),
        });
        state.receive({ phase: 'waiting' });
        await vi.waitFor(() => expect(state.api.saveFailed).toHaveBeenCalledOnce());
        expect(state.api.ready).not.toHaveBeenCalled();
        expect(state.blockInput).toHaveBeenLastCalledWith(false);
    });
    it('does not accept an old initial status over a download event', async () => {
        const state = setup({ phase: 'thinking' });
        state.receive({ phase: 'waiting' });
        await Promise.resolve();
        expect(desktopUpdateStore.getSnapshot().phase).toBe('waiting');
    });
});
