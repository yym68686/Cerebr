import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
const output = path.resolve('artifacts/cerebr-source.zip');
const staging = await mkdtemp(path.join(tmpdir(), 'cerebr-review-source-'));
try {
    // Include the pinned htmd submodule; never copy secrets or other untracked files.
    const { stdout } = await execute('git', ['ls-files', '--recurse-submodules', '-z'], {
        maxBuffer: 32 * 1024 * 1024,
    });
    for (const file of stdout.split('\0').filter(Boolean)) {
        const target = path.join(staging, file);
        await mkdir(path.dirname(target), { recursive: true });
        await cp(file, target);
    }
    const sha = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(
        path.join(staging, 'REVIEW-BUILD.txt'),
        `Cerebr source for commit ${sha}\n\nUse Node.js 24 on Linux or macOS, with npm and zip installed.\nThe pinned htmd submodule is already included.\n\n1. npm ci\n2. npm run package:extension\n\nThe submitted Firefox package is artifacts/cerebr-firefox.zip.\nThe Chrome/Edge package is artifacts/cerebr.zip.\nVite compiles src/main.jsx and the extension/guest entry points.\nNo API keys or other private credentials are needed to build.\nVendored third-party browser libraries are in htmd/ and lib/.\n`
    );
    await mkdir(path.dirname(output), { recursive: true });
    await rm(output, { force: true });
    await execute('zip', ['-qr', output, '.'], { cwd: staging });
    console.log(output);
} finally {
    await rm(staging, { recursive: true, force: true });
}
