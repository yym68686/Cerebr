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
