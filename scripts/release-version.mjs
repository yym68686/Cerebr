import { readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const versionFiles = [
    'package.json',
    'desktop/package.json',
    'manifest.json',
    'manifest.firefox.json',
];
export const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

export async function readReleaseVersion(root = repositoryRoot) {
    const versions = await Promise.all(
        versionFiles.map(async (file) => [
            file,
            JSON.parse(await readFile(path.join(root, file), 'utf8')).version,
        ])
    );
    const version = versions[0][1];
    if (!/^\d+\.\d+\.\d+$/.test(version) || versions.some(([, value]) => value !== version))
        throw new Error(
            'Release versions must match: ' + versions.map(([file, value]) => `${file}=${value}`).join(', ')
        );
    return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const version = await readReleaseVersion();
    const tag = `v${version}`;
    if (process.env.GITHUB_REF?.startsWith('refs/tags/') && process.env.GITHUB_REF !== `refs/tags/${tag}`)
        throw new Error(`Tag ${process.env.GITHUB_REF} does not match package version ${tag}`);
    if (process.env.GITHUB_OUTPUT)
        await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\n`);
    console.log(tag);
}
