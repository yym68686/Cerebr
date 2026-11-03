import { afterEach, expect, it } from 'vitest';
import { uiStore } from '../src/app/state/ui-store.js';
import { openPdf, closePdf, closePdfTab } from '../src/app/state/pdf-preview.js';

afterEach(closePdf);
const file = (id) => ({ id, name: `${id}.pdf`, text: 'PDF text', size: 100 });

it('reuses opened PDFs and keeps different files with the same name separate', () => {
    openPdf(file('first'));
    openPdf({ ...file('second'), name: 'first.pdf' });
    openPdf({ ...file('first'), originalPdf: 'data:application/pdf;base64,JVBERg==' });
    const state = uiStore.getSnapshot();
    expect(state.pdfTabs.map((tab) => tab.id)).toEqual(['first', 'second']);
    expect(state.pdf.id).toBe('first');
    expect(state.pdf.originalPdf).toBe('data:application/pdf;base64,JVBERg==');
    expect(state.pdfTabs[0]).toBe(state.pdf);
});
it('closes inactive tabs without switching and selects a neighboring file when closing the active one', () => {
    ['first', 'second', 'third'].forEach((id) => openPdf(file(id)));
    closePdfTab('first');
    expect(uiStore.getSnapshot().pdf.id).toBe('third');
    closePdfTab('third');
    expect(uiStore.getSnapshot().pdf.id).toBe('second');
    closePdfTab('second');
    expect(uiStore.getSnapshot().pdf).toBeNull();
    expect(uiStore.getSnapshot().pdfTabs).toEqual([]);
});
it('identifies legacy PDFs without stored IDs and clears all tabs when leaving the preview', () => {
    const legacy = { name: 'legacy.pdf', text: 'Original text', size: 20 };
    openPdf(legacy);
    const id = uiStore.getSnapshot().pdf.id;
    openPdf({ ...legacy });
    expect(uiStore.getSnapshot().pdfTabs).toHaveLength(1);
    expect(uiStore.getSnapshot().pdf.id).toBe(id);
    openPdf({ ...legacy, text: 'Different text' });
    expect(uiStore.getSnapshot().pdfTabs).toHaveLength(2);
    closePdf();
    expect(uiStore.getSnapshot().pdfTabs).toEqual([]);
    expect(uiStore.getSnapshot().pdf).toBeNull();
});
