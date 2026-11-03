const editable = (element) => element?.closest?.('input,textarea,[contenteditable="true"],[role="textbox"]');
export function selectChatContents(container) {
    if (!container) return false;
    const range = document.createRange();
    range.selectNodeContents(container);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
}
export function attachChatSelectAll(container, isChatVisible) {
    const select = () => {
        if (!isChatVisible() || editable(document.activeElement)) return false;
        const preview = document.querySelector('.pdf-preview-body');
        const selection = window.getSelection();
        if (preview && (preview.contains(document.activeElement) || preview.contains(selection?.anchorNode)))
            return selectChatContents(preview);
        return selectChatContents(container);
    };
    const key = (event) => {
        if (
            (event.metaKey || event.ctrlKey) &&
            !event.shiftKey &&
            !event.altKey &&
            event.key.toLowerCase() === 'a' &&
            select()
        ) {
            event.preventDefault();
            event.stopPropagation();
        }
    };
    document.addEventListener('keydown', key, true);
    const off = globalThis.cerebrDesktop?.onSelectAll?.(() => {
        if (!select()) document.execCommand('selectAll');
    });
    return () => {
        document.removeEventListener('keydown', key, true);
        off?.();
    };
}
