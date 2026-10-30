import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/utils/i18n.js', () => ({ t: (key) => key }));
import { readPdf } from '../src/runtime/input/pdf-reader.js';
import { isPdf, PDF_MAX_BYTES, PDF_MAX_TEXT, PDF_TIMEOUT_MS } from '../src/runtime/input/pdf-limits.js';

let worker, workers, postingError;
beforeEach(() => {
    vi.useFakeTimers();
    workers = [];
    postingError = false;
    vi.stubGlobal(
        'Worker',
        class {
            constructor(url, options) {
                worker = this;
                workers.push(this);
                this.url = url;
                this.options = options;
            }
            postMessage = vi.fn(() => {
                if (postingError) throw new Error('Cannot clone file');
            });
            terminate = vi.fn();
        }
    );
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
const file = () => new File(['%PDF-1.7'], 'paper.pdf');
const result = (data) => worker.onmessage({ data: { type: 'cerebr:pdf-result', ...data } });

it('recognizes MIME and case-insensitive extensions', () => {
    for (const source of [{ name: 'PAPER.PDF' }, { name: 'paper', type: 'application/pdf' }])
        expect(isPdf(source)).toBe(true);
    for (const source of [{ name: 'paper.pdf.txt' }, { name: 'image.png', type: 'image/png' }])
        expect(isPdf(source)).toBe(false);
});
it('extracts off-thread with local resources and ignores PDF.js transport notifications', async () => {
    const source = file(),
        reading = readPdf(source);
    expect(worker.options).toEqual({ type: 'module' });
    expect(worker.postMessage).toHaveBeenCalledWith({
        file: source,
        assetBase: expect.stringMatching(/\/(?:lib\/pdfjs|node_modules\/pdfjs-dist)\/$/),
    });
    worker.onmessage({ data: { sourceName: 'worker', targetName: 'main', action: 'ready' } });
    expect(worker.terminate).not.toHaveBeenCalled();
    result({ text: 'First page\n\nSecond page' });
    await expect(reading).resolves.toBe('First page\n\nSecond page');
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
});
it.each(['pdf_invalid', 'pdf_password', 'pdf_empty', 'pdf_text_too_large', 'pdf_too_many_pages'])(
    'reports %s and terminates its worker',
    async (error) => {
        const rejected = expect(readPdf(file())).rejects.toThrow(error);
        result({ error });
        await rejected;
        expect(worker.terminate).toHaveBeenCalledOnce();
    }
);
it('terminates on timeout and abort, including a pre-aborted task', async () => {
    const timedOut = expect(readPdf(file())).rejects.toThrow('pdf_timeout');
    await vi.advanceTimersByTimeAsync(PDF_TIMEOUT_MS);
    await timedOut;
    expect(worker.terminate).toHaveBeenCalledOnce();
    const controller = new AbortController();
    const aborted = expect(readPdf(file(), { signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
    });
    controller.abort();
    await aborted;
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(readPdf(file(), { signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
    });
    expect(workers).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
});
it('rejects oversized files before reading and validates returned text', async () => {
    await expect(readPdf({ size: PDF_MAX_BYTES + 1 })).rejects.toThrow('pdf_too_large');
    expect(workers).toHaveLength(0);
    const oversized = expect(readPdf(file())).rejects.toThrow('pdf_text_too_large');
    result({ text: 'x'.repeat(PDF_MAX_TEXT + 1) });
    await oversized;
    const empty = expect(readPdf(file())).rejects.toThrow('pdf_empty');
    result({ text: '  ' });
    await empty;
    expect(workers.every((item) => item.terminate.mock.calls.length === 1)).toBe(true);
});
it.each(['error', 'messageerror', 'postMessage'])('cleans up on worker %s failures', async (failure) => {
    postingError = failure === 'postMessage';
    const reading = readPdf(file());
    const rejected = expect(reading).rejects.toThrow('pdf_invalid');
    if (failure === 'error') worker.onerror({ preventDefault: vi.fn() });
    else if (failure === 'messageerror') worker.onmessageerror();
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
});
