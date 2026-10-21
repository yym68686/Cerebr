import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { updateError } from './update-request.js';

export const releaseAPI = 'https://api.github.com/repos/yym68686/Cerebr/releases/latest';
const releases = 'https://github.com/yym68686/Cerebr/releases/download/';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function isNewerVersion(next, current) {
    if (!versionPattern.test(next) || !versionPattern.test(current)) throw new Error('Invalid version');
    const a = next.split('.').map(Number),
        b = current.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
}

export function selectRelease(release, current, platform, arch) {
    if (release.draft || release.prerelease) return null;
    const version = String(release.tag_name).replace(/^v/, '');
    if (!isNewerVersion(version, current)) return null;
    if (!['darwin-arm64', 'darwin-x64', 'win32-x64'].includes(`${platform}-${arch}`))
        throw new Error('Unsupported update target');
    const names =
        platform === 'darwin'
            ? [`Cerebr-darwin-${arch}-${version}.zip`]
            : ['RELEASES', `Cerebr-${version}-full.nupkg`];
    const checksumName = `Cerebr-${version}-${platform}-${arch}-SHA256SUMS.txt`;
    const asset = (name) => {
        const matches = release.assets?.filter((item) => item.name === name) || [];
        const item = matches[0];
        if (
            matches.length !== 1 ||
            !Number.isSafeInteger(item.size) ||
            item.size <= 0 ||
            item.size > 1024 ** 3 ||
            item.browser_download_url !== `${releases}v${version}/${name}`
        )
            throw new Error(`Invalid or missing release asset: ${name}`);
        return { name, size: item.size, url: item.browser_download_url };
    };
    return { version, files: names.map(asset), checksums: asset(checksumName) };
}

export function parseChecksums(text, files) {
    const hashes = new Map();
    for (const line of text.trim().split(/\r?\n/)) {
        const match = /^([a-f0-9]{64})  ([^/\\]+)$/.exec(line);
        if (!match || hashes.has(match[2])) throw new Error('Invalid checksums');
        hashes.set(match[2], match[1]);
    }
    for (const file of files) if (!hashes.has(file.name)) throw new Error('Missing checksum');
    return hashes;
}

export function validateSquirrelFeed(text, file, sha1) {
    const match = /^([a-f0-9]{40}) (\S+) (\d+)\s*$/i.exec(text.trim());
    if (!match || match[1].toLowerCase() !== sha1 || match[2] !== file.name || Number(match[3]) !== file.size)
        throw new Error('Invalid Windows update feed');
}

// Stream to a private staging directory. A partial download never becomes an installer.
export async function downloadVerified({
    response,
    file,
    destination,
    sha256,
    onProgress = (fraction) => {
        void fraction;
    },
}) {
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`);
    const handle = await open(destination, 'wx', 0o600);
    const hash = createHash('sha256'),
        sha1 = createHash('sha1');
    let bytes = 0;
    try {
        for await (const chunk of response.body) {
            bytes += chunk.length;
            if (bytes > file.size) throw updateError('integrity', 'Update size mismatch');
            hash.update(chunk);
            sha1.update(chunk);
            await handle.writeFile(chunk);
            onProgress(bytes / file.size);
        }
        if (bytes !== file.size || hash.digest('hex') !== sha256)
            throw updateError('integrity', 'Update checksum mismatch');
        await handle.sync();
        return sha1.digest('hex');
    } catch (error) {
        await handle.close();
        await rm(destination, { force: true });
        throw error;
    } finally {
        await handle.close();
    }
}
