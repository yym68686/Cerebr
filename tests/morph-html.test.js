import { expect, it } from 'vitest';
import { morphHtml, resetMorphState } from '../src/render/message/morph-html.js';

function host() {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
}

// morphHtml 的契约只有一条：结果必须和 innerHTML = html 完全一致。
// 它保留未变化的顶层节点只是手段，不是可观察行为。
it('matches innerHTML after every step of an append-only stream', () => {
    const sources = [
        '# 标题\n\n段落一\n\n- a\n- b\n\n```js\nconst x = 1;\n```\n\n最后一段。',
        '普通文本，没有块级结构，只是不断变长的一句话。',
        '| 列 | 值 |\n|---|---|\n| a | 1 |\n| b | 2 |\n\n> 引用\n',
        '- 外层\n  - 内层 A\n  - 内层 B\n\n段落\n',
    ];
    for (const source of sources) {
        const morphed = host();
        const reference = host();
        for (let end = 1; end <= source.length; end++) {
            // 用简单的块切分代替真实 markdown 渲染：这里要验证的是 morph，不是 marked。
            const html = source
                .slice(0, end)
                .split('\n\n')
                .filter(Boolean)
                .map((block) => `<p>${block.replace(/</g, '&lt;')}</p>`)
                .join('');
            morphHtml(morphed, html);
            reference.innerHTML = html;
            expect(morphed.innerHTML).toBe(reference.innerHTML);
        }
    }
});

it('keeps morphing when a post-processor only touched attributes or interiors', () => {
    // Markup 的真实顺序是：useLayoutEffect 里 morphHtml 写基线，useEffect 里 enhanceCodeBlocks
    // 给每个 <pre> 加 class、renderMathInElement 往块里插 mjx-container —— 都在基线之后。
    // 基线要是按 outerHTML 记，这些改写会让之后每一帧都判定“DOM 被外部动过”而退回整块替换，
    // 也就是带代码块的消息（最常见的情况）根本吃不到增量。所以基线只认顶层节点身份。
    const el = host();
    morphHtml(el, '<pre>code</pre><p>tail</p>');
    const pre = el.querySelector('pre');
    pre.classList.add('code-copy-on-label');
    pre.setAttribute('data-language', 'js');
    el.querySelector('p').appendChild(document.createElement('mjx-container'));

    morphHtml(el, '<pre>code</pre><p>tail</p><p>新</p>');

    expect(el.querySelector('pre')).toBe(pre);
    expect(pre.classList.contains('code-copy-on-label')).toBe(true);
    // 已经排版好的公式也留在原地，不会每帧被抹掉重新 typeset。
    expect(el.querySelectorAll('mjx-container')).toHaveLength(1);
    expect(el.children).toHaveLength(3);
    expect(el.lastElementChild.textContent).toBe('新');
});

it('drops stale renderer output when the block itself changed', () => {
    // 反过来：块的 markdown 变了，就必须按新 HTML 重建，不能留着上一帧的 mjx-container。
    const el = host();
    morphHtml(el, '<p>$x$</p>');
    el.querySelector('p').appendChild(document.createElement('mjx-container'));
    morphHtml(el, '<p>$x+1$</p>');
    expect(el.innerHTML).toBe('<p>$x+1$</p>');
});

it('rebuilds from scratch when another renderer restructured the top level', () => {
    // mermaid 会把 .mermaid 搬进缩放容器，顶层节点就不是我们留下的那批了。
    // 这时候增量的基线彻底失效，只能整块替换，不能错位拼接。
    const moved = host();
    morphHtml(moved, '<p>x</p><div class="mermaid">g</div>');
    const wrapper = document.createElement('div');
    const diagram = moved.querySelector('.mermaid');
    moved.insertBefore(wrapper, diagram);
    wrapper.appendChild(diagram);
    morphHtml(moved, '<p>x</p><div class="mermaid">g</div><p>y</p>');
    expect(moved.innerHTML).toBe('<p>x</p><div class="mermaid">g</div><p>y</p>');
});

it('handles shrinking, mid-content edits and clearing', () => {
    const el = host();
    morphHtml(el, '<p>a</p><p>b</p><p>c</p>');
    morphHtml(el, '<p>a</p><p>B</p>');
    expect(el.innerHTML).toBe('<p>a</p><p>B</p>');
    morphHtml(el, '');
    expect(el.innerHTML).toBe('');
});

it('preserves untouched nodes so per-node state survives streaming', () => {
    // 复制按钮的 hover 状态、计时器都存在 WeakMap 里，按 <pre> 节点索引。
    // 如果 morph 把没变的节点也重建了，这些状态每 100ms 就会丢一次。
    const el = host();
    morphHtml(el, '<pre>one</pre><p>tail</p>');
    const pre = el.querySelector('pre');
    morphHtml(el, '<pre>one</pre><p>tail longer</p>');
    expect(el.querySelector('pre')).toBe(pre);
});

it('reports exactly the blocks it rebuilt', () => {
    // Markup 靠这个返回值把 MathJax / enhanceCodeBlocks 限制在变化的块上。
    // 多报会白排版，少报会漏排版，所以这里逐种情况钉住。
    const el = host();

    // 首次是整块替换：全部节点都算新建。
    expect(morphHtml(el, '<p>a</p><p>b</p>')).toHaveLength(2);

    // 纯追加：只报新增的那个。
    const appended = morphHtml(el, '<p>a</p><p>b</p><p>c</p>');
    expect(appended).toHaveLength(1);
    expect(appended[0].textContent).toBe('c');

    // 流式的典型形态：最后一个块在变长，它和后面新增的一起重建，前缀不动。
    const grown = morphHtml(el, '<p>a</p><p>b</p><p>c 变长</p><p>d</p>');
    expect(grown.map((n) => n.textContent)).toEqual(['c 变长', 'd']);

    // 完全没变：不报任何块，调用方据此整个跳过后处理。
    expect(morphHtml(el, '<p>a</p><p>b</p><p>c 变长</p><p>d</p>')).toHaveLength(0);

    // 顶层被外部重构后退回整块替换，这时所有节点都是新的。
    el.insertBefore(document.createElement('span'), el.firstChild);
    expect(morphHtml(el, '<p>a</p><p>b</p>')).toHaveLength(2);
});

it('resetMorphState forces a full rebuild', () => {
    const el = host();
    morphHtml(el, '<p>a</p>');
    const first = el.querySelector('p');
    resetMorphState(el);
    morphHtml(el, '<p>a</p>');
    expect(el.querySelector('p')).not.toBe(first);
});
