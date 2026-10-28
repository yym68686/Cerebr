import { app, autoUpdater, net } from 'electron';
import { access, appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { releaseAPI, selectRelease, parseChecksums, validateSquirrelFeed } from './update-release.js';
import { requestUpdate, retryUpdate, updateErrorCode } from './update-request.js';
import { downloadUpdate } from './update-download.js';
import {
    acknowledgeUpdateStartup,
    cleanupMacUpdateStages,
    cleanupUpdateCaches,
    isUpdateDirectoryName,
} from './update-cache.js';

const exec = promisify(execFile);
type Status = { phase: string; currentVersion: string; version?: string; progress?: number; error?: string };
export class DesktopUpdater {
    status: Status = { phase: 'idle', currentVersion: app.getVersion() };
    private directory = '';
    private staged = '';
    private target = '';
    private installed = false;
    private stage = 'idle';
    private installAfterDownload = false;
    private preparedVersion = '';
    private startupCleanup: Promise<void> | null = null;
    private startupId = '';
    constructor(
        private publish: (status: Status) => void,
        private flush: () => Promise<void>
    ) {}
    private set(patch: Partial<Status>) {
        this.status = { ...this.status, ...patch };
        this.publish(this.status);
    }
    private fetch(url: string, maxTime = 30000, options = {}) {
        return requestUpdate(net.fetch, url, app.getVersion(), maxTime, options);
    }
    private async log(event: string, error?: unknown) {
        const detail = error instanceof Error ? { name: error.name, message: error.message } : {};
        const entry = {
            time: new Date().toISOString(),
            event,
            stage: this.stage,
            currentVersion: app.getVersion(),
            version: this.status.version,
            ...detail,
        };
        try {
            await appendFile(
                path.join(app.getPath('userData'), 'desktop-update.log'),
                JSON.stringify(entry) + '\n',
                { mode: 0o600 }
            );
        } catch (logError) {
            console.error('[Updater] Could not write diagnostic log', logError);
        }
    }
    private retry<T>(operation: () => Promise<T>) {
        return retryUpdate(operation, {
            onRetry: (error: unknown, attempt: number) => this.log(`retry-${attempt}`, error),
        });
    }
    private async cleanup(obsoleteBefore = '') {
        const profile = app.getPath('userData');
        const onError = (error: unknown) => this.log('cleanup-failed', error);
        try {
            await cleanupUpdateCaches({
                base: path.join(profile, 'updates'),
                currentVersion: app.getVersion(),
                startupId: this.startupId,
                keep: this.directory ? [this.directory] : [],
                obsoleteBefore,
                onError,
            });
            if (process.platform === 'darwin')
                await cleanupMacUpdateStages({
                    application: path.resolve(process.execPath, '../../..'),
                    profile,
                    currentVersion: app.getVersion(),
                    keep: this.staged ? [path.dirname(this.staged)] : [],
                    onError,
                    readBundleInfo: async (plist: string) => {
                        const read = async (key: string) =>
                            (
                                await exec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])
                            ).stdout.trim();
                        return {
                            id: await read('CFBundleIdentifier'),
                            version: await read('CFBundleShortVersionString'),
                        };
                    },
                });
        } catch (error) {
            await onError(error);
        }
    }
    // Called once by the ready React session, not by a background update check.
    // Acknowledge before cleanup and retain the helper's receipt until it exits.
    confirmStartup(id = '') {
        if (!this.startupCleanup)
            this.startupCleanup = (async () => {
                if (!app.isPackaged) return;
                if (process.platform === 'darwin' && isUpdateDirectoryName(id)) this.startupId = id;
                try {
                    if (this.startupId)
                        await acknowledgeUpdateStartup(
                            path.join(app.getPath('userData'), 'updates'),
                            id,
                            app.getVersion()
                        );
                } catch (error) {
                    await this.log('startup-confirmation-failed', error);
                }
                await this.cleanup();
            })();
        return this.startupCleanup;
    }
    private writeStageOwner(pid: number) {
        return writeFile(
            path.join(path.dirname(this.staged), 'owner.json'),
            JSON.stringify({
                format: 1,
                profile: app.getPath('userData'),
                application: this.target,
                cacheId: path.basename(this.directory),
                pid,
            }),
            { mode: 0o600 }
        );
    }
    async check(installAfterDownload = false) {
        if (installAfterDownload) this.installAfterDownload = true;
        if (this.status.phase === 'downloaded' && installAfterDownload) {
            this.set({ phase: 'waiting' });
            return this.status;
        }
        if (['checking', 'downloading', 'waiting', 'installing'].includes(this.status.phase))
            return this.status;
        this.set({ phase: 'checking', error: undefined });
        this.stage = 'location';
        await this.log('check-started');
        try {
            await this.startupCleanup;
            if (!app.isPackaged)
                throw Object.assign(new Error('Packaged app required'), { updateCode: 'development' });
            if (process.platform === 'darwin') {
                this.target = path.resolve(process.execPath, '../../..');
                if (
                    !this.target.endsWith('.app') ||
                    this.target.startsWith('/Volumes/') ||
                    this.target.includes('/AppTranslocation/')
                )
                    throw Object.assign(new Error('Move app to Applications'), { updateCode: 'location' });
                try {
                    await access(path.dirname(this.target), constants.W_OK);
                } catch {
                    throw Object.assign(new Error('App directory not writable'), { updateCode: 'location' });
                }
            } else if (process.platform === 'win32') {
                try {
                    await access(path.resolve(process.execPath, '../../Update.exe'));
                } catch {
                    throw Object.assign(new Error('Squirrel installer required'), { updateCode: 'portable' });
                }
                if (process.argv.includes('--squirrel-firstrun') && process.uptime() < 15)
                    throw Object.assign(new Error('Installer still running'), { updateCode: 'first_run' });
            } else throw Object.assign(new Error('Unsupported platform'), { updateCode: 'unsupported' });
            this.stage = 'release';
            const release = selectRelease(
                await this.retry(async () => (await this.fetch(releaseAPI)).json()),
                app.getVersion(),
                process.platform,
                process.arch
            );
            if (!release) {
                this.installAfterDownload = false;
                this.set({ phase: 'current' });
                await this.log('already-current');
                return this.status;
            }
            if (release.version === this.preparedVersion) {
                this.set({ phase: this.installAfterDownload ? 'waiting' : 'downloaded' });
                return this.status;
            }
            this.set({
                version: release.version,
                ...(this.status.version !== release.version ? { progress: 0 } : {}),
            });
            this.stage = 'checksums';
            const hashes = parseChecksums(
                await this.retry(async () => (await this.fetch(release.checksums.url)).text()),
                release.files
            );
            this.stage = 'download';
            const base = path.join(app.getPath('userData'), 'updates');
            await mkdir(base, { recursive: true, mode: 0o700 });
            // Stable per-version cache survives failed requests and application
            // restarts. A newer release uses a different directory.
            if (this.staged) await rm(path.dirname(this.staged), { recursive: true, force: true });
            this.staged = '';
            this.preparedVersion = '';
            this.directory = path.join(
                base,
                `download-${release.version}-${process.platform}-${process.arch}`
            );
            await this.cleanup(release.version);
            await mkdir(this.directory, { recursive: true, mode: 0o700 });
            this.set({ phase: 'downloading', version: release.version });
            const sha1 = new Map<string, string>();
            const total = release.files.reduce((sum: number, file: any) => sum + file.size, 0);
            let completed = 0,
                lastPublished = 0;
            for (const file of release.files) {
                sha1.set(
                    file.name,
                    await downloadUpdate({
                        request: (url: string, options: any) => this.fetch(url, 20 * 60 * 1000, options),
                        retryOptions: {
                            onRetry: (error: unknown, attempt: number) =>
                                this.log(`download-retry-${attempt}`, error),
                        },
                        file,
                        destination: path.join(this.directory, file.name),
                        sha256: hashes.get(file.name),
                        onProgress: (fraction: number) => {
                            if (Date.now() - lastPublished < 200 && fraction !== 1) return;
                            lastPublished = Date.now();
                            this.set({
                                progress: Math.round(((completed + file.size * fraction) / total) * 100),
                            });
                        },
                    })
                );
                completed += file.size;
            }
            this.stage = 'prepare';
            if (process.platform === 'darwin') await this.prepareMac(release.files[0].name, release.version);
            else {
                const file = release.files[1];
                validateSquirrelFeed(
                    await readFile(path.join(this.directory, 'RELEASES'), 'utf8'),
                    file,
                    sha1.get(file.name)
                );
                await this.prepareWindows();
            }
            await this.log('update-ready');
            this.preparedVersion = release.version;
            this.set({ phase: this.installAfterDownload ? 'waiting' : 'downloaded', progress: 100 });
        } catch (error: any) {
            console.error('[Updater]', error);
            await this.log('check-failed', error);
            const fallback =
                this.stage === 'prepare'
                    ? 'prepare'
                    : ['release', 'checksums'].includes(this.stage)
                      ? 'release'
                      : 'download';
            const code = updateErrorCode(error) || fallback;
            this.set({
                phase: ['network', 'timeout', 'server'].includes(code) ? 'paused' : 'error',
                error: code,
            });
        }
        return this.status;
    }
    private async prepareMac(name: string, version: string) {
        const zip = path.join(this.directory, name),
            unpacked = path.join(this.directory, 'unpacked');
        const { stdout } = await exec('/usr/bin/unzip', ['-Z1', zip], { maxBuffer: 16 * 1024 * 1024 });
        if (stdout.split('\n').some((entry) => entry.startsWith('/') || entry.split('/').includes('..')))
            throw new Error('Unsafe archive path');
        await rm(unpacked, { recursive: true, force: true });
        await exec('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
        const bundle = path.join(unpacked, 'Cerebr.app');
        const plist = path.join(bundle, 'Contents/Info.plist');
        for (const [key, expected] of [
            ['CFBundleIdentifier', 'app.cerebr.desktop'],
            ['CFBundleShortVersionString', version],
        ]) {
            const result = await exec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]);
            if (result.stdout.trim() !== expected) throw new Error('Unexpected app in update');
        }
        await access(path.join(bundle, 'Contents/MacOS/Cerebr'), constants.X_OK);
        const stage = await mkdtemp(path.join(path.dirname(this.target), '.Cerebr-update-'));
        this.staged = path.join(stage, 'Cerebr.app');
        await this.writeStageOwner(process.pid);
        await exec('/usr/bin/ditto', [bundle, this.staged]);
        // The install bundle is now on the application's volume. Keep the ZIP
        // for retry/resume, but no longer retain a second unpacked copy.
        await rm(unpacked, { recursive: true, force: true }).catch((error) =>
            this.log('cleanup-failed', error)
        );
    }
    private prepareWindows() {
        return new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                autoUpdater.removeListener('error', failed);
                autoUpdater.removeListener('update-not-available', absent);
                autoUpdater.removeListener('update-downloaded', done);
            };
            const failed = (error: Error) => {
                cleanup();
                reject(error);
            };
            const absent = () => failed(new Error('Windows installer did not accept the update'));
            const done = () => {
                cleanup();
                resolve();
            };
            const timer = setTimeout(() => failed(new Error('Windows update timed out')), 10 * 60 * 1000);
            autoUpdater.once('error', failed);
            autoUpdater.once('update-not-available', absent);
            autoUpdater.once('update-downloaded', done);
            // Squirrel accepts a local release directory: all bytes were verified above.
            autoUpdater.setFeedURL({ url: this.directory });
            try {
                autoUpdater.checkForUpdates();
            } catch (error) {
                failed(error as Error);
            }
        });
    }
    saveFailed() {
        if (this.status.phase === 'waiting') this.set({ phase: 'error', error: 'save' });
    }
    async install() {
        if (this.status.phase !== 'waiting' || this.installed) return;
        this.set({ phase: 'installing' });
        this.stage = 'install';
        try {
            await this.flush();
            if (process.platform === 'win32') {
                this.installed = true;
                autoUpdater.quitAndInstall();
                return;
            }
            const helper = path.join(this.directory, 'install.sh');
            await cp(path.join(__dirname, 'install-mac-update.sh'), helper);
            const backup = path.join(path.dirname(this.staged), 'previous.app');
            const log = path.join(app.getPath('userData'), 'desktop-update.log');
            // Keep errors outside the app bundle so a failed replacement can be diagnosed.
            await writeFile(log, '', { flag: 'a', mode: 0o600 });
            // The resumable directory may survive an earlier install attempt.
            // Only the next renderer's acknowledgement can confirm this launch.
            await rm(path.join(this.directory, 'restarted'), { force: true });
            const child = spawn(
                '/bin/sh',
                [
                    helper,
                    String(process.pid),
                    this.target,
                    this.staged,
                    backup,
                    log,
                    app.getPath('userData'),
                    path.basename(this.directory),
                    this.status.version!,
                ],
                {
                    detached: true,
                    stdio: 'ignore',
                    cwd: '/',
                }
            );
            await new Promise<void>((resolve, reject) => {
                child.once('spawn', resolve);
                child.once('error', reject);
            });
            child.unref();
            await this.writeStageOwner(child.pid!);
            this.installed = true;
            app.quit();
        } catch (error) {
            console.error('[Updater] Installation failed', error);
            await this.log('install-failed', error);
            this.set({ phase: 'error', error: 'install' });
        }
    }
}
