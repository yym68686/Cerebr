export function getScrollRoot() {
    return document.scrollingElement || document.documentElement;
}

export function getScrollTop() {
    return getScrollRoot().scrollTop || 0;
}

export function getScrollHeight() {
    return getScrollRoot().scrollHeight || 0;
}

export function getClientHeight() {
    return getScrollRoot().clientHeight || 0;
}

export function scrollToTop(top, behavior = 'auto') {
    const root = getScrollRoot();
    const nextTop = Number.isFinite(top) ? top : 0;

    if (behavior && behavior !== 'auto' && typeof window.scrollTo === 'function') {
        try {
            window.scrollTo({ top: nextTop, behavior });
            return;
        } catch {
            // ignore and fall back
        }
    }

    if (typeof window.scrollTo === 'function') {
        window.scrollTo(0, nextTop);
        return;
    }

    root.scrollTop = nextTop;
}

export function scrollByDelta(deltaY, behavior = 'auto') {
    const root = getScrollRoot();
    const current = root.scrollTop || 0;
    scrollToTop(current + deltaY, behavior);
}

export function addRootScrollListener(handler, options) {
    window.addEventListener('scroll', handler, options);
}

export function removeRootScrollListener(handler, options) {
    window.removeEventListener('scroll', handler, options);
}
