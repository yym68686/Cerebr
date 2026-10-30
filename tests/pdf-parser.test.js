// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { extractPdfText } from '../src/runtime/input/pdf-parser.js';
import { PDF_MAX_BYTES, PDF_MAX_PAGES } from '../src/runtime/input/pdf-limits.js';
import { makePdf } from './pdf-fixture.js';

afterEach(() => vi.unstubAllGlobals());

it('extracts real PDF text in page order with line and page boundaries', async () => {
    await expect(extractPdfText(makePdf())).resolves.toBe('First line\nSecond line\n\nNext page');
});

it('extracts embedded Unicode CJK text without rendering or evaluating document scripts', async () => {
    await expect(
        extractPdfText(makePdf({ cjk: true, script: true, pages: ['你好世界\n繁體中文', '第二页'] }))
    ).resolves.toBe('你好世界\n繁體中文\n\n第二页');
    expect(globalThis.__pdfExecuted).toBeUndefined();
});

it('resolves predefined Chinese CMaps exclusively from the bundled local assets', async () => {
    const base = 'https://fixture.invalid/lib/pdfjs/';
    const fetch = vi.fn(async (url) => {
        expect(url).toMatch(/^https:\/\/fixture\.invalid\/lib\/pdfjs\/(cmaps|standard_fonts)\/[\w.-]+$/);
        const name = url.slice(base.length);
        return new Response(await readFile(new URL(`../node_modules/pdfjs-dist/${name}`, import.meta.url)));
    });
    vi.stubGlobal('fetch', fetch);
    await expect(
        extractPdfText(makePdf({ cmap: true, pages: ['中文测试'] }), { assetBase: base })
    ).resolves.toBe('中文测试');
    expect(fetch).toHaveBeenCalled();
});

it('rejects blank, damaged, mislabeled and password-protected PDFs', async () => {
    await expect(extractPdfText(makePdf({ pages: [''] }))).rejects.toThrow('pdf_empty');
    await expect(extractPdfText(new TextEncoder().encode('not PDF').buffer)).rejects.toThrow('pdf_invalid');
    await expect(extractPdfText(new TextEncoder().encode('%PDF-1.7\ntruncated').buffer)).rejects.toThrow(
        'pdf_invalid'
    );
    await expect(extractPdfText(makePdf({ encrypted: true }))).rejects.toThrow('pdf_password');
});

it('enforces file and page limits', async () => {
    await expect(extractPdfText(new ArrayBuffer(PDF_MAX_BYTES + 1))).rejects.toThrow('pdf_too_large');
    await expect(extractPdfText(makePdf({ pages: Array(PDF_MAX_PAGES + 1).fill('x') }))).rejects.toThrow(
        'pdf_too_many_pages'
    );
});

it('extracts more than 200,000 characters across pages without truncation', async () => {
    const pages = Array.from({ length: 160 }, (_, i) =>
        [`Page ${i + 1}`, ...Array(20).fill('x'.repeat(80))].join('\n')
    );
    const expected = pages.join('\n\n');
    expect(expected.length).toBeGreaterThan(200_000);
    const text = await extractPdfText(makePdf({ pages }));
    expect(text.length).toBe(expected.length);
    expect(text === expected).toBe(true);
});
