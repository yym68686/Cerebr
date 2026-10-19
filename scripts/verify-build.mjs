import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { verifyContentModuleAccess } from './extension-manifest.mjs';
import { extensionAssetPath } from '../src/platform/assets.js';

export async function verifyBuild(root, chunks = []) {
    const assertFile = async (file) => {
        const target = path.resolve(root, file);
        if (!target.startsWith(`${root}${path.sep}`))
            throw new Error(`Asset escapes build directory: ${file}`);
        await access(target).catch(() => {
            throw new Error(`Missing built asset: ${file}`);
        });
    };
    const manifests = await Promise.all(
        ['manifest.json', 'manifest.firefox.json'].map(async (file) =>
            JSON.parse(await readFile(path.join(root, file), 'utf8'))
        )
    );
    for (const locale of await readdir(path.join(root, '_locales'))) {
        const messages=JSON.parse(await readFile(path.join(root, '_locales', locale, 'messages.json'), 'utf8'));
        for (const key of Object.keys(messages)) {
            if (!/^[a-zA-Z0-9_]+$/.test(key)) throw new Error(`Invalid extension locale key: ${locale}/${key}`);
        }
    }
    if (manifests[0].version !== manifests[1].version) throw new Error('Extension versions differ');
    for (const manifest of manifests) {
        if (
            manifest.background?.service_worker?.startsWith('dist/') ||
            manifest.background?.scripts?.some((entry) => entry.startsWith('dist/'))
        ) {
            throw new Error('Built extension manifest must use paths relative to dist/');
        }
        for (const asset of [
            ...Object.values(manifest.icons),
            ...(manifest.background.scripts || [manifest.background.service_worker]),
            ...manifest.content_scripts.flatMap((s) => s.js),
            ...manifest.sandbox.pages,
        ])
            await assertFile(asset);
    }
    for (const name of ['manifest.json', 'manifest.firefox.json']) {
        const source = JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), 'utf8'));
        if (extensionAssetPath('', source) !== 'dist/') throw new Error('Checkout extension must load dist/');
        const packaged = manifests[name === 'manifest.json' ? 0 : 1];
        for (const manifest of [source, packaged]) verifyContentModuleAccess(manifest, chunks);
        for (const script of source.content_scripts.flatMap((content) => content.js)) {
            if (!script.startsWith('dist/')) throw new Error('Checkout content script must be compiled');
            await assertFile(script.slice(5));
        }
    }
    const boot = JSON.parse(await readFile(path.join(root, 'web-manifest.json'), 'utf8'));
    for (const file of [boot.entry, ...boot.css]) await assertFile(file);
    for (const chunk of chunks.filter((c) => c.type === 'chunk')) {
        for (const imported of [...chunk.imports, ...chunk.dynamicImports])
            if (!/^(https?:|data:)/.test(imported)) await assertFile(imported);
    }
    for (const file of [
        'index.html',
        ...manifests[0].sandbox.pages,
        'src/plugin/guest/page-plugin-proxy.html',
    ]) {
        const html = await readFile(path.join(root, file), 'utf8');
        for (const [, url] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
            if (/^(?:https?:|data:|#)/.test(url)) continue;
            await assertFile(path.join(path.dirname(file), url));
        }
    }
    const versions = await readdir(path.join(root, 'v'));
    if (versions.length !== 1 || versions[0] !== boot.version)
        throw new Error('Build must contain exactly the current version');
    console.log(
        'Verified Web boot, guest assets and content-module permissions for checkout and packaged extensions.'
    );
}
