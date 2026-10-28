// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const state = vi.hoisted(() => ({ profile: '', packaged: true }));
vi.mock('electron', () => ({
    app: {
        getVersion: () => '2.6.26',
        getPath: () => state.profile,
        get isPackaged() {
            return state.packaged;
        },
    },
    autoUpdater: {},
    net: {},
}));
import { DesktopUpdater } from '../desktop/src/updater.ts';

let temporary, base, updater;
const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const exists = async (file) => !!(await stat(file).catch(() => null));
beforeEach(async () => {
    temporary = await mkdtemp(path.join(tmpdir(), 'cerebr-updater-test-'));
    state.profile = path.join(temporary, 'profile');
    state.packaged = true;
    base = path.join(state.profile, 'updates');
    await mkdir(base, { recursive: true });
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    updater = new DesktopUpdater(vi.fn(), vi.fn());
});
afterEach(async () => {
    Object.defineProperty(process, 'platform', platform);
    await rm(temporary, { recursive: true, force: true });
});
async function cache(version) {
    const folder = path.join(base, `download-${version}-darwin-arm64`);
    await mkdir(path.join(folder, 'unpacked'), { recursive: true });
    await writeFile(path.join(folder, `Cerebr-darwin-arm64-${version}.zip`), 'archive');
    return folder;
}
it('acknowledges startup once, clears historical payloads and preserves the installer receipt', async () => {
    const old = await cache('2.6.25'),
        current = await cache('2.6.26'),
        pending = await cache('2.6.27');
    await writeFile(path.join(current, 'install.sh'), 'helper');
    const first = updater.confirmStartup(path.basename(current));
    expect(updater.confirmStartup()).toBe(first);
    await first;
    expect(await exists(old)).toBe(false);
    expect(await exists(pending)).toBe(true);
    expect(await readdir(current)).toEqual(['install.sh', 'restarted']);
    expect(await readFile(path.join(current, 'restarted'), 'utf8')).toBe('2.6.26');
    // Simulate the helper finishing. Polling status must not recreate its receipt.
    await rm(current, { recursive: true });
    await updater.confirmStartup(path.basename(current));
    expect(await exists(current)).toBe(false);
});
it('protects an unacknowledged installer directory and logs cleanup errors without blocking startup', async () => {
    const current = await cache('2.6.26'),
        outside = path.join(temporary, 'sentinel');
    await writeFile(outside, 'untouched');
    await symlink(outside, path.join(current, 'restarted'));
    await expect(updater.confirmStartup(path.basename(current))).resolves.toBeUndefined();
    expect(await readFile(outside, 'utf8')).toBe('untouched');
    expect(await exists(path.join(current, 'unpacked'))).toBe(true);
    expect(await readFile(path.join(state.profile, 'desktop-update.log'), 'utf8')).toContain(
        'startup-confirmation-failed'
    );
});
it('does not clean packaged profiles when running a development build', async () => {
    state.packaged = false;
    const old = await cache('2.6.25');
    await updater.confirmStartup();
    expect(await exists(old)).toBe(true);
});

it.skipIf(platform.value !== 'darwin')(
    'prepares a real macOS ZIP without retaining a duplicate unpacked app',
    async () => {
        const bundle = path.join(temporary, 'source', 'Cerebr.app');
        await mkdir(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
        await writeFile(
            path.join(bundle, 'Contents', 'Info.plist'),
            `<?xml version="1.0"?><plist version="1.0"><dict>
        <key>CFBundleIdentifier</key><string>app.cerebr.desktop</string>
        <key>CFBundleShortVersionString</key><string>2.6.27</string></dict></plist>`
        );
        await writeFile(path.join(bundle, 'Contents', 'MacOS', 'Cerebr'), 'not executed', { mode: 0o700 });
        const folder = await cache('2.6.27'),
            name = 'Cerebr-darwin-arm64-2.6.27.zip';
        await rm(path.join(folder, name));
        await promisify(execFile)('/usr/bin/ditto', [
            '-c',
            '-k',
            '--keepParent',
            bundle,
            path.join(folder, name),
        ]);
        // TypeScript-private fields are used only to direct this host integration
        // test at its disposable profile. No installed application is replaced.
        updater.directory = folder;
        updater.target = path.join(temporary, 'Cerebr.app');
        await updater.prepareMac(name, '2.6.27');
        expect(await exists(path.join(folder, name))).toBe(true);
        expect(await exists(path.join(folder, 'unpacked'))).toBe(false);
        const marker = JSON.parse(
            await readFile(path.join(path.dirname(updater.staged), 'owner.json'), 'utf8')
        );
        expect(marker).toMatchObject({
            profile: state.profile,
            application: updater.target,
            pid: process.pid,
        });
        expect(await exists(path.join(updater.staged, 'Contents', 'MacOS', 'Cerebr'))).toBe(true);
    },
    20000
);
