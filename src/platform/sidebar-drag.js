import { isExtensionEnvironment } from '../utils/storage-adapter.js';
export function attachSidebarDrag(chatContainer) {
    const controller = new AbortController();
    const listen = (target, type, handler, options = {}) =>
        target.addEventListener(type, handler, { ...options, signal: controller.signal });
    // 仅扩展环境支持侧边栏 iframe 拖动（Web 版即使被嵌入也不启用）
    if (!isExtensionEnvironment) return;
    // 仅在被嵌入（扩展侧边栏 iframe）时启用
    if (window.top === window) return;
    if (!chatContainer) return;

    try {
        document.documentElement?.classList?.add('cerebr-extension-sidebar-iframe');
    } catch {
        // ignore
    }

    const DRAG_THRESHOLD_PX = 4;
    let activePointerId = null;
    let startScreenX = 0;
    let startScreenY = 0;
    let lastScreenX = 0;
    let lastScreenY = 0;
    let dragging = false;
    let suppressClickUntil = 0;

    const canStartDragFromTarget = (target) => {
        const el = target instanceof Element ? target : target?.parentElement;
        if (!el) return false;
        if (el.closest('.message')) return false;
        if (el.closest('#scroll-to-bottom')) return false;
        if (el.closest('#settings-button, #settings-menu, #context-menu, a, button, input, textarea, select'))
            return false;
        return true;
    };

    const postToParent = (payload) => {
        try {
            window.parent?.postMessage?.(payload, '*');
        } catch {
            // ignore
        }
    };

    const endDrag = () => {
        if (activePointerId === null) return;
        if (dragging) {
            postToParent({ type: 'CEREBR_SIDEBAR_DRAG_END' });
        }
        activePointerId = null;
        dragging = false;
    };

    listen(
        chatContainer,
        'pointerdown',
        (e) => {
            if (e.pointerType && e.pointerType !== 'mouse') return;
            if (e.button !== 0) return;
            if (!canStartDragFromTarget(e.target)) return;

            activePointerId = e.pointerId;
            // 用 screenX/screenY：拖动窗口本身会改变 iframe 的 clientX 坐标系，导致反馈抖动
            startScreenX = e.screenX;
            startScreenY = e.screenY;
            lastScreenX = startScreenX;
            lastScreenY = startScreenY;
            dragging = false;

            try {
                chatContainer.setPointerCapture(activePointerId);
            } catch {
                // ignore
            }
        },
        { passive: true }
    );

    listen(
        chatContainer,
        'pointermove',
        (e) => {
            if (activePointerId === null || e.pointerId !== activePointerId) return;
            const totalDx = e.screenX - startScreenX;
            const totalDy = e.screenY - startScreenY;

            if (!dragging) {
                if (Math.hypot(totalDx, totalDy) < DRAG_THRESHOLD_PX) return;
                dragging = true;
                suppressClickUntil = Date.now() + 400;
                postToParent({ type: 'CEREBR_SIDEBAR_DRAG_START' });
            }

            const dx = e.screenX - lastScreenX;
            const dy = e.screenY - lastScreenY;
            lastScreenX = e.screenX;
            lastScreenY = e.screenY;

            if (dx || dy) {
                postToParent({ type: 'CEREBR_SIDEBAR_DRAG_MOVE', dx, dy });
            }

            e.preventDefault();
        },
        { passive: false }
    );

    listen(
        chatContainer,
        'pointerup',
        (e) => {
            if (activePointerId === null || e.pointerId !== activePointerId) return;
            endDrag();
        },
        { passive: true }
    );

    listen(
        chatContainer,
        'pointercancel',
        (e) => {
            if (activePointerId === null || e.pointerId !== activePointerId) return;
            endDrag();
        },
        { passive: true }
    );

    // 拖动结束时抑制一次“点击聚焦输入框”等副作用
    listen(
        chatContainer,
        'click',
        (e) => {
            if (Date.now() < suppressClickUntil) {
                e.preventDefault();
                e.stopPropagation();
            }
        },
        { capture: true }
    );

    return () => {
        endDrag();
        controller.abort();
        document.documentElement.classList.remove('cerebr-extension-sidebar-iframe');
    };
}
