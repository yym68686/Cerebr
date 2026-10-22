import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { findChatMatches } from '../src/runtime/search/chat-search.js';
import { ChatSearch } from '../src/app/components/ChatSearch.jsx';
vi.mock('../src/utils/i18n.js', () => ({ t: (key) => key }));
let root;
afterEach(async () => {
    if (root) await act(async () => root.unmount());
    root = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});
it('finds across bold spans, excludes toolbars/sidebar/editor and keeps original DOM intact', () => {
    document.body.innerHTML =
        '<aside>hello world</aside><div id="chat"><div class="main-content">hello <strong>world</strong><button>hello world</button></div><div class="main-content">Hello world</div><div hidden><div class="reasoning-text">hello world</div></div></div><input value="hello world" />';
    const container = document.querySelector('#chat'),
        before = container.innerHTML;
    const matches = findChatMatches(container, 'hello world');
    expect(matches.map((r) => r.toString())).toEqual(['hello world', 'Hello world']);
    expect(container.innerHTML).toBe(before);
    expect(findChatMatches(container, '[')).toEqual([]);
});
it('opens with Cmd/Ctrl+F, moves between matches, and cleans highlights on Escape', async () => {
    document.body.innerHTML =
        '<div id="chat"><div class="main-content">hello world hello</div></div><div id="root"></div>';
    const highlights = new Map();
    vi.stubGlobal('CSS', { highlights });
    vi.stubGlobal(
        'Highlight',
        class {
            constructor(...ranges) {
                this.ranges = ranges;
            }
        }
    );
    Range.prototype.getBoundingClientRect = () => ({
        top: 100,
        bottom: 120,
        left: 0,
        right: 30,
        width: 30,
        height: 20,
    });
    root = createRoot(document.querySelector('#root'));
    await act(async () =>
        root.render(
            <ChatSearch
                containerRef={{ current: document.querySelector('#chat') }}
                chatId="a"
                disabled={false}
            />
        )
    );
    const key = new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true });
    await act(async () => document.dispatchEvent(key));
    expect(key.defaultPrevented).toBe(true);
    const input = document.querySelector('.chat-find input');
    expect(document.activeElement).toBe(input);
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'hello');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.querySelector('.chat-find-count').textContent).toBe('1 / 2');
    expect(highlights.get('cerebr-search').ranges).toHaveLength(2);
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(document.querySelector('.chat-find-count').textContent).toBe('2 / 2');
    await act(async () =>
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    expect(document.querySelector('.chat-find')).toBeNull();
    expect(highlights.size).toBe(0);
});
