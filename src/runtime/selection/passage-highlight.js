let nextHighlight = 0;

// Focusing the follow-up input replaces the native selection. Paint the saved
// Range without wrapping or changing the source text (including page content).
export function highlightPassage(range) {
    const owner = range?.startContainer?.ownerDocument;
    const view = owner?.defaultView;
    if (!view?.CSS?.highlights || !view.Highlight) return () => {};
    const name = `cerebr-selection-passage-${++nextHighlight}`;
    const style = owner.createElement('style');
    style.textContent = `::highlight(${name}) { background-color: rgba(80, 140, 205, .38); color: inherit; }`;
    owner.head.append(style);
    view.CSS.highlights.set(name, new view.Highlight(range));
    return () => {
        view.CSS.highlights.delete(name);
        style.remove();
    };
}
