import { createReadStream } from 'node:fs';
import { mkdir, readdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const [platform, arch] = process.argv.slice(2);
if (!['darwin-arm64', 'darwin-x64', 'win32-x64'].includes(`${platform}-${arch}`))
    throw new Error('Unsupported release target');
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const make = path.resolve('artifacts/desktop/make');
const output = path.resolve(`artifacts/release/${platform}-${arch}`);
const candidates = await readdir(make, { recursive: true });
const installer =
    platform === 'darwin' ? `Cerebr-${version}-${arch}.dmg` : `Cerebr-${version}-win32-${arch}-Setup.exe`;
const files = [];
for (const name of [installer, `Cerebr-${platform}-${arch}-${version}.zip`]) {
    const matches = candidates.filter(
        (file) => file.split(path.sep).includes(arch) && path.basename(file) === name
    );
    if (matches.length !== 1) throw new Error(`Expected one ${name}; got ${matches.length}`);
    files.push(matches[0]);
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const checksums = [];
for (const file of files) {
    const name = path.basename(file);
    await cp(path.join(make, file), path.join(output, name));
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path.join(output, name))) hash.update(chunk);
    checksums.push(`${hash.digest('hex')}  ${name}`);
}
await writeFile(
    path.join(output, `Cerebr-${version}-${platform}-${arch}-SHA256SUMS.txt`),
    checksums.join('\n') + '\n'
);
console.log(`Collected ${files.length} desktop packages for ${platform}-${arch}`);
