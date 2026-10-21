import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, writeFile, stat, rm, rename } from 'node:fs/promises';
import { retryUpdate, updateError } from './update-request.js';

async function sizeOf(file) {
    try {
        return (await stat(file)).size;
    } catch (error) {
        if (error.code === 'ENOENT') return 0;
        throw error;
    }
}

async function verify(file, size, expected) {
    if ((await sizeOf(file)) !== size) return null;
    const sha256 = createHash('sha256'),
        sha1 = createHash('sha1');
    for await (const chunk of createReadStream(file)) {
        sha256.update(chunk);
        sha1.update(chunk);
    }
    return sha256.digest('hex') === expected ? sha1.digest('hex') : null;
}

// Files are partitioned into stable ranges. Their lengths are the durable
// checkpoints, so a process exit cannot lose an in-memory progress counter.
// Only a fully assembled and SHA-256-verified file becomes an installer.
export async function downloadUpdate({
    file,
    destination,
    sha256,
    request,
    onProgress = (_fraction) => {},
    concurrency = 4,
    minPartSize = 4 * 1024 * 1024,
    retryOptions = {},
}) {
    const cached = await verify(destination, file.size, sha256);
    if (cached) {
        onProgress(1);
        return cached;
    }
    await rm(destination, { force: true });
    const count = Math.max(1, Math.min(4, concurrency, Math.floor(file.size / minPartSize)));
    const partSize = Math.ceil(file.size / count);
    const parts = Array.from({ length: count }, (_, i) => ({
        path: `${destination}.part-${i}`,
        start: i * partSize,
        length: Math.min(partSize, file.size - i * partSize),
    }));
    const metadata = `${destination}.resume.json`,
        assembled = `${destination}.assembling`;
    const identity = JSON.stringify({ format: 1, url: file.url, size: file.size, sha256, count });
    const clearParts = async () => {
        await Promise.all(
            Array.from({ length: 4 }, (_, i) => rm(`${destination}.part-${i}`, { force: true }))
        );
        await rm(assembled, { force: true });
    };
    let saved;
    try {
        saved = await readFile(metadata, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (saved !== identity) {
        await clearParts();
        await writeFile(metadata, identity, { mode: 0o600 });
    }
    const sizes = await Promise.all(
        parts.map(async (part) => {
            const size = await sizeOf(part.path);
            if (size > part.length) {
                await rm(part.path, { force: true });
                return 0;
            }
            return size;
        })
    );
    const progress = () => onProgress(sizes.reduce((sum, size) => sum + size, 0) / file.size);
    progress();
    const validateRange = (response, start, end) => {
        if (
            response.status !== 206 ||
            response.headers.get('content-range') !== `bytes ${start}-${end}/${file.size}`
        )
            throw updateError('integrity', 'Unexpected update byte range');
    };
    const writeBody = async (response, index, remaining, append) => {
        if (!response.body) throw updateError('network', 'Update response has no body');
        const handle = await open(parts[index].path, append ? 'a' : 'w', 0o600);
        let received = 0;
        try {
            for await (const chunk of response.body) {
                if (received + chunk.length > remaining)
                    throw updateError('integrity', 'Update size mismatch');
                await handle.writeFile(chunk);
                received += chunk.length;
                sizes[index] += chunk.length;
                progress();
            }
            if (received !== remaining) throw updateError('network', 'Update download ended early');
        } finally {
            try {
                await handle.sync();
            } finally {
                await handle.close();
            }
        }
    };
    try {
        if (sizes.some((size, i) => size < parts[i].length)) {
            // Probe range support without downloading the archive twice. A
            // server/proxy returning 200 is safely handled as a full transfer.
            const probe = await retryUpdate(
                () => request(file.url, { headers: { Range: 'bytes=0-0' } }),
                retryOptions
            );
            if (probe.status === 200) {
                await clearParts();
                sizes.fill(0);
                let response = probe;
                await retryUpdate(async () => {
                    const current = response || (await request(file.url));
                    response = null;
                    if (current.status !== 200) {
                        await current.body?.cancel();
                        throw updateError('integrity', 'Expected a complete update response');
                    }
                    sizes.fill(0);
                    await writeBody(current, 0, file.size, false);
                }, retryOptions);
                parts.splice(1);
            } else {
                try {
                    validateRange(probe, 0, 0);
                } finally {
                    await probe.body?.cancel();
                }
                const controller = new AbortController();
                let failure;
                await Promise.allSettled(
                    parts.map(async (part, i) => {
                        try {
                            await retryUpdate(async () => {
                                controller.signal.throwIfAborted();
                                sizes[i] = await sizeOf(part.path);
                                if (sizes[i] === part.length) return;
                                const start = part.start + sizes[i],
                                    end = part.start + part.length - 1;
                                const response = await request(file.url, {
                                    headers: { Range: `bytes=${start}-${end}` },
                                    signal: controller.signal,
                                });
                                try {
                                    validateRange(response, start, end);
                                } catch (error) {
                                    await response.body?.cancel();
                                    throw error;
                                }
                                await writeBody(response, i, part.length - sizes[i], true);
                            }, retryOptions);
                        } catch (error) {
                            failure ||= error;
                            controller.abort(error);
                        }
                    })
                );
                if (failure) throw failure;
            }
        }
        const output = await open(assembled, 'w', 0o600);
        try {
            for (const part of parts)
                for await (const chunk of createReadStream(part.path)) await output.writeFile(chunk);
            await output.sync();
        } finally {
            await output.close();
        }
        const sha1 = await verify(assembled, file.size, sha256);
        if (!sha1) throw updateError('integrity', 'Update checksum mismatch');
        await rename(assembled, destination);
        await clearParts();
        await rm(metadata, { force: true });
        onProgress(1);
        return sha1;
    } catch (error) {
        // Network failures leave the verified identity and received bytes on
        // disk. Invalid content is never reused by a later attempt.
        if (error.updateCode === 'integrity') {
            await clearParts();
            await rm(metadata, { force: true });
        }
        throw error;
    }
}
