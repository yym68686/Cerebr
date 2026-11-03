import { uiStore } from './ui-store.js';

const sameFile = (a, b) =>
    a.id && b.id
        ? a.id === b.id
        : a.name === b.name && a.size === b.size && a.text === b.text && a.originalPdf === b.originalPdf;

export function openPdf(file) {
    uiStore.set((state) => {
        const tabs = state.pdfTabs;
        const existing = tabs.find((tab) => sameFile(tab, file));
        const next = { ...file, id: existing?.id || file.id || crypto.randomUUID() };
        return {
            ...state,
            pdf: next,
            pdfTabs: existing ? tabs.map((tab) => (tab === existing ? next : tab)) : [...tabs, next],
        };
    });
}

export function closePdfTab(id) {
    uiStore.set((state) => {
        const index = state.pdfTabs.findIndex((tab) => tab.id === id);
        if (index < 0) return state;
        const tabs = state.pdfTabs.filter((tab) => tab.id !== id);
        return {
            ...state,
            pdfTabs: tabs,
            pdf: state.pdf?.id === id ? tabs[Math.min(index, tabs.length - 1)] || null : state.pdf,
        };
    });
}

export const closePdf = () => uiStore.set({ pdf: null, pdfTabs: [] });
