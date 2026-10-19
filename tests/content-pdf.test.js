import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/plugin/page/page-plugin-runtime.js', () => ({
    createPagePluginRuntime: () => ({ start: async () => {} }),
}));
vi.mock('../src/plugin/page/user-script-page-plugin-host.js', () => ({
    handleUserScriptPagePluginHostRpc: async () => null,
}));

let handleMessage, sendMessage, parsePdf, requests, listenerCleanup;
beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/selected-paper.pdf');
    document.title = 'Selected paper';
    requests = new Map();
    listenerCleanup = [];
    // Keep the real content entry and its lazy sidebar initialization. Only the
    // browser APIs and PDF parser are substituted at the extension boundary.
    for (const target of [window, document]) {
        const add = target.addEventListener.bind(target);
        vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
            listenerCleanup.push(() => target.removeEventListener(type, listener, options));
            add(type, listener, options);
        });
    }
    vi.stubGlobal(
        'MutationObserver',
        class {
            observe() {}
            disconnect() {}
        }
    );
    sendMessage = vi.fn((message, callback) => {
        let response = { success: true };
        if (message.action === 'downloadPDF') {
            const id = `pdf-${requests.size + 1}`;
            const bytes = new TextEncoder().encode('%PDF-test content for ' + message.url);
            requests.set(id, bytes);
            response = {
                success: true,
                requestId: id,
                totalSize: bytes.length,
                totalChunks: 1,
                chunkSize: bytes.length,
            };
        } else if (message.action === 'getPDFChunk') {
            response = { success: true, data: [...requests.get(message.requestId)] };
        }
        callback?.(response);
        return Promise.resolve(response);
    });
    vi.stubGlobal('chrome', {
        runtime: {
            getManifest: () => ({ background: { service_worker: 'dist/background.js' } }),
            getURL: (path) => `chrome-extension://test/${path}`,
            sendMessage,
        },
        storage: {
            local: { get: async () => ({}), set: async () => {} },
            sync: { get: async () => ({}), set: async () => {} },
        },
    });
    parsePdf = vi.fn(({ data }) => ({
        promise: Promise.resolve({
            numPages: 1,
            getPage: async () => ({
                getTextContent: async () => ({ items: [{ str: new TextDecoder().decode(data) }] }),
                cleanup() {},
            }),
            destroy: async () => {},
        }),
        destroy: async () => {},
    }));
    vi.stubGlobal('pdfjsLib', { GlobalWorkerOptions: {}, getDocument: parsePdf });
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('/* sidebar CSS */'))
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
    listenerCleanup.forEach((remove) => remove());
    document.querySelectorAll('cerebr-root').forEach((node) => node.parentNode.removeChild(node));
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
const extract = () =>
    new Promise((resolve) => {
        expect(handleMessage({ type: 'GET_PAGE_CONTENT_INTERNAL', skipWaitContent: true }, {}, resolve)).toBe(
            true
        );
    });
const start = async () => {
    handleMessage = (await import('../src/host/content/content-script.js')).bootContentScript();
};

describe('PDF extraction from a selected background tab', () => {
    it('returns PDF text without opening or creating its sidebar iframe', async () => {
        const create = vi.spyOn(document, 'createElement');
        await start();
        const result = await extract();
        expect(result).toMatchObject({
            title: 'Selected paper',
            content: expect.stringContaining('selected-paper.pdf'),
        });
        expect(parsePdf).toHaveBeenCalledOnce();
        expect(create.mock.calls.filter(([name]) => name === 'iframe')).toEqual([]);
        expect(sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'releasePDF' }),
            expect.any(Function)
        );
    });
    it('extracts even when the sidebar stylesheet is still loading', async () => {
        // Sidebar initialization is deliberately unresolved; extraction must not
        // require its DOM or the progress-message target to become available.
        fetch.mockImplementation(() => new Promise(() => {}));
        await start();
        const result = await extract();
        expect(result?.content).toContain('selected-paper.pdf');
    });
});
