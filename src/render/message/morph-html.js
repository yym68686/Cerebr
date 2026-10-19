// 流式输出是纯追加：每 100ms 到一批 token，整条消息重新 parse 出的 HTML 里，除了最后一两个
// 顶层块，前面的内容和上一帧逐字节相同。但 dangerouslySetInnerHTML 每次都会把整棵子树拆掉重建，
// 于是「已经稳定的前缀」被反复重排——长回复下 DOM+layout 的成本比 parse 本身高一个量级
// （实测 15k 字符：parse 162ms，DOM 1177ms，且单帧涨到 4.67ms）。
//
// 这里按顶层子节点做最小改动：找出与上一帧相同的公共前缀，只重建从第一个变化处开始的部分。
// 实测 15k 字符 1135ms -> 279ms，最差单帧 11.2ms -> 2.8ms，最终 HTML 与整块替换逐字节一致。
//
// 只比较顶层、不做递归 diff 是故意的：流式追加几乎总是在最后一个块上发生，递归的复杂度和
// 出错面都不划算。
//
// 基线记两样东西：上一帧每个顶层块的「目标 HTML」，以及当时留在 DOM 里的节点引用。
// 关键是别去读实时 DOM 来判断「有没有被外部改过」——morph 写完之后，enhanceCodeBlocks 会给
// <pre> 加 class，MathJax 会往块里插 mjx-container，这些都是预期内的后处理。按 outerHTML
// 比会把它们全判成「外部改动」而退回整块替换，带代码块或公式的消息就彻底吃不到增量了。
// 所以只用节点身份确认 DOM 顶层结构还是我们留下的那批，块内部随后处理任意改写。
const morphState = new WeakMap();

function splitTopLevel(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const nodes = Array.from(template.content.childNodes);
    return {
        nodes,
        keys: nodes.map((node) =>
            node.nodeType === Node.ELEMENT_NODE
                ? `1\u0000${node.outerHTML}`
                : `${node.nodeType}\u0000${node.nodeValue ?? ''}`
        ),
    };
}

// 只确认顶层还是上一帧那批节点、顺序没变、也没人多塞或搬走节点。
// 块内部怎么被改写都不影响增量的正确性：变化的块本来就会整块重建。
function baselineMatchesDom(root, nodes) {
    if (nodes.length !== root.childNodes.length) return false;
    for (let i = 0; i < nodes.length; i++) {
        if (root.childNodes[i] !== nodes[i]) return false;
    }
    return true;
}

// 返回这次真正被重建的顶层节点。调用方据此把 MathJax 之类的后处理只作用在变化的块上，
// 而不是每帧重排整条消息。整块替换时返回全部节点。
export function morphHtml(root, html) {
    if (!root) return [];
    const state = morphState.get(root);
    const { nodes: nextNodes, keys: nextKeys } = splitTopLevel(html);

    // 没有上一帧记录，或者顶层结构被我们之外的代码动过（mermaid 渲染会把 .mermaid 容器整个
    // 搬进缩放层），就退回整块替换。
    if (!state || !baselineMatchesDom(root, state.nodes)) {
        root.innerHTML = html;
        const nodes = Array.from(root.childNodes);
        morphState.set(root, { keys: nextKeys, nodes });
        return nodes;
    }

    const prevKeys = state.keys;
    let common = 0;
    const max = Math.min(prevKeys.length, nextKeys.length);
    while (common < max && prevKeys[common] === nextKeys[common]) common++;
    if (common === prevKeys.length && common === nextKeys.length) return [];

    const existing = Array.from(root.childNodes);
    for (let i = existing.length - 1; i >= common; i--) existing[i].remove();
    if (common < nextNodes.length) {
        const fragment = document.createDocumentFragment();
        for (let i = common; i < nextNodes.length; i++) fragment.appendChild(nextNodes[i]);
        root.appendChild(fragment);
    }
    const nodes = Array.from(root.childNodes);
    morphState.set(root, { keys: nextKeys, nodes });
    return nodes.slice(common);
}

// 外部代码改写过 root 之后调用，让下一次 morph 重新同步基线。
export function resetMorphState(root) {
    if (root) morphState.delete(root);
}
