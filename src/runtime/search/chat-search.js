// Search rendered message text without replacing React/Markdown nodes or selection.
export function findChatMatches(container, query) {
    if (!container || !query) return [];
    const needle = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'),
        matches = [];
    for (const root of container.querySelectorAll('.main-content, .message-quotes, .reasoning-text')) {
        if (root.closest('[hidden], [aria-hidden="true"]')) continue;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) =>
                node.parentElement.closest(
                    'button, script, style, [aria-hidden="true"], mjx-assistive-mml, .code-block-header'
                )
                    ? NodeFilter.FILTER_REJECT
                    : NodeFilter.FILTER_ACCEPT,
        });
        const nodes = [];
        let text = '',
            node;
        while ((node = walker.nextNode())) {
            nodes.push({ node, start: text.length, end: text.length + node.length });
            text += node.data;
        }
        let firstIndex = 0,
            lastIndex = 0;
        for (const match of text.matchAll(needle)) {
            const index = match.index,
                end = index + match[0].length;
            while (firstIndex < nodes.length && nodes[firstIndex].end <= index) firstIndex++;
            while (lastIndex < nodes.length && nodes[lastIndex].end < end) lastIndex++;
            const first = nodes[firstIndex],
                last = nodes[lastIndex];
            if (first && last) {
                const range = document.createRange();
                range.setStart(first.node, index - first.start);
                range.setEnd(last.node, end - last.start);
                matches.push(range);
            }
        }
    }
    return matches;
}
