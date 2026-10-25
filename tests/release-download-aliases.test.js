// @vitest-environment node
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESKTOP_DOWNLOADS } from '../src/platform/desktop-downloads.js';

it.each(DESKTOP_DOWNLOADS)(
    'publishes $id direct downloads with the same installer bytes and checksums',
    async ({ id, file }) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'cerebr-download-'));
        const [platform, arch] = id.split('-');
        const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
        const make = path.join(directory, 'artifacts/desktop/make', arch);
        const installer =
            platform === 'darwin'
                ? `Cerebr-${version}-${arch}.dmg`
                : `Cerebr-${version}-win32-${arch}-Setup.exe`;
        try {
            await mkdir(make, { recursive: true });
            for (const name of [
                installer,
                `Cerebr-${platform}-${arch}-${version}.zip`,
                ...(platform === 'win32' ? ['RELEASES', `Cerebr-${version}-full.nupkg`] : []),
            ])
                await writeFile(path.join(make, name), `fixture: ${name}`);
            execFileSync(
                process.execPath,
                [
                    fileURLToPath(new URL('../scripts/collect-desktop-release.mjs', import.meta.url)),
                    platform,
                    arch,
                ],
                { cwd: directory }
            );
            const output = path.join(directory, 'artifacts/release', id);
            const alias = await readFile(path.join(output, file));
            expect(alias).toEqual(await readFile(path.join(output, installer)));
            const checksum = createHash('sha256').update(alias).digest('hex');
            expect(
                await readFile(path.join(output, `Cerebr-${version}-${id}-SHA256SUMS.txt`), 'utf8')
            ).toContain(`${checksum}  ${file}\n`);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }
);
