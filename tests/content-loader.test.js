// @vitest-environment node
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { createPackagedManifest } from '../scripts/extension-manifest.mjs';

const loader = readFileSync('content.js', 'utf8');
const source = JSON.parse(readFileSync('manifest.json', 'utf8'));
const variants = [
    { name: 'existing repository installation', manifest: source, directory: 'dist/' },
    { name: 'packaged extension', manifest: createPackagedManifest(source), directory: '' },
];

describe.each(variants)('content bootstrap: $name', ({ manifest, directory }) => {
    it('loads the compiled entry and delivers messages queued before startup', async () => {
        let listener, resolveModule;
        const handler = vi.fn(() => true);
        const importModule = vi.fn(
            () =>
                new Promise((resolve) => {
                    resolveModule = resolve;
                })
        );
        const context = createContext({
            chrome: {
                runtime: {
                    getManifest: () => manifest,
                    getURL: (path) => `chrome-extension://test/${path}`,
                    onMessage: {
                        addListener: (callback) => {
                            listener = callback;
                        },
                    },
                },
            },
            console,
            importModule,
        });
        // Intercept only the asynchronous import, leaving the loader and its
        // runtime message queue intact so no browser permissions are simulated.
        const script = new Script(loader.replace('void import(', 'void importModule('));
        script.runInContext(context);
        script.runInContext(context);
        expect(importModule).toHaveBeenCalledTimes(1);
        expect(importModule).toHaveBeenCalledWith(
            `chrome-extension://test/${directory}src/host/content/content-script.js`
        );
        const response = vi.fn();
        const message = { type: 'TOGGLE_SIDEBAR' };
        expect(listener(message, { tab: { id: 7 } }, response)).toBe(true);
        expect(handler).not.toHaveBeenCalled();
        resolveModule({ bootContentScript: () => handler });
        await new Promise((resolve) => setImmediate(resolve));
        expect(handler).toHaveBeenCalledWith(message, { tab: { id: 7 } }, response);
        expect(listener({ type: 'PING' }, {}, response)).toBe(true);
        expect(handler).toHaveBeenCalledTimes(2);
        script.runInContext(context);
        expect(importModule).toHaveBeenCalledTimes(1);
    });
});

it('settles messages after a failed import and allows a subsequent reinjection', async () => {
    const listeners = new Set();
    const error = new Error('Failed to fetch dynamically imported module');
    let rejectModule;
    const importModule = vi.fn(() => new Promise((_, reject) => { rejectModule = reject; }));
    const context = createContext({
        chrome: { runtime: {
            getManifest: () => source,
            getURL: path => `chrome-extension://test/${path}`,
            onMessage: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) },
        } },
        console: { error: vi.fn() },
        importModule,
    });
    const script = new Script(loader.replace('void import(', 'void importModule('));
    script.runInContext(context);
    const listener = [...listeners][0];
    const queued = vi.fn();
    expect(listener({ type: 'PING' }, {}, queued)).toBe(true);
    rejectModule(error);
    await new Promise(resolve => setImmediate(resolve));
    expect(queued).toHaveBeenCalledWith(null);
    const next = vi.fn();
    expect(listener({ type: 'PING' }, {}, next)).toBe(false);
    expect(next).toHaveBeenCalledWith(null);
    const handler = vi.fn();
    importModule.mockResolvedValue({ bootContentScript: () => handler });
    script.runInContext(context);
    await new Promise(resolve => setImmediate(resolve));
    expect(importModule).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(1);
    [...listeners][0]({ type: 'PING' }, {}, next);
    expect(handler).toHaveBeenCalledTimes(1);
});
