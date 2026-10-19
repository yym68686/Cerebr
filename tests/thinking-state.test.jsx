import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/utils/i18n.js', () => ({ t: (key, values = []) => `${key} ${values.join(' ')}`.trim() }));
vi.mock('../htmd/latex.js', async (original) => ({
    ...(await original()),
    renderMathInElement: vi.fn(async () => {}),
    requestMermaidRender: vi.fn(),
}));
import { Message } from '../src/app/components/Messages.jsx';
import { renderMathInElement } from '../htmd/latex.js';
import { prepareReasoningForExport } from '../src/render/message/reasoning-export.js';
import { isReplyTarget } from '../src/app/message-actions.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host, root;
const now = 1700000000000;
const reason =
    '**检查条件**\n\n- 保留列表\n- 保留 `行内代码`\n\n```js\nconst result = 42;\n```\n\n[来源](https://example.org)\n\n\\(x^2 + y^2\\)';
beforeAll(() => {
    const globals = {};
    for (const name of ['marked', 'highlight'])
        runInNewContext(readFileSync(`htmd/${name}.min.js`, 'utf8'), globals);
    vi.stubGlobal('marked', globals.marked);
    vi.stubGlobal('hljs', globals.hljs);
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.clearAllMocks();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
});
const render = async (props) =>
    act(async () =>
        root.render(<Message role="assistant" content="" index={1} onContext={() => {}} {...props} />)
    );
const advance = (ms) => act(async () => vi.advanceTimersByTimeAsync(ms));
it('shows a pixel grid and request-based elapsed time only while waiting, and removes it when stopped', async () => {
    await render({ updating: true, requestStartedAt: now - 1200 });
    expect(host.querySelectorAll('.thinking-pixel-grid > span')).toHaveLength(9);
    expect(host.querySelector('.typing-dot')).toBeNull();
    expect(host.querySelector('.thinking-elapsed').textContent).toBe('thinking_elapsed_seconds 1.2');
    await advance(1000);
    expect(host.querySelector('.thinking-elapsed').textContent).toBe('thinking_elapsed_seconds 2.2');
    await render({ updating: false });
    expect(host.querySelector('.thinking-loader')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
});
it('preserves Markdown, code and math processing as reasoning streams, then auto-collapses for the answer', async () => {
    await render({ updating: true, requestStartedAt: now - 800, reasoning_content: reason });
    const toggle = host.querySelector('.reasoning-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.thinking-loader')).toBeNull();
    expect(host.querySelector('.reasoning-text strong').textContent).toBe('检查条件');
    expect(host.querySelectorAll('.reasoning-text li')).toHaveLength(2);
    expect(host.querySelector('.reasoning-text pre code').textContent.trim()).toBe('const result = 42;');
    expect(host.querySelector('.reasoning-text a').getAttribute('href')).toBe('https://example.org');
    expect(renderMathInElement).toHaveBeenCalled();
    await act(async () => host.querySelector('.reasoning-text strong').click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await render({
        updating: true,
        requestStartedAt: now - 800,
        reasoning_content: reason + '\n\n**新的段落**',
    });
    expect(host.querySelector('.reasoning-text').textContent).toContain('新的段落');
    await render({ updating: true, content: '最终回答', reasoning_content: reason });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.reasoning-content').hasAttribute('inert')).toBe(true);
    expect(host.querySelector('.main-content').textContent.trim()).toBe('最终回答');
    expect(vi.getTimerCount()).toBe(0);
});
it('respects manual expansion through completion and freezes elapsed time instead of including answer generation', async () => {
    await render({ updating: true, requestStartedAt: now, reasoning_content: reason });
    await advance(2300);
    const toggle = host.querySelector('.reasoning-toggle');
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle.click());
    await render({ updating: true, requestStartedAt: now, content: '回答', reasoning_content: reason });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const finished = host.querySelector('.thinking-elapsed').textContent;
    await advance(9000);
    await render({ updating: false, content: '完整回答', reasoning_content: reason });
    expect(host.querySelector('.thinking-elapsed').textContent).toBe(finished);
    expect(finished).toBe('thinking_elapsed_seconds 2.3');
});
it('opens saved reasoning without inventing elapsed time and exports it as an independently usable disclosure', async () => {
    await render({ content: 'Answer', reasoning_content: reason });
    expect(host.querySelector('.thinking-elapsed')).toBeNull();
    const toggle = host.querySelector('.reasoning-toggle');
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle.click());
    expect(host.querySelector('.reasoning-content').getAttribute('aria-hidden')).toBe('false');
    const clone = host.cloneNode(true);
    prepareReasoningForExport(clone);
    expect(clone.querySelector('details').open).toBe(true);
    expect(clone.querySelector('summary').textContent).toContain('label_reasoning_process');
    expect(clone.querySelector('.reasoning-content')).toBeNull();
    expect(clone.querySelector('[inert]')).toBeNull();
    expect(clone.querySelector('details strong').textContent).toBe('检查条件');
    expect(host.querySelector('details')).toBeNull();
});
it('does not export a transient loader', async () => {
    await render({ updating: true, requestStartedAt: now });
    const clone = host.cloneNode(true);
    prepareReasoningForExport(clone);
    expect(clone.querySelector('.thinking-loader')).toBeNull();
});
it('targets the waiting placeholder rather than the previous completed assistant answer', () => {
    const chat = { id: 'a', messages: [{ role: 'user' }, { role: 'assistant', content: 'previous reply' }] };
    expect(isReplyTarget(chat, 1, { phase: 'thinking', requestChatId: 'a' })).toBe(false);
    expect(isReplyTarget(chat, 2, { phase: 'thinking', requestChatId: 'a' })).toBe(true);
    expect(isReplyTarget(chat, 1, { phase: 'replying', requestChatId: 'a' })).toBe(true);
});
