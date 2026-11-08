import { useLayoutEffect, useRef, useState } from 'react';

const fittedView = () => ({ scale: 1, x: 0, y: 0 });
const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value));
const swipeIdleMs = 180;
const swipeDistance = 80;

// Keep high-frequency input outside React and publish at most once per frame.
// React still owns the image's transform; no message or preview DOM is mutated.
export function useImagePreviewGestures(image, onNavigate) {
    const viewportRef = useRef(null);
    const imageRef = useRef(null);
    const suppressClick = useRef(false);
    const resetRef = useRef(null);
    const navigateRef = useRef(onNavigate);
    const [view, setView] = useState(fittedView);
    const [dragging, setDragging] = useState(false);
    const open = !!image;

    useLayoutEffect(() => { navigateRef.current = onNavigate; }, [onNavigate]);

    // Keep native listeners attached throughout the open preview, including
    // image transitions and the browser's current wheel transaction.
    useLayoutEffect(() => {
        setView(fittedView());
        setDragging(false);
        suppressClick.current = false;
        if (!open) return;
        const viewport = viewportRef.current;
        const picture = imageRef.current;
        let current = fittedView();
        let frame = 0;
        let gesture = null;
        let wheelSequence = null;
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
            const now = performance.now();
            const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
            const dx = (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit;
            const dy = (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * unit;
            // Zero-delta tail events must not keep a completed swipe locked.
            if (!dx && !dy) return;
            if (!wheelSequence || now - wheelSequence.time > swipeIdleMs) {
                wheelSequence = { time: now, x: 0, y: 0, blocked: current.scale > 1, peak: 0, last: 0 };
            }
            let sequence = wheelSequence;
            sequence.time = now;
            // Safari supplies GestureEvents; Chromium/Firefox supply Ctrl+wheel
            // for a trackpad pinch. Do not apply both for the same gesture.
            if (gesture || pointers.size) {
                sequence.blocked = true;
                sequence.navigated = null;
                return;
            }
            if (event.ctrlKey || event.metaKey) {
                sequence.blocked = true;
                sequence.navigated = null;
                const anchor = point(event);
                transform(anchor, anchor, Math.exp(-event.deltaY * unit * 0.01));
            } else {
                const magnitude = Math.abs(dx);
                // A new finger stroke can begin before the previous momentum
                // ends. Recognize a deliberate reversal or renewed acceleration
                // after deceleration, without requiring any pointer movement.
                if (
                    sequence.navigated != null && now - sequence.navigated >= 180 &&
                    magnitude > Math.abs(dy) * 1.5
                ) {
                    const reversed = Math.sign(dx) !== Math.sign(sequence.x) && magnitude >= 8;
                    const renewed = sequence.last < sequence.peak * 0.35 && magnitude >= Math.max(6, sequence.last * 2);
                    if (reversed || renewed) {
                        sequence = wheelSequence = { time: now, x: 0, y: 0, blocked: false, peak: 0, last: 0 };
                    }
                }
                sequence.peak = Math.max(sequence.peak, magnitude);
                sequence.last = magnitude;
                if (current.scale === 1 && !sequence.blocked) {
                    sequence.x += dx;
                    sequence.y += Math.abs(dy);
                    if (
                        Math.abs(sequence.x) >= swipeDistance &&
                        Math.abs(sequence.x) > sequence.y * 1.5
                    ) {
                        sequence.blocked = true;
                        sequence.navigated = now;
                        navigateRef.current?.(sequence.x > 0 ? 1 : -1, current);
                        return;
                    }
                }
                publish({ ...current, x: current.x - dx, y: current.y - dy });
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
        const reset = () => {
            cancel();
            cancelAnimationFrame(frame);
            frame = 0;
            current = fittedView();
            setView(current);
            suppressClick.current = false;
        };
        resetRef.current = reset;
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
            resetRef.current = null;
            cancel();
            cancelAnimationFrame(frame);
            for (const [type, listener] of Object.entries(events))
                viewport.removeEventListener(type, listener);
            picture.removeEventListener('load', loaded);
            window.removeEventListener('resize', resize);
            window.removeEventListener('blur', cancel);
        };
    }, [open]);

    useLayoutEffect(() => { resetRef.current?.(); }, [image]);

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
