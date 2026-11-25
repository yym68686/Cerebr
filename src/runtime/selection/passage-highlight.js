import { getMathInRange } from '../../render/message/math-selection.js';

let nextHighlight = 0;
const PASSAGE = 'data-cerebr-math-passage';
const BACKGROUND = 'rgba(80, 140, 205, .38)';

// Focusing the follow-up input replaces the native selection. Paint the saved
// Range without wrapping or changing the source text (including page content).
export function highlightPassage(range, mathRoot) {
    const owner = range?.startContainer?.ownerDocument;
    const view = owner?.defaultView;
    const highlights = view?.Highlight && view.CSS?.highlights;
    const formulas = getMathInRange(range, mathRoot);
    if (!highlights && !formulas.size) return;
    const name = `cerebr-selection-passage-${++nextHighlight}`;
    // CSS highlights paint text, but MathJax draws its glyphs with pseudo-elements.
    for (const math of formulas) math.setAttribute(PASSAGE, name);
    const style = owner.createElement('style');
    style.textContent = [
        highlights && `::highlight(${name}) { background-color: ${BACKGROUND}; color: inherit; }`,
        formulas.size && `mjx-container[${PASSAGE}="${name}"] > mjx-math { background-color: ${BACKGROUND}; }`,
    ].filter(Boolean).join('\n');
    owner.head.append(style);
    highlights?.set(name, new view.Highlight(range));
    return () => {
        highlights?.delete(name);
        style.remove();
        for (const math of formulas) {
            if (math.getAttribute(PASSAGE) === name) math.removeAttribute(PASSAGE);
        }
    };
}
