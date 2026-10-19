const elementOf = (node) => (node?.nodeType === 1 ? node : node?.parentElement);
export function readTextSelection(scope = document.body, excludeChat = false) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const start = elementOf(range.startContainer),
        end = elementOf(range.endContainer);
    if (excludeChat && (start?.closest('#chat-container') || end?.closest('#chat-container'))) return null;
    if (!scope?.contains(start) || !scope.contains(end)) return null;
    if (
        [start, end].some((el) =>
            el?.closest(
                'input,textarea,[contenteditable]:not([contenteditable="false"]),[data-selection-actions],button,select'
            )
        )
    )
        return null;
    const text = selection.toString().trim();
    if (!text) return null;
    const rects = range.getClientRects?.();
    const rect = rects?.length ? rects[rects.length - 1] : range.getBoundingClientRect?.();
    if (!rect || (!rect.width && !rect.height)) return null;
    const bounds = range.getBoundingClientRect?.() || rect;
    return {
        text,
        centerX: (bounds.left + bounds.right) / 2,
        rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
    };
}
// Wait until the gesture has ended and the range has settled. A menu must not
// chase every intermediate character while the user is dragging a selection.
const SELECTION_SETTLE_MS = 160;
export function watchTextSelection({ scope = () => document.body, toolbar, onChange, excludeChat = false }) {
    let frame = 0;
    let settleTimer = 0;
    let selecting = false;
    let visible = false;
    let interacting = false;
    const focusedInside = () => {
        const root = toolbar?.();
        const active = root?.getRootNode()?.activeElement || document.activeElement;
        return root?.contains(active);
    };
    const cancelPending = () => {
        cancelAnimationFrame(frame);
        clearTimeout(settleTimer);
        frame = settleTimer = 0;
    };
    const hide = () => {
        if (visible) onChange(null);
        visible = false;
    };
    const update = () => {
        frame = 0;
        if (selecting || focusedInside()) return;
        const next = readTextSelection(scope(), excludeChat);
        // Editing/saving an action can collapse the browser selection and remove
        // its focused field. Keep the captured passage until dismissal.
        if (!next && interacting && toolbar?.()) return;
        visible = !!next;
        onChange(next);
    };
    const settle = () => {
        if (focusedInside() || (interacting && toolbar?.())) return;
        cancelPending();
        hide();
        if (selecting) return;
        settleTimer = setTimeout(() => {
            settleTimer = 0;
            frame = requestAnimationFrame(update);
        }, SELECTION_SETTLE_MS);
    };
    const reposition = () => {
        // Scrolling/reflow can track an already visible bar, but cannot reveal
        // it during a drag or bypass the pending settle delay.
        if (visible && !selecting && !settleTimer && !frame) frame = requestAnimationFrame(update);
    };
    const pointer = (event) => {
        if (event.isPrimary === false) return;
        cancelPending();
        const path = event.composedPath();
        const root = toolbar?.();
        if (root && (path.includes(root) || path.includes(root.getRootNode()?.host))) {
            interacting = true;
            return;
        }
        interacting = false;
        selecting = true;
        hide();
    };
    const release = (event) => {
        if (event.isPrimary === false) return;
        selecting = false;
        settle();
    };
    const cancelGesture = () => {
        selecting = false;
        cancelPending();
        if (!interacting) hide();
    };
    document.addEventListener('selectionchange', settle);
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', cancelGesture, true);
    window.addEventListener('blur', cancelGesture);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
        cancelPending();
        document.removeEventListener('selectionchange', settle);
        document.removeEventListener('pointerdown', pointer, true);
        document.removeEventListener('pointerup', release, true);
        document.removeEventListener('pointercancel', cancelGesture, true);
        window.removeEventListener('blur', cancelGesture);
        window.removeEventListener('resize', reposition);
        window.removeEventListener('scroll', reposition, true);
    };
}
