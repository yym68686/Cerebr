import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/utils/i18n.js', () => ({ t: (key, values = []) => `${key} ${values.join(' ')}`.trim() }));
vi.mock('../src/utils/storage-adapter.js', () => ({
    storageAdapter: { get: async () => ({}), set: async () => {} },
    syncStorageAdapter: { get: async () => ({}) },
}));
vi.mock('../src/app/components/PdfPreviewPages.jsx', () => ({
    default: ({ source }) => (
        <div data-pdf-source={source}>
            <span>Selectable PDF passage</span>
        </div>
    ),
}));
import { PdfPreview } from '../src/app/components/PdfPreview.jsx';
let host, root, trigger, add, send;
const source = 'data:application/pdf;base64,JVBERg==';
const file = { id: 'pdf', name: 'paper.pdf', text: 'Extracted text', originalPdf: source };
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            disconnect() {}
        }
    );
    Range.prototype.getBoundingClientRect = () => ({
        left: 600,
        right: 720,
        top: 100,
        bottom: 120,
        width: 120,
        height: 20,
    });
    trigger = document.createElement('button');
    host = document.createElement('div');
    document.body.append(trigger, host);
    trigger.focus();
    root = createRoot(host);
    add = vi.fn();
    send = vi.fn(async () => true);
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    trigger.remove();
    window.getSelection().removeAllRanges();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
const render = async (value = file, disabled = false) =>
    act(async () =>
        root.render(
            <PdfPreview
                file={value}
                disabled={disabled}
                onClose={() => root.render(null)}
                onAdd={add}
                onSend={send}
            />
        )
    );
const select = async () =>
    act(async () => {
        const range = document.createRange();
        range.selectNodeContents(host.querySelector('.pdf-preview-body span, .pdf-preview-body pre'));
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        await vi.advanceTimersByTimeAsync(200);
    });
const surface = () => host.querySelector('[data-selection-actions]')?.shadowRoot;
it('opens a named side panel, downloads the original and restores focus/layout on close', async () => {
    await render();
    expect(document.body.dataset.pdfPreview).toBe('true');
    expect(host.querySelector('[data-pdf-source]').dataset.pdfSource).toBe(source);
    expect(host.querySelector('pre')).toBeNull();
    const download = host.querySelector('a[download]');
    expect(download.getAttribute('href')).toBe(source);
    expect(download.download).toBe(file.name);
    expect(document.activeElement).toBe(host.querySelector('.pdf-preview-close'));
    await act(async () => host.querySelector('.pdf-preview-close').click());
    expect(document.body.dataset.pdfPreview).toBeUndefined();
    expect(document.activeElement).toBe(trigger);
});
it('offers Selection Actions for PDF text and adds the exact passage to the draft', async () => {
    await render();
    await select();
    expect(surface()).toBeTruthy();
    await act(async () => surface().querySelector('[data-action="add"]').click());
    expect(add).toHaveBeenCalledWith('Selectable PDF passage');
    expect(surface()).toBeFalsy();
});
it('sends a PDF text selection through the existing selection pipeline', async () => {
    await render();
    await select();
    await act(async () => surface().querySelector('[data-action="explain"]').click());
    expect(send).toHaveBeenCalledWith('Selectable PDF passage', 'selection_explain_prompt');
});
it('keeps legacy PDF text readable and selectable without pretending to have an original', async () => {
    await render({ ...file, originalPdf: undefined, text: '<script>literal text</script>' });
    expect(host.querySelector('pre').textContent).toBe('<script>literal text</script>');
    expect(host.querySelector('script, a[download]')).toBeNull();
    await select();
    expect(surface()).toBeTruthy();
    await render({ ...file, originalPdf: undefined }, true);
    expect(host.querySelector('aside').hasAttribute('inert')).toBe(true);
    expect(surface()).toBeFalsy();
});
