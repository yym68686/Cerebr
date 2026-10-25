import { extensionAssetPath } from '../src/platform/assets.js';

export const CONTENT_MODULE = 'src/host/content/content-script.js';

// The checkout manifest mounts the build at dist/. Archives put that same build
// at their root. Source modules are never an extension execution path.
export function createPackagedManifest(source, { browser = 'cross-browser' } = {}) {
    const manifest = structuredClone(source);
    if (browser === 'chrome') {
        delete manifest.background.scripts;
        delete manifest.browser_specific_settings;
    } else if (browser === 'firefox') {
        delete manifest.background.service_worker;
    } else if (browser !== 'cross-browser') {
        throw new Error(`Unsupported extension browser: ${browser}`);
    }
    const strip = (value) => {
        if (!value.startsWith('dist/'))
            throw new Error(`Checkout extension asset must be inside dist/: ${value}`);
        return value.slice('dist/'.length);
    };
    if (manifest.background.service_worker)
        manifest.background.service_worker = strip(manifest.background.service_worker);
    if (manifest.background.scripts) manifest.background.scripts = manifest.background.scripts.map(strip);
    for (const content of manifest.content_scripts) content.js = content.js.map(strip);
    manifest.sandbox.pages = manifest.sandbox.pages.map(strip);
    for (const group of manifest.web_accessible_resources) group.resources = group.resources.map(strip);
    return manifest;
}

export function isWebAccessible(manifest, asset) {
    return manifest.web_accessible_resources.some(
        (group) =>
            group.matches?.includes('<all_urls>') &&
            group.resources.some((pattern) => {
                const escaped = pattern
                    .replace(/^\//, '')
                    .split('*')
                    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                    .join('.*');
                return new RegExp(`^${escaped}$`).test(asset);
            })
    );
}

export function verifyContentModuleAccess(manifest, chunks) {
    const modules = new Map(
        chunks.filter((chunk) => chunk.type === 'chunk').map((chunk) => [chunk.fileName, chunk])
    );
    const entry = modules.get(CONTENT_MODULE);
    if (!entry?.exports.includes('bootContentScript'))
        throw new Error('Missing compiled content entry or bootContentScript export');
    const visited = new Set();
    const visit = (file) => {
        if (visited.has(file)) return;
        visited.add(file);
        const chunk = modules.get(file);
        if (!chunk) throw new Error(`Missing compiled content dependency: ${file}`);
        const asset = extensionAssetPath(file, manifest);
        if (!isWebAccessible(manifest, asset))
            throw new Error(`Content dependency is not web-accessible: ${asset}`);
        for (const imported of [...chunk.imports, ...chunk.dynamicImports]) visit(imported);
    };
    visit(CONTENT_MODULE);
    for (const resource of [
        'index.html',
        'boot.js',
        'web-manifest.json',
        'styles/components/sidebar.css',
        'lib/pdf.worker.js',
        'src/plugin/guest/page-plugin-guest.html',
        'src/plugin/guest/page-plugin-proxy.html',
    ]) {
        const asset = extensionAssetPath(resource, manifest);
        if (!isWebAccessible(manifest, asset))
            throw new Error(`Page resource is not web-accessible: ${asset}`);
    }
    return [...visited];
}
