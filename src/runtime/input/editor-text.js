// Walk the existing DOM once. Serializing innerHTML and parsing it into a new
// tree multiplies the cost of every draft read, especially with many lines.
export function readEditorText(input) {
    const parts = [];
    const walker = document.createTreeWalker(input, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            return node.nodeType === Node.ELEMENT_NODE &&
                (node.matches('.image-tag, [data-cerebr-caret-probe], script, style'))
                ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType === Node.TEXT_NODE) parts.push(node.data);
        else if (node.tagName === 'DIV') parts.push('\n');
        else if (node.tagName === 'BR' && !(node.parentNode !== input && node.parentNode.tagName === 'DIV' && node.parentNode.childNodes.length === 1))
            parts.push('\n');
    }
    return parts.join('').replace(/\u00a0/g, ' ');
}

function atEdge(input, node, offset, start) {
    if (!input.contains(node)) return false;
    if (node.nodeType === Node.TEXT_NODE) {
        // Chromium Select All excludes the terminal newline in a pre-wrap
        // text node. Treat that invisible line ending as part of the selection.
        if (start ? offset !== 0 : offset !== node.length && !/^[\r\n]*$/.test(node.data.slice(offset))) return false;
    } else if (offset !== (start ? 0 : node.childNodes.length)) return false;
    // Native Select All often ends inside text nodes rather than on the editor
    // element. These positions are visually equal but compareBoundaryPoints
    // reports them as different. Walk only the boundary ancestors/siblings.
    while (node !== input) {
        let sibling = start ? node.previousSibling : node.nextSibling;
        while (sibling) {
            const emptyText = sibling.nodeType === Node.TEXT_NODE &&
                (start ? !sibling.length : /^[\r\n]*$/.test(sibling.data));
            const trailingBreak = !start && sibling.nodeType === Node.ELEMENT_NODE && sibling.tagName === 'BR';
            if (!emptyText && !trailingBreak) return false;
            sibling = start ? sibling.previousSibling : sibling.nextSibling;
        }
        node = node.parentNode;
    }
    return true;
}

export function isFullEditorSelection(input, range) {
    return !!range && !range.collapsed &&
        atEdge(input, range.startContainer, range.startOffset, true) &&
        atEdge(input, range.endContainer, range.endOffset, false);
}

// Only determine whether the threshold is crossed; don't allocate the entire
// selected string or clone its DOM before deleting it.
export function hasLargeEditorContent(input, threshold = 10000) {
    const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT);
    let length = 0, nodes = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        length += node.length;
        if (length >= threshold || ++nodes >= 1000) return true;
    }
    return false;
}
