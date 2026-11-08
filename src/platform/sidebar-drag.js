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
        const pointerId = activePointerId;
        activePointerId = null;
        if (dragging) {
            suppressClickUntil = Date.now() + 400;
            postToParent({ type: 'CEREBR_SIDEBAR_DRAG_END' });
        }
        dragging = false;
        document.documentElement.classList.remove('cerebr-sidebar-dragging');
        try {
            if (chatContainer.hasPointerCapture(pointerId)) chatContainer.releasePointerCapture(pointerId);
        } catch {
            // The browser may have already released capture on pointerup/cancel.
        }
    };

    const moveDrag = (e) => postToParent({
        type: 'CEREBR_SIDEBAR_DRAG_MOVE', screenX: e.screenX, screenY: e.screenY,
    });

    listen(
        chatContainer,
        'pointerdown',
        (e) => {
            if (e.pointerType && e.pointerType !== 'mouse') return;
            if (e.button !== 0 || activePointerId !== null) return;
            if (!canStartDragFromTarget(e.target)) return;

            // Prevent the browser from starting a native text selection before
            // the drag threshold is reached. Message text remains selectable.
            e.preventDefault();
            activePointerId = e.pointerId;
            // 用 screenX/screenY：拖动窗口本身会改变 iframe 的 clientX 坐标系，导致反馈抖动
            startScreenX = e.screenX;
            startScreenY = e.screenY;
            dragging = false;

            try {
                chatContainer.setPointerCapture(activePointerId);
            } catch {
                // ignore
            }
        },
        { passive: false }
    );

    listen(
        chatContainer,
        'pointermove',
        (e) => {
            if (activePointerId === null || e.pointerId !== activePointerId) return;
            if (!(e.buttons & 1)) {
                endDrag();
                return;
            }
            const totalDx = e.screenX - startScreenX;
            const totalDy = e.screenY - startScreenY;

            if (!dragging) {
                if (Math.hypot(totalDx, totalDy) < DRAG_THRESHOLD_PX) return;
                dragging = true;
                document.documentElement.classList.add('cerebr-sidebar-dragging');
                postToParent({ type: 'CEREBR_SIDEBAR_DRAG_START', screenX: startScreenX, screenY: startScreenY });
            }

            moveDrag(e);

            e.preventDefault();
        },
        { passive: false }
    );

    listen(
        chatContainer,
        'pointerup',
        (e) => {
            if (activePointerId === null || e.pointerId !== activePointerId) return;
            if (dragging) moveDrag(e);
            endDrag();
        },
        { passive: true }
    );

    listen(chatContainer, 'lostpointercapture', (e) => {
        if (e.pointerId === activePointerId) endDrag();
    });
    listen(window, 'blur', endDrag);
    listen(window, 'message', (e) => {
        if (e.source === window.parent && e.data?.type === 'CEREBR_SIDEBAR_DRAG_CANCEL') endDrag();
    });
    for (const type of ['selectstart', 'dragstart']) {
        listen(document, type, (e) => {
            if (activePointerId !== null) e.preventDefault();
        }, { capture: true });
    }

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
            if (dragging || Date.now() < suppressClickUntil) {
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
