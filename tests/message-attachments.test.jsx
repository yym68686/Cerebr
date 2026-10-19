import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../htmd/latex.js', () => ({
    ensureMarkdownReady: async () => {},
    isMarkdownReady: () => true,
    processMathAndMarkdown: (text) => `<p>${text}</p>`,
    renderMathInElement: async () => {},
    requestMermaidRender: () => {},
    textMayContainMath: () => false,
}));
vi.mock('../src/utils/i18n.js', () => ({ t: (key, values = []) => `${key} ${values.join(' ')}`.trim() }));
import { Message } from '../src/app/components/Messages.jsx';
import { WebpageIcon } from '../src/app/components/WebpageIcon.jsx';
import { uiStore } from '../src/app/state/ui-store.js';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, host, context;
const images = [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,Ag==' } },
];
beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    context = vi.fn();
    uiStore.set({ image: null });
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
});
const render = async (content, role = 'user') =>
    act(async () => root.render(<Message content={content} role={role} index={3} onContext={context} />));
it('places sent images above the text with preview and context actions, without direct removal controls', async () => {
    await render([images[0], { type: 'text', text: '请分析这些图片' }, images[1]]);
    const message = host.querySelector('.message');
    expect(message.firstElementChild.className).toBe('message-attachments');
    expect(message.lastElementChild.className).toBe('main-content');
    expect(message.querySelector('.main-content img')).toBeNull();
    expect(message.querySelector('.main-content').textContent).toBe('请分析这些图片');
    expect(message.dataset.originalText).toBe('请分析这些图片');
    await act(async () => host.querySelectorAll('.message-attachment-preview')[1].click());
    expect(uiStore.getSnapshot().image).toBe(images[1].image_url.url);
    expect(
        [...message.querySelectorAll('.message-attachments button')].every((button) =>
            button.classList.contains('message-attachment-preview')
        )
    ).toBe(true);
    expect(message.querySelectorAll('.message-attachments button')).toHaveLength(2);
    await act(async () =>
        host.querySelector('img').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    );
    expect(context).toHaveBeenCalledWith(expect.anything(), 3);
});
it('renders image-only messages without an empty bubble and keeps text-only messages unchanged', async () => {
    await render(images);
    expect(host.querySelectorAll('.message-attachment')).toHaveLength(2);
    expect(host.querySelectorAll('.message-attachments button')).toHaveLength(2);
    expect(host.querySelector('.main-content')).toBeNull();
    await render('普通文字');
    expect(host.querySelector('.has-attachments')).toBeNull();
    expect(host.querySelector('.main-content').textContent).toBe('普通文字');
});
it('keeps assistant attachments and text in the assistant layout', async () => {
    await render([{ type: 'text', text: '图像结果' }, images[0]], 'assistant');
    expect(host.querySelector('.ai-message .message-attachments')).not.toBeNull();
    expect(host.querySelectorAll('.message-attachments button')).toHaveLength(1);
    expect(host.querySelector('.user-message')).toBeNull();
});
it('uses the webpage favicon and falls back only after an error or a missing URL', async () => {
    await act(async () => root.render(<WebpageIcon tab={{ favIconUrl: 'https://site.test/icon.png' }} />));
    expect(host.querySelector('img').getAttribute('src')).toBe('https://site.test/icon.png');
    await act(async () => host.querySelector('img').dispatchEvent(new Event('error')));
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('svg')).not.toBeNull();
    await act(async () => root.render(<WebpageIcon tab={{ favIconUrl: 'https://next.test/icon.png' }} />));
    expect(host.querySelector('img').getAttribute('src')).toBe('https://next.test/icon.png');
    await act(async () => root.render(<WebpageIcon tab={{}} />));
    expect(host.querySelector('img')).toBeNull();
});
