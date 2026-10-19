import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url)));
export default defineConfig({
    base: './',
    plugins: [react(), tailwindcss()],
    publicDir: false,
    define: { __CEREBR_VERSION__: JSON.stringify(version) },
    build: {
        target: 'es2022',
        assetsDir: `v/${version}`,
        rollupOptions: {
            preserveEntrySignatures: 'strict',
            input: {
                app: 'index.html',
                background: 'background.js',
                'src/host/content/content-script': 'src/host/content/content-script.js',
                'shell-guest': 'src/plugin/guest/shell-plugin-guest.html',
                'page-guest': 'src/plugin/guest/page-plugin-guest.html',
                'page-proxy': 'src/plugin/guest/page-plugin-proxy.html',
            },
            output: {
                entryFileNames: (chunk) =>
                    ['background', 'src/host/content/content-script'].includes(chunk.name)
                        ? '[name].js'
                        : `v/${version}/[name]-[hash].js`,
                chunkFileNames: `v/${version}/[name]-[hash].js`,
                assetFileNames: `v/${version}/[name]-[hash][extname]`,
            },
        },
    },
    test: { environment: 'jsdom', include: ['tests/**/*.test.{js,jsx}'] },
});
