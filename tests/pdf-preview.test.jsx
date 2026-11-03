import { act, useEffect, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/utils/i18n.js', () => ({ t: (key, values = []) => `${key} ${values.join(' ')}`.trim() }));
vi.mock('../src/utils/storage-adapter.js', () => ({
    storageAdapter: { get: async () => ({}), set: async () => {} },
    syncStorageAdapter: { get: async () => ({}) },
}));
vi.mock('../src/app/components/PdfPreviewPages.jsx', () => ({
    default: ({ source, onReady }) => {
        useEffect(() => {
            onReady?.();
        }, [onReady]);
        return (
            <div data-pdf-source={source}>
                <span>Selectable PDF passage</span>
            </div>
        );
    },
}));
import { PdfPreview } from '../src/app/components/PdfPreview.jsx';
import { uiStore } from '../src/app/state/ui-store.js';
import { openPdf, closePdf, closePdfTab } from '../src/app/state/pdf-preview.js';
let host, root, trigger, add, send;
const source = 'data:application/pdf;base64,JVBERg==';
const file = { id: 'pdf', name: 'paper.pdf', text: 'Extracted text', originalPdf: source };
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    closePdf();
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
it('opens only file tabs above the PDF and restores focus/layout on closing the last file', async () => {
    await render();
    expect(document.body.dataset.pdfPreview).toBe('true');
    expect(host.querySelector('[data-pdf-source]').dataset.pdfSource).toBe(source);
    expect(host.querySelector('pre')).toBeNull();
    expect(host.querySelector('header, a[download]')).toBeNull();
    expect(host.querySelector('[role=tab]').textContent.trim()).toBe(file.name);
    expect(document.activeElement).toBe(host.querySelector('[role=tab]'));
    await act(async () => host.querySelector('.pdf-preview-close').click());
    expect(document.body.dataset.pdfPreview).toBeUndefined();
    expect(document.activeElement).toBe(trigger);
});

function TabsPreview() {
    const state = useSyncExternalStore(uiStore.subscribe, uiStore.getSnapshot);
    return (
        state.pdf && (
            <PdfPreview
                file={state.pdf}
                files={state.pdfTabs}
                onSelect={openPdf}
                onClose={closePdfTab}
                onAdd={add}
                onSend={send}
            />
        )
    );
}
const activeTab = () => host.querySelector('[role=tab][aria-selected=true]');
it('switches files with mouse and keyboard, retaining each reading position and clearing old selection actions', async () => {
    const other = { ...file, id: 'other', name: 'other.pdf', originalPdf: `${source}AA==` };
    openPdf(file);
    await act(async () => root.render(<TabsPreview />));
    const originalBody = host.querySelector('.pdf-preview-body');
    originalBody.scrollTop = 320;
    originalBody.dispatchEvent(new Event('scroll'));
    await select();
    expect(surface()).toBeTruthy();
    await act(async () => openPdf(other));
    expect(host.querySelectorAll('[role=tab]')).toHaveLength(2);
    expect(activeTab().textContent.trim()).toBe('other.pdf');
    expect(surface()).toBeFalsy();
    expect(window.getSelection().toString()).toBe('');
    expect(host.querySelectorAll('[data-pdf-source]')).toHaveLength(1);
    expect(host.querySelector('.pdf-preview-body').scrollTop).toBe(0);
    const otherBody = host.querySelector('.pdf-preview-body');
    otherBody.scrollTop = 680;
    otherBody.dispatchEvent(new Event('scroll'));
    await act(async () => host.querySelector('[role=tab]').click());
    expect(host.querySelector('.pdf-preview-body').scrollTop).toBe(320);
    await act(async () =>
        activeTab().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    );
    expect(activeTab().textContent.trim()).toBe('other.pdf');
    expect(document.activeElement).toBe(activeTab());
    expect(host.querySelector('.pdf-preview-body').scrollTop).toBe(680);
    await act(async () =>
        activeTab().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    );
    expect(activeTab().textContent.trim()).toBe(file.name);
    await act(async () =>
        activeTab().dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    );
    expect(activeTab().textContent.trim()).toBe('other.pdf');
    expect(host.querySelectorAll('[role=tab]')).toHaveLength(1);
    await act(async () => host.querySelector('.pdf-preview-close').click());
    expect(host.querySelector('aside')).toBeNull();
    expect(document.body.dataset.pdfPreview).toBeUndefined();
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
