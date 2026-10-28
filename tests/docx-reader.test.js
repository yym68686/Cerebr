import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/utils/i18n.js', () => ({ t: (key) => key }));
import { readDocx } from '../src/runtime/input/docx-reader.js';
import { DOCX_MAX_BYTES, DOCX_MAX_TEXT, DOCX_TIMEOUT_MS } from '../src/runtime/input/docx-limits.js';
let worker;
beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
        'Worker',
        class {
            constructor(url, options) {
                worker = this;
                this.url = url;
                this.options = options;
            }
            postMessage = vi.fn();
            terminate = vi.fn();
        }
    );
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
const file = () => new File(['zip'], 'report.docx');

it('runs parsing off-thread and terminates the worker after successful extraction', async () => {
    const source = file(),
        reading = readDocx(source);
    expect(worker.options).toEqual({ type: 'module' });
    expect(worker.postMessage).toHaveBeenCalledWith(source);
    worker.onmessage({ data: { text: '# Report\n\nBody' } });
    await expect(reading).resolves.toBe('# Report\n\nBody');
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
});

it.each(['docx_invalid', 'docx_too_complex', 'docx_empty', 'docx_text_too_large'])(
    'reports %s and frees the worker',
    async (error) => {
        const reading = readDocx(file());
        const rejected = expect(reading).rejects.toThrow(error);
        worker.onmessage({ data: { error } });
        await rejected;
        expect(worker.terminate).toHaveBeenCalledOnce();
    }
);

it('terminates an unresponsive worker on timeout', async () => {
    const rejected = expect(readDocx(file())).rejects.toThrow('docx_timeout');
    await vi.advanceTimersByTimeAsync(DOCX_TIMEOUT_MS);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
});

it('terminates immediately on navigation cancellation and rejects pre-aborted tasks', async () => {
    const controller = new AbortController();
    const rejected = expect(readDocx(file(), { signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
    });
    controller.abort();
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await expect(readDocx(file(), { signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
    });
});

it('rejects oversized files before starting a worker and validates its returned text', async () => {
    await expect(readDocx({ size: DOCX_MAX_BYTES + 1 })).rejects.toThrow('docx_too_large');
    const rejected = expect(readDocx(file())).rejects.toThrow('docx_text_too_large');
    worker.onmessage({ data: { text: 'x'.repeat(DOCX_MAX_TEXT + 1) } });
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
});

it('handles worker loading and messaging errors without leaking workers', async () => {
    const rejected = expect(readDocx(file())).rejects.toThrow('docx_invalid');
    const preventDefault = vi.fn();
    worker.onerror({ preventDefault });
    await rejected;
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
});
