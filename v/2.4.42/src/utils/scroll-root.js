export function isKeyboardScrollMode() {
    return !!document.body?.classList?.contains('cerebr-keyboard-mode');
}

function getPageScrollRoot() {
    return document.scrollingElement || document.documentElement;
}

function getKeyboardScrollRoot() {
    const chatContainer = document.getElementById('chat-container');
    return chatContainer || getPageScrollRoot();
}

export function getScrollRoot() {
    return isKeyboardScrollMode() ? getKeyboardScrollRoot() : getPageScrollRoot();
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

    if (root === getPageScrollRoot()) {
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
        return;
    }

    // Keyboard mode: scroll inside #chat-container.
    if (behavior && behavior !== 'auto' && typeof root.scrollTo === 'function') {
        try {
            root.scrollTo({ top: nextTop, behavior });
            return;
        } catch {
            // ignore and fall back
        }
    }

    root.scrollTop = nextTop;
}

export function scrollByDelta(deltaY, behavior = 'auto') {
    const root = getScrollRoot();
    const current = root.scrollTop || 0;
    scrollToTop(current + deltaY, behavior);
}

export function addRootScrollListener(handler, options) {
    // Window scroll for page mode.
    window.addEventListener('scroll', handler, options);

    // #chat-container scroll for keyboard mode.
    const chatContainer = document.getElementById('chat-container');
    if (chatContainer) {
        chatContainer.addEventListener('scroll', handler, options);
    }
}

export function removeRootScrollListener(handler, options) {
    window.removeEventListener('scroll', handler, options);
    const chatContainer = document.getElementById('chat-container');
    if (chatContainer) {
        chatContainer.removeEventListener('scroll', handler, options);
    }
}
