const MATH = 'mjx-container';
const SELECTED = 'data-cerebr-math-selected';

export function getSelectedMath(root, selection) {
    const selected = new Set();
    if (!selection || selection.isCollapsed) return selected;
    for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        if (range.collapsed) continue;
        const node = range.commonAncestorContainer;
        const ancestor = node.nodeType === 1 ? node : node.parentElement;
        const containingMath = ancestor?.closest(MATH);
        if (containingMath && root.contains(containingMath)) {
            selected.add(containingMath);
            continue;
        }
        // During a drag within one paragraph, don't walk the whole transcript.
        const scope = root.contains(ancestor) ? ancestor : ancestor?.contains(root) ? root : null;
        for (const math of scope?.querySelectorAll(MATH) || []) {
            if (range.intersectsNode(math)) selected.add(math);
        }
    }
    return selected;
}

export function attachMathSelection(root) {
    const doc = root.ownerDocument;
    let highlighted = new Set();
    const update = () => {
        const next = getSelectedMath(root, doc.getSelection());
        for (const math of highlighted) if (!next.has(math)) math.removeAttribute(SELECTED);
        for (const math of next) if (!highlighted.has(math)) math.setAttribute(SELECTED, '');
        highlighted = next;
    };
    doc.addEventListener('selectionchange', update);
    update();
    return () => {
        doc.removeEventListener('selectionchange', update);
        for (const math of highlighted) math.removeAttribute(SELECTED);
    };
}
