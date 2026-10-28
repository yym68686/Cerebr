import { build } from 'vite';
import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyBuild } from './verify-build.mjs';
import { createPackagedManifest } from './extension-manifest.mjs';

const result = await build();
const contentEntry = result.output.find(
    (chunk) => chunk.type === 'chunk' && chunk.fileName === 'src/host/content/content-script.js'
);
if (!contentEntry?.exports.includes('bootContentScript'))
    throw new Error('Extension content entry was tree-shaken');
const dest = path.resolve('dist');
for (const name of ['htmd', 'icons', '_locales', 'statics', 'lib', 'styles']) {
    await cp(name, path.join(dest, name), {
        recursive: true,
        filter: (p) => !p.split(path.sep).includes('.git'),
    });
}
await cp('content.js', path.join(dest, 'content.js'));
// Preserve notices for the vendored Beautiful UI source, icons, font and styles
// in both the static site and the extension packages generated from dist.
const selectionLicenses = [
    ['Beautiful UI', 'src/app/components/beautiful-ui/LICENSE'],
    ['Inter', 'node_modules/@fontsource-variable/inter/LICENSE'],
    ['Iconoir', 'node_modules/iconoir-react/LICENSE'],
    ['class-variance-authority', 'node_modules/class-variance-authority/LICENSE'],
    ['clsx', 'node_modules/clsx/license'],
    ['tailwind-merge', 'node_modules/tailwind-merge/LICENSE.md'],
    ['Tailwind CSS', 'node_modules/tailwindcss/LICENSE'],
    ['shadow-plugin', 'node_modules/shadow-plugin/LICENSE'],
];
await writeFile(
    path.join(dest, 'selection-actions-NOTICES.txt'),
    (
        await Promise.all(
            selectionLicenses.map(async ([name, file]) => `${name}\n\n${await readFile(file, 'utf8')}`)
        )
    ).join('\n\n')
);
// Include the document libraries' transitive notices as well as their own.
const documentLicenses = [
    ['mammoth', 'LICENSE'],
    ['@xmldom/xmldom', 'LICENSE'],
    ['argparse', 'LICENSE'],
    ['sprintf-js', 'LICENSE'],
    ['base64-js', 'LICENSE'],
    ['dingbat-to-unicode', 'LICENSE'],
    ['jszip', 'LICENSE.markdown'],
    ['lie', 'license.md'],
    ['immediate', 'LICENSE.txt'],
    ['pako', 'LICENSE'],
    ['readable-stream', 'LICENSE'],
    ['core-util-is', 'LICENSE'],
    ['inherits', 'LICENSE'],
    ['isarray', 'README.md'],
    ['process-nextick-args', 'license.md'],
    ['safe-buffer', 'LICENSE'],
    ['string_decoder', 'LICENSE'],
    ['util-deprecate', 'LICENSE'],
    ['setimmediate', 'LICENSE.txt'],
    ['lop', 'LICENSE'],
    ['duck', 'LICENSE'],
    ['underscore', 'LICENSE'],
    ['option', 'LICENSE'],
    ['xmlbuilder', 'LICENSE'],
    ['htmlparser2', 'LICENSE'],
    ['domelementtype', 'LICENSE'],
    ['domhandler', 'LICENSE'],
    ['domutils', 'LICENSE'],
    ['dom-serializer', 'LICENSE'],
    ['entities', 'LICENSE'],
    ['fflate', 'LICENSE'],
];
await writeFile(
    path.join(dest, 'document-import-NOTICES.txt'),
    (
        await Promise.all(
            documentLicenses.map(
                async ([name, license]) =>
                    `${name}\n\n${await readFile(`node_modules/${name}/${license}`, 'utf8')}`
            )
        )
    ).join('\n\n')
);
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
for (const name of ['manifest.json', 'manifest.firefox.json']) {
    const m = JSON.parse(await readFile(name, 'utf8'));
    await writeFile(path.join(dest, name), JSON.stringify(createPackagedManifest(m), null, 2) + '\n');
}
let html = await readFile(path.join(dest, 'index.html'), 'utf8');
const entry = html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/)?.[1];
if (!entry) throw new Error('Missing Vite application entry');
const css = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)].map((m) => m[1]);
html = html
    .replace(/<script type="module"[^>]*><\/script>/g, '')
    .replace(/<link[^>]*rel="(?:stylesheet|modulepreload)"[^>]*>/g, '')
    .replace('</head>', '<script type="module" src="./boot.js"></script>\n</head>');
await writeFile(path.join(dest, 'index.html'), html);
await writeFile(
    path.join(dest, 'web-manifest.json'),
    JSON.stringify({ version: manifest.version, entry, css }) + '\n'
);
await cp('scripts/web-boot.js', path.join(dest, 'boot.js'));
await writeFile(
    path.join(dest, '_headers'),
    '/\n  Cache-Control: no-cache\n/index.html\n  Cache-Control: no-cache\n/boot.js\n  Cache-Control: no-cache\n/web-manifest.json\n  Cache-Control: no-store\n/v/*\n  Cache-Control: public, max-age=31536000, immutable\n'
);
await writeFile(path.join(dest, '.nojekyll'), '');
await verifyBuild(dest, result.output);
console.log(`Cerebr ${manifest.version}: static site and extension ready in dist/`);
