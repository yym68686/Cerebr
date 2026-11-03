import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ open: vi.fn(), layers: [] }));
vi.mock('../src/runtime/input/pdf-preview.js', () => ({
    openPdfPreview: (...args) => state.open(...args),
    TextLayer: class {
        constructor({ container }) {
            this.container = container;
            state.layers.push(this);
        }
        render = vi.fn(async () => {
            this.container.textContent = 'PDF text';
        });
        cancel = vi.fn();
    },
}));
vi.mock('../src/utils/i18n.js', () => ({ t: (key) => key }));
import PdfPreviewPages from '../src/app/components/PdfPreviewPages.jsx';
let root, host, observers, page, pdf, loading, renders;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    observers = [];
    renders = [];
    state.layers = [];
    state.open.mockReset();
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            disconnect() {}
        }
    );
    vi.stubGlobal(
        'IntersectionObserver',
        class {
            constructor(callback) {
                this.callback = callback;
                observers.push(this);
            }
            observe(node) {
                this.node = node;
            }
            disconnect = vi.fn();
        }
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 600 });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({});
    page = {
        userUnit: 1,
        getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale, scale }),
        streamTextContent: vi.fn(() => ({})),
        render: vi.fn(() => {
            const render = { promise: Promise.resolve(), cancel: vi.fn() };
            renders.push(render);
            return render;
        }),
    };
    pdf = { numPages: 100, getPage: vi.fn(async () => page) };
    loading = { promise: Promise.resolve(pdf), destroy: vi.fn(async () => {}) };
    state.open.mockReturnValue(loading);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
const render = (onReady) =>
    act(async () =>
        root.render(<PdfPreviewPages source="data:application/pdf;base64,JVBERg==" onReady={onReady} />)
    );
it('renders only nearby pages with selectable text and releases backing stores when they leave view', async () => {
    await render();
    expect(host.querySelectorAll('.pdf-preview-page')).toHaveLength(100);
    expect(host.querySelector('canvas')).toBeNull();
    expect(pdf.getPage).toHaveBeenCalledTimes(1);
    await act(async () => observers[0].callback([{ isIntersecting: true }]));
    expect(host.querySelectorAll('canvas')).toHaveLength(1);
    expect(host.querySelector('.pdf-preview-text-layer').textContent).toBe('PDF text');
    expect(page.render).toHaveBeenCalledOnce();
    const canvas = host.querySelector('canvas');
    expect(canvas.width).toBe(600);
    await act(async () => observers[0].callback([{ isIntersecting: false }]));
    expect(canvas.width).toBe(0);
    expect(host.querySelector('canvas')).toBeNull();
    expect(renders[0].cancel).toHaveBeenCalledOnce();
    expect(state.layers[0].cancel).toHaveBeenCalledOnce();
    await act(async () => root.render(null));
    expect(loading.destroy).toHaveBeenCalledOnce();
    expect(observers.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true);
});
it('ignores a delayed load after closing, and reports a broken original without leaking its worker', async () => {
    let resolve;
    loading.promise = new Promise((done) => {
        resolve = done;
    });
    await render();
    await act(async () => root.render(null));
    expect(loading.destroy).toHaveBeenCalledOnce();
    await act(async () => resolve(pdf));
    expect(host.childNodes).toHaveLength(0);
    state.open.mockImplementation(() => {
        throw new Error('Invalid source');
    });
    await render();
    expect(host.querySelector('[role=alert]').textContent).toBe('pdf_invalid');
});
it('restores reading position after the page placeholders have measurable heights', async () => {
    const ready = vi.fn(() => {
        expect(host.querySelectorAll('.pdf-preview-page')).toHaveLength(100);
        expect(host.querySelector('.pdf-preview-page').style.height).toBe('800px');
    });
    await render(ready);
    expect(ready).toHaveBeenCalledOnce();
    await act(async () => observers[0].callback([{ isIntersecting: true }]));
    expect(ready).toHaveBeenCalledOnce();
});
