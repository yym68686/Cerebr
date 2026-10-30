import { useLayoutEffect, useRef, useState } from 'react';

const fittedView = () => ({ scale: 1, x: 0, y: 0 });
const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value));

// Keep high-frequency input outside React and publish at most once per frame.
// React still owns the image's transform; no message or preview DOM is mutated.
export function useImagePreviewGestures(image) {
    const viewportRef = useRef(null);
    const imageRef = useRef(null);
    const suppressClick = useRef(false);
    const [view, setView] = useState(fittedView);
    const [dragging, setDragging] = useState(false);

    useLayoutEffect(() => {
        setView(fittedView());
        setDragging(false);
        suppressClick.current = false;
        if (!image) return;
        const viewport = viewportRef.current;
        const picture = imageRef.current;
        let current = fittedView();
        let frame = 0;
        let gesture = null;
        const pointers = new Map();

        const publish = (next) => {
            const rect = viewport.getBoundingClientRect();
            current = {
                scale: next.scale,
                x: clamp(next.x, Math.max(0, (picture.offsetWidth * next.scale - rect.width) / 2)),
                y: clamp(next.y, Math.max(0, (picture.offsetHeight * next.scale - rect.height) / 2)),
            };
            if (!frame) {
                frame = requestAnimationFrame(() => {
                    frame = 0;
                    setView(current);
                });
            }
        };
        const point = (event) => {
            const rect = viewport.getBoundingClientRect();
            return {
                x: (event.clientX ?? rect.left + rect.width / 2) - rect.left - rect.width / 2,
                y: (event.clientY ?? rect.top + rect.height / 2) - rect.top - rect.height / 2,
            };
        };
        // The image coordinate under the gesture's centre stays under that centre
        // as it moves or scales (until the image reaches a viewport edge).
        const transform = (from, to, factor = 1) => {
            const scale = Math.max(1, Math.min(16, current.scale * factor));
            const ratio = scale / current.scale;
            publish({
                scale,
                x: to.x - (from.x - current.x) * ratio,
                y: to.y - (from.y - current.y) * ratio,
            });
        };
        const wheel = (event) => {
            event.preventDefault();
            // Safari supplies GestureEvents; Chromium/Firefox supply Ctrl+wheel
            // for a trackpad pinch. Do not apply both for the same gesture.
            if (gesture) return;
            const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
            if (event.ctrlKey || event.metaKey) {
                const anchor = point(event);
                transform(anchor, anchor, Math.exp(-event.deltaY * unit * 0.01));
            } else {
                const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
                const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
                publish({ ...current, x: current.x - dx * unit, y: current.y - dy * unit });
            }
        };
        const pointerGeometry = () => {
            const [first, second] = [...pointers.values()];
            return second
                ? {
                      x: (first.x + second.x) / 2,
                      y: (first.y + second.y) / 2,
                      distance: Math.hypot(second.x - first.x, second.y - first.y),
                  }
                : first;
        };
        const down = (event) => {
            if (event.button !== 0) return;
            if (!pointers.size) suppressClick.current = false;
            if (event.target.closest('button')) return;
            if (event.target !== picture && !pointers.size) return;
            event.preventDefault();
            pointers.set(event.pointerId, point(event));
            if (pointers.size > 1) suppressClick.current = true;
            picture.setPointerCapture?.(event.pointerId);
            setDragging(true);
        };
        const move = (event) => {
            if (!pointers.has(event.pointerId)) return;
            event.preventDefault();
            const before = pointerGeometry();
            pointers.set(event.pointerId, point(event));
            const after = pointerGeometry();
            if (Math.hypot(after.x - before.x, after.y - before.y) > 0) suppressClick.current = true;
            transform(before, after, before.distance ? after.distance / before.distance : 1);
        };
        const up = (event) => {
            pointers.delete(event.pointerId);
            if (picture.hasPointerCapture?.(event.pointerId)) picture.releasePointerCapture(event.pointerId);
            if (!pointers.size) setDragging(false);
        };
        const cancel = () => {
            gesture = null;
            for (const pointerId of pointers.keys()) {
                if (picture.hasPointerCapture?.(pointerId)) picture.releasePointerCapture(pointerId);
            }
            pointers.clear();
            setDragging(false);
        };
        const gestureStart = (event) => {
            event.preventDefault();
            if (pointers.size >= 2) return;
            gesture = { ...point(event), scale: event.scale || 1 };
        };
        const gestureChange = (event) => {
            event.preventDefault();
            if (!gesture || pointers.size >= 2 || !(event.scale > 0)) return;
            const next = { ...point(event), scale: event.scale };
            transform(gesture, next, next.scale / gesture.scale);
            gesture = next;
        };
        const gestureEnd = (event) => {
            event.preventDefault();
            gesture = null;
        };
        const doubleClick = (event) => {
            if (event.target.closest('button')) return;
            event.preventDefault();
            if (current.scale > 1) publish(fittedView());
            else {
                const anchor = point(event);
                transform(anchor, anchor, 2.5);
            }
        };
        const resize = () => publish(current);
        const loaded = () => publish(fittedView());
        const events = {
            wheel,
            pointerdown: down,
            pointermove: move,
            pointerup: up,
            pointercancel: up,
            lostpointercapture: up,
            gesturestart: gestureStart,
            gesturechange: gestureChange,
            gestureend: gestureEnd,
            dblclick: doubleClick,
        };
        // React's delegated wheel listener is passive, so it cannot prevent page
        // zoom. The non-passive listeners belong only to this visible preview.
        for (const [type, listener] of Object.entries(events))
            viewport.addEventListener(type, listener, { passive: false });
        picture.addEventListener('load', loaded);
        window.addEventListener('resize', resize);
        window.addEventListener('blur', cancel);
        return () => {
            cancel();
            cancelAnimationFrame(frame);
            for (const [type, listener] of Object.entries(events))
                viewport.removeEventListener(type, listener);
            picture.removeEventListener('load', loaded);
            window.removeEventListener('resize', resize);
            window.removeEventListener('blur', cancel);
        };
    }, [image]);

    return {
        viewportRef,
        imageRef,
        view,
        dragging,
        onClickCapture(event) {
            if (!suppressClick.current) return;
            suppressClick.current = false;
            if (event.target.closest('button')) return;
            event.preventDefault();
            event.stopPropagation();
        },
    };
}
