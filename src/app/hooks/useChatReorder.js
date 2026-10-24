import { useEffect, useRef, useState } from 'react';

// Pointer dragging works in Safari and on touch handles without disabling list scrolling.
export function useChatReorder({ listRef, onDrop, resetKey }) {
    const drag = useRef(null),
        frame = useRef(0),
        suppressClick = useRef(false);
    const commit = useRef(onDrop);
    commit.current = onDrop;
    const [preview, setPreview] = useState(null);

    useEffect(() => {
        const finish = (save, publish = true) => {
            const state = drag.current;
            drag.current = null;
            cancelAnimationFrame(frame.current);
            frame.current = 0;
            if (state && listRef.current?.hasPointerCapture?.(state.pointerId))
                listRef.current.releasePointerCapture(state.pointerId);
            if (publish) setPreview(null);
            if (save && state?.active && state.destination) commit.current(state.id, state.destination);
        };
        const updateTarget = () => {
            const state = drag.current,
                list = listRef.current;
            if (!state || !list) return;
            const hit = list.ownerDocument.elementFromPoint(state.x, state.y);
            let row = hit?.closest('[data-chat-id], [data-drop-folder-id]');
            if (!row && (hit === list || hit?.classList.contains('navigation-glide'))) {
                const last = list.querySelectorAll('[data-chat-id], [data-drop-folder-id]');
                const candidate = last[last.length - 1];
                if (candidate && state.y >= candidate.getBoundingClientRect().bottom) row = candidate;
            }
            let destination = null;
            if (row && list.contains(row) && row.dataset.chatId !== state.id) {
                if (row.dataset.chatId) {
                    const rect = row.getBoundingClientRect();
                    destination = {
                        targetId: row.dataset.chatId,
                        before: state.y < rect.top + rect.height / 2,
                    };
                } else destination = { folderId: row.dataset.dropFolderId || null };
            }
            state.destination = destination;
            setPreview((previous) => {
                const next = { id: state.id, destination };
                return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
            });
        };
        const scroll = () => {
            const state = drag.current,
                list = listRef.current;
            if (!state?.active || !list) return;
            const rect = list.getBoundingClientRect();
            if (state.x >= rect.left && state.x <= rect.right) {
                const delta =
                    state.y < rect.top + 36
                        ? -Math.min(12, (rect.top + 36 - state.y) / 3)
                        : state.y > rect.bottom - 36
                          ? Math.min(12, (state.y - rect.bottom + 36) / 3)
                          : 0;
                if (delta)
                    list.scrollTop = Math.max(
                        0,
                        Math.min(list.scrollHeight - list.clientHeight, list.scrollTop + delta)
                    );
            }
            updateTarget();
            frame.current = requestAnimationFrame(scroll);
        };
        const move = (event) => {
            const state = drag.current;
            if (!state || event.pointerId !== state.pointerId) return;
            state.x = event.clientX;
            state.y = event.clientY;
            if (!state.active) {
                if (Math.hypot(state.x - state.startX, state.y - state.startY) < 6) return;
                state.active = true;
                suppressClick.current = true;
                listRef.current?.setPointerCapture?.(state.pointerId);
                frame.current = requestAnimationFrame(scroll);
            }
            event.preventDefault();
            updateTarget();
        };
        const up = (event) => {
            if (event.pointerId !== drag.current?.pointerId) return;
            if (drag.current.active) {
                drag.current.x = event.clientX;
                drag.current.y = event.clientY;
                updateTarget();
            }
            finish(true);
        };
        const cancel = () => finish(false);
        const cancelPointer = (event) => {
            if (event.pointerId === drag.current?.pointerId) cancel();
        };
        const lostCapture = (event) => {
            // Touch starts with implicit capture on the handle. Transferring it to
            // the list must not cancel the drag when the handle loses capture.
            if (event.target === listRef.current) cancelPointer(event);
        };
        const key = (event) => {
            if (!drag.current) {
                suppressClick.current = false;
                return;
            }
            if (event.key !== 'Escape' || !drag.current) return;
            event.preventDefault();
            event.stopPropagation();
            cancel();
        };
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', cancelPointer);
        window.addEventListener('lostpointercapture', lostCapture);
        window.addEventListener('blur', cancel);
        window.addEventListener('keydown', key, true);
        return () => {
            finish(false, false);
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', cancelPointer);
            window.removeEventListener('lostpointercapture', lostCapture);
            window.removeEventListener('blur', cancel);
            window.removeEventListener('keydown', key, true);
        };
    }, [listRef, resetKey]);
    useEffect(() => setPreview(null), [resetKey]);

    return {
        preview,
        begin(event, id) {
            if (event.button !== 0 || event.isPrimary === false || drag.current) return;
            drag.current = {
                id,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                x: event.clientX,
                y: event.clientY,
                active: false,
                destination: null,
            };
        },
        clearClick() {
            suppressClick.current = false;
        },
        consumeClick(event) {
            if (!suppressClick.current) return;
            suppressClick.current = false;
            event.preventDefault();
            event.stopPropagation();
        },
    };
}
