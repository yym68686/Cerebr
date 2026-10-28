import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isNewerVersion } from './update-release.js';

const versionPattern = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)';
const versioned = new RegExp(`^download-(${versionPattern})-(darwin|win32)-(arm64|x64)$`);
const legacy = /^download-[A-Za-z0-9]{6}$/;
const stagePattern = /^\.Cerebr-update-[A-Za-z0-9]{6}$/;
const validVersion = (version) => new RegExp(`^${versionPattern}$`).test(version);
export const isUpdateDirectoryName = (name) => versioned.test(name) || legacy.test(name);

async function info(file) {
    try {
        return await lstat(file);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return null;
    }
}
const directory = async (file) => (await info(file))?.isDirectory() === true;
async function smallFile(file) {
    const entry = await info(file);
    return entry?.isFile() && entry.size <= 4096 ? readFile(file, 'utf8') : null;
}

// Never follow a cache/staging-directory symlink or construct a deletion path
// from an unvalidated name. These helpers do not operate on the profile itself.
export async function acknowledgeUpdateStartup(base, id, version) {
    if (!isUpdateDirectoryName(id) || !validVersion(version) || !(await directory(base))) return false;
    const folder = path.join(base, id);
    if (!(await directory(folder))) return false;
    const receipt = path.join(folder, 'restarted');
    const existing = await info(receipt);
    if (existing && !existing.isFile()) throw new Error('Unsafe update startup receipt');
    const pending = path.join(folder, `restarted-${randomUUID()}.tmp`);
    try {
        await writeFile(pending, version, { flag: 'wx', mode: 0o600 });
        // The helper polls for existence: it must never observe an empty or
        // partially written receipt between asynchronous open/write calls.
        await rename(pending, receipt);
    } finally {
        await rm(pending, { force: true });
    }
    return true;
}

/** @param {{base: string, currentVersion: string, startupId?: string, keep?: string[], obsoleteBefore?: string, now?: number, onError?: (error: unknown) => unknown}} options */
export async function cleanupUpdateCaches({
    base,
    currentVersion,
    startupId = '',
    keep = [],
    obsoleteBefore = '',
    now = Date.now(),
    onError = (_error) => {},
}) {
    if (!validVersion(currentVersion) || !(await directory(base))) return;
    const protectedNames = new Set(keep.map((folder) => path.basename(folder)));
    for (const entry of await readdir(base, { withFileTypes: true })) {
        if (!entry.isDirectory() || !isUpdateDirectoryName(entry.name) || protectedNames.has(entry.name))
            continue;
        const folder = path.join(base, entry.name);
        try {
            if (!(await directory(folder))) continue;
            if (entry.name === startupId) {
                if ((await smallFile(path.join(folder, 'restarted'))) !== currentVersion) continue;
                // The old helper still needs install.sh/restarted. Reclaim only
                // payloads until it has observed the receipt (also works when
                // upgrading from a helper that never cleaned up its own cache).
                const archive = new RegExp(
                    `^Cerebr-darwin-(arm64|x64)-${currentVersion.replaceAll('.', '\\.')}\\.zip(?:\\.(?:part-[0-3]|resume\\.json|assembling))?$`
                );
                for (const file of await readdir(folder)) {
                    if (file !== 'unpacked' && !archive.test(file)) continue;
                    const target = path.join(folder, file),
                        item = await info(target);
                    if (item && !item.isSymbolicLink()) await rm(target, { recursive: true, force: true });
                }
                continue;
            }
            const version =
                versioned.exec(entry.name)?.[1] || (await smallFile(path.join(folder, 'restarted')));
            if (
                validVersion(version) &&
                (!isNewerVersion(version, currentVersion) ||
                    (validVersion(obsoleteBefore) && isNewerVersion(obsoleteBefore, version)))
            ) {
                await rm(folder, { recursive: true, force: true });
            } else if (
                legacy.test(entry.name) &&
                !version &&
                now - (await lstat(folder)).mtimeMs > 7 * 24 * 60 * 60 * 1000 &&
                !(await readdir(folder)).length
            ) {
                await rmdir(folder);
            }
        } catch (error) {
            await onError(error);
        }
    }
}

export function isProcessAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code !== 'ESRCH';
    }
}

/** @param {{application: string, profile: string, currentVersion: string, keep?: string[], readBundleInfo: (plist: string) => Promise<{id: string, version: string}>, processAlive?: (pid: number) => boolean, onError?: (error: unknown) => unknown}} options */
export async function cleanupMacUpdateStages({
    application,
    profile,
    currentVersion,
    keep = [],
    readBundleInfo,
    processAlive = isProcessAlive,
    onError = (_error) => {},
}) {
    if (!validVersion(currentVersion) || !application.endsWith('.app')) return;
    const parent = path.dirname(application);
    if (!(await directory(parent))) return;
    for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (!entry.isDirectory() || !stagePattern.test(entry.name)) continue;
        const folder = path.join(parent, entry.name);
        if (keep.includes(folder)) continue;
        try {
            if (!(await directory(folder))) continue;
            const contents = await readdir(folder);
            // An unconfirmed launch/failed install may still require previous.app.
            // Never remove a rollback bundle, even when its owner has exited.
            if (contents.some((name) => !['Cerebr.app', 'owner.json'].includes(name))) continue;
            const ownerText = await smallFile(path.join(folder, 'owner.json'));
            if (contents.includes('owner.json') && ownerText === null) continue;
            if (ownerText !== null) {
                const owner = JSON.parse(ownerText);
                if (
                    owner.format !== 1 ||
                    owner.profile !== profile ||
                    owner.application !== application ||
                    !isUpdateDirectoryName(owner.cacheId) ||
                    !Number.isSafeInteger(owner.pid) ||
                    owner.pid <= 0 ||
                    processAlive(owner.pid)
                )
                    continue;
                await rm(folder, { recursive: true, force: true });
            } else {
                // Legacy stages have no ownership marker. Only an older,
                // validated Cerebr bundle is provably obsolete; leave a pending
                // current/newer version alone, including other profiles' updates.
                const bundle = path.join(folder, 'Cerebr.app');
                if (!(await directory(bundle))) continue;
                const plist = path.join(bundle, 'Contents/Info.plist');
                const resolved = await realpath(plist);
                if (resolved !== path.join(await realpath(folder), 'Cerebr.app/Contents/Info.plist'))
                    continue;
                const identity = await readBundleInfo(plist);
                if (
                    identity.id === 'app.cerebr.desktop' &&
                    validVersion(identity.version) &&
                    isNewerVersion(currentVersion, identity.version)
                )
                    await rm(folder, { recursive: true, force: true });
            }
        } catch (error) {
            await onError(error);
        }
    }
}
