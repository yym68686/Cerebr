import path from 'node:path';
import { expect, it } from 'vitest';
import { applicationChunk } from '../scripts/build-entry.mjs';

it('finds React startup when Vite inlines the HTML facade behind shared dependency scripts', () => {
    const polyfill = {
        type: 'chunk',
        fileName: 'polyfill.js',
        modules: { '\0vite/modulepreload-polyfill': {} },
    };
    const app = {
        type: 'chunk',
        fileName: 'index-hash.js',
        isEntry: false,
        facadeModuleId: null,
        modules: { [path.resolve('index.html')]: {}, [path.resolve('src/main.jsx')]: {} },
    };
    const background = {
        type: 'chunk',
        isEntry: true,
        fileName: 'background.js',
        modules: { [path.resolve('background.js')]: {} },
    };
    expect(applicationChunk([polyfill, background, app])).toBe(app);
    expect(applicationChunk([polyfill, background])).toBeUndefined();
});
