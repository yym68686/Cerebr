import { cp, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
// Package the current sources, including when dist already exists from an earlier build.
await import('./build.mjs');
const output = path.resolve('artifacts');
await mkdir(output, { recursive: true });
for (const target of ['chrome', 'firefox']) {
    const folder = path.join(output, target);
    await rm(folder, { recursive: true, force: true });
    await cp('dist', folder, { recursive: true });
    if (target === 'firefox')
        await cp(path.join(folder, 'manifest.firefox.json'), path.join(folder, 'manifest.json'));
    for (const file of ['manifest.firefox.json', '_headers', '.nojekyll'])
        await rm(path.join(folder, file), { force: true });
    const archive = path.join(output, target === 'chrome' ? 'cerebr.zip' : 'cerebr-firefox.zip');
    await rm(archive, { force: true });
    const result = spawnSync('zip', ['-qr', archive, '.'], { cwd: folder, stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`Failed to package ${target}`);
    console.log(archive);
}
