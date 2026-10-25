import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { appAssetUrl, extensionAssetPath } from '../src/platform/assets.js';
import {
    createPackagedManifest,
    verifyContentModuleAccess,
    CONTENT_MODULE,
} from '../scripts/extension-manifest.mjs';

const sources = ['manifest.json', 'manifest.firefox.json'].map((name) =>
    JSON.parse(readFileSync(name, 'utf8'))
);
const chunks = [
    {
        type: 'chunk',
        fileName: CONTENT_MODULE,
        exports: ['bootContentScript'],
        imports: ['v/2.5.14/shared.js'],
        dynamicImports: [],
    },
    {
        type: 'chunk',
        fileName: 'v/2.5.14/shared.js',
        exports: [],
        imports: [],
        dynamicImports: ['v/2.5.14/guest.js'],
    },
    {
        type: 'chunk',
        fileName: 'v/2.5.14/guest.js',
        exports: [],
        imports: ['v/2.5.14/shared.js'],
        dynamicImports: [],
    },
];
afterEach(() => vi.unstubAllGlobals());

it('supports Firefox loading manifest.json even when manifest.firefox.json is selected', () => {
    // Temporary loading selects a directory; Firefox always reads manifest.json.
    const [checkout, firefox] = sources;
    expect(checkout.background.scripts).toEqual(firefox.background.scripts);
    expect(checkout.background.scripts).toEqual([checkout.background.service_worker]);
    expect(checkout.background.type).toBe('module');
    expect(checkout.browser_specific_settings.gecko.id).toBe(firefox.browser_specific_settings.gecko.id);
    expect(checkout.browser_specific_settings.gecko.strict_min_version).toBe('121.0');
    const packaged = createPackagedManifest(checkout);
    expect(packaged.background.scripts).toEqual(['background.js']);
    expect(packaged.background.service_worker).toBe('background.js');
});

describe.each(sources.map((source, index) => ({ source, browser: index ? 'Firefox' : 'Cross-browser' })))(
    '$browser extension asset paths',
    ({ source }) => {
        it('keeps shortcuts and declares userScripts as an optional browser permission', () => {
            for (const manifest of [source, createPackagedManifest(source)]) {
                expect(manifest.permissions).not.toContain('commands');
                expect(manifest.permissions).not.toContain('userScripts');
                expect(manifest.optional_permissions).toContain('userScripts');
                expect(manifest.commands.toggle_sidebar.suggested_key.default).toBe('Alt+Z');
                expect(manifest.commands.new_chat.suggested_key.default).toBe('Alt+X');
            }
        });
        it('loads only dist from the checkout and only root-relative assets from the package', () => {
            const packaged = createPackagedManifest(source);
            for (const resource of [
                'index.html',
                CONTENT_MODULE,
                'content.js',
                'lib/pdf.js',
                'lib/pdf.worker.js',
                'styles/components/sidebar.css',
                '_locales/en/messages.json',
                'statics/plugin-registry.json',
                'src/plugin/guest/shell-plugin-guest.html',
            ]) {
                expect(extensionAssetPath(resource, source)).toBe(`dist/${resource}`);
                expect(extensionAssetPath(resource, packaged)).toBe(resource);
                vi.stubGlobal('chrome', {
                    runtime: {
                        getManifest: () => source,
                        getURL: (path) => `chrome-extension://test/${path}`,
                    },
                });
                expect(appAssetUrl(resource)).toBe(`chrome-extension://test/dist/${resource}`);
            }
            expect(source.content_scripts[0].js).toEqual(['dist/content.js']);
            expect(packaged.content_scripts[0].js).toEqual(['content.js']);
            expect(source.sandbox.pages.every((page) => page.startsWith('dist/'))).toBe(true);
            expect(packaged.sandbox.pages.every((page) => !page.startsWith('dist/'))).toBe(true);
        });
        it('checks every direct, shared and lazy content dependency against web_accessible_resources', () => {
            for (const manifest of [source, createPackagedManifest(source)]) {
                expect(verifyContentModuleAccess(manifest, chunks)).toHaveLength(3);
                const broken = structuredClone(manifest);
                broken.web_accessible_resources[0].resources =
                    broken.web_accessible_resources[0].resources.filter((value) => !value.includes('v/*'));
                expect(() => verifyContentModuleAccess(broken, chunks)).toThrow('not web-accessible');
                expect(() => verifyContentModuleAccess(manifest, chunks.slice(0, -1))).toThrow(
                    'Missing compiled content dependency'
                );
            }
        });
    }
);
it('preserves GitHub Pages subpaths without relying on extension APIs', () => {
    const base = document.createElement('base');
    base.href = 'https://example.org/cerebr/';
    document.head.append(base);
    expect(appAssetUrl('statics/plugin-registry.json')).toBe(
        'https://example.org/cerebr/statics/plugin-registry.json'
    );
    base.remove();
});
it('rejects accidentally reintroducing a raw source entry into the checkout manifest', () => {
    const source = structuredClone(sources[0]);
    source.content_scripts[0].js = ['content.js'];
    expect(() => createPackagedManifest(source)).toThrow('inside dist/');
});
