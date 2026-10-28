// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const shellAvailable = process.platform !== 'win32';
const exists = async (file) => !!(await stat(file).catch(() => null));
let temporary, profile, cache, stage, target, staged, backup, log, helper, env;
const version = '2.6.26',
    id = `download-${version}-darwin-arm64`;
beforeEach(async () => {
    if (!shellAvailable) return;
    temporary = await mkdtemp(path.join(tmpdir(), 'cerebr-install-test-'));
    profile = path.join(temporary, 'profile with spaces');
    cache = path.join(profile, 'updates', id);
    stage = path.join(temporary, '.Cerebr-update-Test01');
    target = path.join(temporary, 'Cerebr.app');
    staged = path.join(stage, 'Cerebr.app');
    backup = path.join(stage, 'previous.app');
    log = path.join(profile, 'desktop-update.log');
    await mkdir(cache, { recursive: true });
    await mkdir(target);
    await mkdir(staged, { recursive: true });
    await writeFile(path.join(target, 'version'), 'old');
    await writeFile(path.join(staged, 'version'), 'new');
    await writeFile(path.join(stage, 'owner.json'), 'owner');
    await writeFile(path.join(cache, 'update.zip'), 'archive');
    const opener = path.join(temporary, 'fake-open');
    await writeFile(
        opener,
        `#!/bin/sh
case "$TEST_OUTCOME" in
    fail) exit 1 ;;
    unconfirmed) exit 0 ;;
    mismatch) printf '%s' wrong > "$TEST_CACHE/restarted" ;;
    *) printf '%s' "$TEST_VERSION" > "$TEST_CACHE/restarted" ;;
esac
`,
        { mode: 0o700 }
    );
    helper = path.join(cache, 'install.sh');
    // Execute the real install/rollback/cleanup commands only inside the test
    // root. Substitute the OS launcher and shorten waits, never launch an app.
    const source = await readFile(new URL('../desktop/src/install-mac-update.sh', import.meta.url), 'utf8');
    await writeFile(
        helper,
        source
            .replaceAll('/usr/bin/open', `"${opener}"`)
            .replaceAll('sleep 1', 'sleep 0.01')
            .replaceAll('-gt 120', '-gt 3')
    );
    env = { ...process.env, TEST_OUTCOME: 'success', TEST_CACHE: cache, TEST_VERSION: version };
});
afterEach(async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    temporary = null;
});
function install(updateId = id) {
    return exec('/bin/sh', [helper, '2147483647', target, staged, backup, log, profile, updateId, version], {
        env,
        timeout: 15000,
    });
}
describe.skipIf(!shellAvailable)('macOS installer cleanup handshake', () => {
    it('removes cache, backup and ownership marker only after the new app acknowledges startup', async () => {
        const other = path.join(profile, 'updates', 'download-2.6.27-darwin-arm64');
        await mkdir(other);
        await install();
        expect(await readFile(path.join(target, 'version'), 'utf8')).toBe('new');
        expect(await exists(stage)).toBe(false);
        expect(await exists(cache)).toBe(false);
        expect(await exists(other)).toBe(true);
        expect(await readFile(log, 'utf8')).toContain('Update installed and Cerebr relaunched.');
    }, 20000);
    it('rolls back a failed launch and retains the verified package for retry', async () => {
        env.TEST_OUTCOME = 'fail';
        await expect(install()).rejects.toThrow();
        expect(await readFile(path.join(target, 'version'), 'utf8')).toBe('old');
        expect(await readFile(path.join(staged, 'version'), 'utf8')).toBe('new');
        expect(await exists(path.join(cache, 'update.zip'))).toBe(true);
    }, 20000);
    it.each(['unconfirmed', 'mismatch'])(
        'preserves rollback and cache on %s startup',
        async (outcome) => {
            env.TEST_OUTCOME = outcome;
            await expect(install()).rejects.toThrow();
            expect(await readFile(path.join(backup, 'version'), 'utf8')).toBe('old');
            expect(await exists(path.join(cache, 'update.zip'))).toBe(true);
            expect(await exists(path.join(stage, 'owner.json'))).toBe(true);
        },
        20000
    );
    it('rejects an invalid update id without replacing or deleting anything', async () => {
        await expect(install('../other')).rejects.toThrow();
        expect(await readFile(path.join(target, 'version'), 'utf8')).toBe('old');
        expect(await exists(cache)).toBe(true);
        expect(await exists(staged)).toBe(true);
    }, 20000);
});
