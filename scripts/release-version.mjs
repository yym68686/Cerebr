import { readFile, appendFile } from 'node:fs/promises';

const files = ['package.json', 'desktop/package.json', 'manifest.json', 'manifest.firefox.json'];
const versions = await Promise.all(
    files.map(async (file) => [
        file,
        JSON.parse(await readFile(new URL('../' + file, import.meta.url), 'utf8')).version,
    ])
);
const version = versions[0][1];
if (!/^\d+\.\d+\.\d+$/.test(version) || versions.some(([, value]) => value !== version))
    throw new Error(
        'Release versions must match: ' + versions.map(([file, value]) => `${file}=${value}`).join(', ')
    );
const tag = `v${version}`;
if (process.env.GITHUB_REF?.startsWith('refs/tags/') && process.env.GITHUB_REF !== `refs/tags/${tag}`)
    throw new Error(`Tag ${process.env.GITHUB_REF} does not match package version ${tag}`);
if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\n`);
console.log(tag);
