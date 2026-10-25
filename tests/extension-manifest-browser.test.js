import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createPackagedManifest } from '../scripts/extension-manifest.mjs';

const chromeManifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const firefoxManifest = JSON.parse(readFileSync('manifest.firefox.json', 'utf8'));

it('removes Firefox-only declarations from the Chrome package', () => {
    const manifest = createPackagedManifest(chromeManifest, { browser: 'chrome' });
    expect(manifest.background).toEqual({ service_worker: 'background.js', type: 'module' });
    expect(manifest.browser_specific_settings).toBeUndefined();
});

it('removes the unsupported service worker declaration from the Firefox package', () => {
    const manifest = createPackagedManifest(firefoxManifest, { browser: 'firefox' });
    expect(manifest.background).toEqual({ scripts: ['background.js'], type: 'module' });
});
