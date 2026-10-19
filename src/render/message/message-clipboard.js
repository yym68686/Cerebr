export function getMathSource(container) {
    if (!container) return '';
    const tex =
        container.getAttribute('data-tex') ||
        container.querySelector('script[type^="math/tex"]')?.textContent;
    if (tex) return tex.trim();
    try {
        const item = window.MathJax?.startup?.document?.getMathItemsWithin(container)?.[0];
        if (item?.math) return item.math;
    } catch {
        /* MathJax may still be typesetting this formula. */
    }
    for (const node of [
        container.querySelector('mjx-math'),
        container.querySelector('mjx-assistive-mml'),
        container,
    ]) {
        const label = node?.getAttribute('aria-label');
        if (label) return label.replace(/^TeX:\s*/, '').trim();
    }
    return (container.textContent || '').trim();
}

export function copyChatSelection(event) {
    const selection = window.getSelection();
    const root = event.currentTarget;
    if (!event.clipboardData || !selection?.rangeCount || !selection.toString().trim()) return;
    if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return;
    const copy = document.createElement('div');
    copy.append(selection.getRangeAt(0).cloneContents());
    copy.querySelectorAll('mjx-container').forEach((container) => {
        const math = container.querySelector('mjx-assistive-mml math');
        if (math) container.replaceWith(math.cloneNode(true));
    });
    event.preventDefault();
    event.clipboardData.setData('text/html', copy.innerHTML);
    event.clipboardData.setData('text/plain', copy.textContent);
}

export async function copyMessageImage(url) {
    const png = (async () => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (blob.type === 'image/png') return blob;
        const bitmap = await createImageBitmap(blob);
        try {
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            canvas.getContext('2d').drawImage(bitmap, 0, 0);
            return await new Promise((resolve, reject) =>
                canvas.toBlob(
                    (value) => (value ? resolve(value) : reject(new Error('Unable to copy image'))),
                    'image/png'
                )
            );
        } finally {
            bitmap.close();
        }
    })();
    // Start the clipboard write during the user gesture, including Safari.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
