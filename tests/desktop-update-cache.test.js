// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    acknowledgeUpdateStartup,
    cleanupMacUpdateStages,
    cleanupUpdateCaches,
    isUpdateDirectoryName,
} from '../desktop/src/update-cache.js';

let temporary, profile, base, application;
const currentVersion = '2.6.26';
const exists = async (file) => !!(await stat(file).catch(() => null));
beforeEach(async () => {
    temporary = await mkdtemp(path.join(tmpdir(), 'cerebr-cache-test-'));
    profile = path.join(temporary, 'profile');
    base = path.join(profile, 'updates');
    application = path.join(temporary, 'Applications', 'Cerebr.app');
    await mkdir(base, { recursive: true });
    await mkdir(application, { recursive: true });
});
afterEach(async () => {
    await rm(temporary, { recursive: true, force: true });
});
async function cache(name, receipt) {
    const folder = path.join(base, name);
    await mkdir(path.join(folder, 'unpacked'), { recursive: true });
    await writeFile(path.join(folder, 'unpacked', 'payload'), 'app');
    await writeFile(path.join(folder, 'Cerebr-darwin-arm64-2.6.26.zip'), 'archive');
    if (receipt) await writeFile(path.join(folder, 'restarted'), receipt);
    return folder;
}
const cleanup = (options = {}) => cleanupUpdateCaches({ base, currentVersion, ...options });

describe('update cache lifecycle', () => {
    it('reclaims installed versioned and legacy caches, not profile data or newer resumable updates', async () => {
        const removed = await Promise.all([
            cache('download-2.6.24-darwin-arm64', '2.6.24'),
            cache('download-2.6.25-win32-x64'),
            cache('download-2.6.26-darwin-arm64'),
            cache('download-AbCd12', '2.6.7'),
        ]);
        const resumed = await cache('download-2.6.27-darwin-arm64');
        await writeFile(path.join(resumed, 'package.zip.part-0'), 'partial');
        const unknown = await cache('download-Future');
        await writeFile(path.join(profile, 'history-sync.sqlite'), 'history');
        await mkdir(path.join(base, 'personal-files'));
        await cleanup();
        for (const file of removed) expect(await exists(file)).toBe(false);
        expect(await readFile(path.join(resumed, 'package.zip.part-0'), 'utf8')).toBe('partial');
        expect(await exists(unknown)).toBe(true);
        expect(await exists(path.join(base, 'personal-files'))).toBe(true);
        expect(await readFile(path.join(profile, 'history-sync.sqlite'), 'utf8')).toBe('history');
    });
    it('preserves the active directory and the chosen release, but discards superseded downloads', async () => {
        const active = await cache('download-2.6.26-darwin-arm64');
        const superseded = await cache('download-2.6.27-darwin-arm64');
        const chosen = await cache('download-2.6.28-darwin-arm64');
        await cleanup({ obsoleteBefore: '2.6.28', keep: [active, chosen] });
        expect(await exists(active)).toBe(true);
        expect(await exists(chosen)).toBe(true);
        expect(await exists(superseded)).toBe(false);
    });
    it('acknowledges once-ready startup and reclaims payloads without racing the old install helper', async () => {
        const id = 'download-2.6.26-darwin-arm64',
            folder = await cache(id);
        await writeFile(path.join(folder, 'install.sh'), 'helper');
        expect(await acknowledgeUpdateStartup(base, id, currentVersion)).toBe(true);
        await cleanup({ startupId: id });
        expect(await readdir(folder)).toEqual(['install.sh', 'restarted']);
        expect(await readFile(path.join(folder, 'restarted'), 'utf8')).toBe(currentVersion);
        // A later ordinary launch can remove the remaining handshake files.
        await cleanup();
        expect(await exists(folder)).toBe(false);
    });
    it('does not clear the startup directory when acknowledgement failed or is mismatched', async () => {
        const id = 'download-2.6.26-darwin-arm64',
            folder = await cache(id, '2.6.25');
        await cleanup({ startupId: id });
        expect(await exists(path.join(folder, 'unpacked', 'payload'))).toBe(true);
    });
    it('only removes old empty legacy directories, not partial downloads of unknown versions', async () => {
        const old = path.join(base, 'download-Abc123'),
            recent = path.join(base, 'download-New123');
        await mkdir(old);
        await mkdir(recent);
        const unknown = await cache('download-Old123');
        for (const folder of [old, unknown]) await utimes(folder, new Date(0), new Date(0));
        await cleanup();
        expect(await exists(old)).toBe(false);
        expect(await exists(recent)).toBe(true);
        expect(await exists(unknown)).toBe(true);
    });
    it('rejects path traversal and refuses symlinked roots, directories and startup receipts', async () => {
        const outside = path.join(temporary, 'outside');
        await mkdir(outside);
        const sentinel = path.join(outside, 'restarted');
        await writeFile(sentinel, 'do not touch');
        await symlink(outside, path.join(base, 'download-2.6.25-darwin-arm64'), 'dir');
        const id = 'download-2.6.26-darwin-arm64',
            folder = await cache(id);
        await symlink(sentinel, path.join(folder, 'restarted'));
        await expect(acknowledgeUpdateStartup(base, id, currentVersion)).rejects.toThrow();
        for (const invalid of [
            '../outside',
            '',
            'download-../../outside',
            'download-2.6.26-darwin-arm64/..',
        ]) {
            expect(isUpdateDirectoryName(invalid)).toBe(false);
            expect(await acknowledgeUpdateStartup(base, invalid, currentVersion)).toBe(false);
        }
        await cleanup({ startupId: id });
        expect(await readFile(sentinel, 'utf8')).toBe('do not touch');
        expect(await exists(path.join(base, 'download-2.6.25-darwin-arm64'))).toBe(true);
        const link = path.join(temporary, 'linked-updates');
        await symlink(base, link, 'dir');
        await cleanup({ base: link });
        expect(await exists(folder)).toBe(true);
    });
});

async function stage(suffix, { owner, version = '2.6.25', id = 'app.cerebr.desktop', backup = false } = {}) {
    const folder = path.join(path.dirname(application), `.Cerebr-update-${suffix}`);
    await mkdir(path.join(folder, 'Cerebr.app', 'Contents'), { recursive: true });
    await writeFile(
        path.join(folder, 'Cerebr.app', 'Contents', 'Info.plist'),
        JSON.stringify({ id, version })
    );
    if (owner)
        await writeFile(
            path.join(folder, 'owner.json'),
            JSON.stringify({
                format: 1,
                profile,
                application,
                cacheId: 'download-2.6.27-darwin-arm64',
                pid: 90000,
                ...owner,
            })
        );
    if (backup) await mkdir(path.join(folder, 'previous.app'));
    return folder;
}
const cleanStages = (options = {}) =>
    cleanupMacUpdateStages({
        application,
        profile,
        currentVersion,
        readBundleInfo: async (plist) => JSON.parse(await readFile(plist, 'utf8')),
        processAlive: (pid) => pid === process.pid,
        ...options,
    });
describe('macOS same-volume staging lifecycle', () => {
    it('reclaims abandoned owned stages but preserves live owners, other profiles and rollback backups', async () => {
        const stale = await stage('Dead01', { owner: {} });
        const active = await stage('Alive1', { owner: { pid: process.pid } });
        const other = await stage('Other1', { owner: { profile: '/another/profile' } });
        const backup = await stage('Backup', { owner: {}, backup: true });
        const pending = await stage('Keep01', { owner: {} });
        await cleanStages({ keep: [pending] });
        expect(await exists(stale)).toBe(false);
        for (const folder of [active, other, backup, pending, application])
            expect(await exists(folder)).toBe(true);
    });
    it('migrates older validated legacy stages without deleting current/future/foreign bundles or backups', async () => {
        const old = await stage('Old123');
        const current = await stage('Curr12', { version: currentVersion });
        const future = await stage('Next12', { version: '2.6.27' });
        const foreign = await stage('Other1', { id: 'com.example.other' });
        const rollback = await stage('Prev12', { backup: true });
        await cleanStages();
        expect(await exists(old)).toBe(false);
        for (const folder of [current, future, foreign, rollback]) expect(await exists(folder)).toBe(true);
    });
    it('skips unsafe markers and symlinked bundles rather than following them', async () => {
        const invalid = await stage('Bad123', { owner: {} });
        await writeFile(path.join(invalid, 'owner.json'), '{');
        const unknown = await stage('Extra1');
        await writeFile(path.join(unknown, 'keep-me'), 'personal file');
        const outside = path.join(temporary, 'outside-app');
        await mkdir(outside);
        const link = path.join(path.dirname(application), '.Cerebr-update-Link01');
        await mkdir(link);
        await symlink(outside, path.join(link, 'Cerebr.app'), 'dir');
        const errors = vi.fn();
        await cleanStages({ onError: errors });
        for (const folder of [invalid, unknown, link, outside]) expect(await exists(folder)).toBe(true);
        expect(errors).toHaveBeenCalledOnce();
    });
});
