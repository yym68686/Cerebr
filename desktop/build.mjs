import { build } from 'vite';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
const root = path.dirname(fileURLToPath(import.meta.url));
await rm(path.join(root, '.vite'), { recursive: true, force: true });
await mkdir(path.join(root, '.vite'), { recursive: true });
for (const entry of ['main', 'preload', 'sync-service']) {
    await build({
        configFile: false,
        root,
        logLevel: 'warn',
        define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' },
        resolve: { conditions: ['node'], mainFields: ['module', 'main'] },
        build: {
            target: 'node22',
            emptyOutDir: false,
            outDir: '.vite',
            lib: { entry: `src/${entry}.ts`, formats: ['cjs'], fileName: () => `${entry}.cjs` },
            rollupOptions: { external: ['electron', /^node:/, ...builtinModules] },
            minify: false,
        },
    });
}
await cp(path.join(root, '../dist'), path.join(root, '.vite/renderer'), { recursive: true });
await cp(path.join(root, 'src/install-mac-update.sh'), path.join(root, '.vite/install-mac-update.sh'));
console.log('Desktop host and shared React frontend built.');
