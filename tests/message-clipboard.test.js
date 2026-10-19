import { afterEach, expect, it, vi } from 'vitest';
import {
    copyChatSelection,
    getMathSource,
    copyMessageImage,
} from '../src/render/message/message-clipboard.js';
afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});
it('finds original TeX using MathJax or the original accessibility labels', () => {
    const math = document.createElement('mjx-container');
    math.innerHTML = '<mjx-math aria-label="TeX: \\frac{1}{2}"></mjx-math>';
    expect(getMathSource(math)).toBe('\\frac{1}{2}');
    vi.stubGlobal('MathJax', {
        startup: { document: { getMathItemsWithin: () => [{ math: '\\sqrt{x}' }] } },
    });
    expect(getMathSource(math)).toBe('\\sqrt{x}');
});
it('copies a selected formula once as clean MathML instead of duplicated visual and assistive text', () => {
    const root = document.createElement('div');
    root.innerHTML =
        '<p>Formula <mjx-container><mjx-math>visual</mjx-math><mjx-assistive-mml><math><mi>x</mi></math></mjx-assistive-mml></mjx-container></p>';
    document.body.append(root);
    const range = document.createRange();
    range.selectNodeContents(root);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const event = { currentTarget: root, preventDefault: vi.fn(), clipboardData: { setData: vi.fn() } };
    copyChatSelection(event);
    expect(event.clipboardData.setData).toHaveBeenCalledWith('text/plain', 'Formula x');
    expect(event.clipboardData.setData.mock.calls[0][1]).not.toContain('mjx-container');
});
it('starts image clipboard writing before the image fetch resolves', async () => {
    let finish;
    const body = new Blob(['png'], { type: 'image/png' });
    vi.stubGlobal(
        'fetch',
        vi.fn(
            () =>
                new Promise((resolve) => {
                    finish = () => resolve({ ok: true, blob: async () => body });
                })
        )
    );
    vi.stubGlobal(
        'ClipboardItem',
        class {
            constructor(parts) {
                this.parts = parts;
            }
        }
    );
    const write = vi.fn(async (items) => {
        expect(await items[0].parts['image/png']).toBe(body);
    });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } });
    const copying = copyMessageImage('https://example.invalid/image.png');
    expect(write).toHaveBeenCalledOnce();
    finish();
    await copying;
});
