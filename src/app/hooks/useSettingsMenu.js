import { useEffect, useRef } from 'react';
import { uiStore } from '../state/ui-store.js';

const HOVER_OPEN_DELAY_MS = 140;
const HOVER_CLOSE_DELAY_MS = 280;
const BUTTON_MARGIN_PX = 28;
const isMouse = (event) => !event.pointerType || event.pointerType === 'mouse';

function containsPoint(element, x, y, margin = 0) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const dx = Math.max(rect.left - x, 0, x - rect.right);
    const dy = Math.max(rect.top - y, 0, y - rect.bottom);
    return Math.hypot(dx, dy) <= margin;
}

export function useSettingsMenu() {
    const mode = useRef(null);
    const openTimer = useRef(null);
    const closeTimer = useRef(null);
    const pointer = useRef(null);
    const cancelOpen = () => {
        clearTimeout(openTimer.current);
        openTimer.current = null;
    };
    const cancelClose = () => {
        clearTimeout(closeTimer.current);
        closeTimer.current = null;
    };
    const pin = () => {
        cancelOpen();
        cancelClose();
        mode.current = 'click';
    };
    const close = () => {
        uiStore.set({ menu: false, webpageMenu: false });
        document.getElementById('settings-button')?.focus({ preventScroll: true });
    };
    const openSources = () => {
        pin();
        uiStore.set({ menu: true, webpageMenu: true, context: null });
    };
    const back = () => {
        pin();
        uiStore.set({ menu: true, webpageMenu: false });
        requestAnimationFrame(() => document.getElementById('webpage-qa')?.focus({ preventScroll: true }));
    };

    useEffect(() => {
        const isInside = () => {
            if (!pointer.current) return false;
            const { x, y } = pointer.current;
            return (
                containsPoint(document.getElementById('settings-button'), x, y, BUTTON_MARGIN_PX) ||
                containsPoint(document.getElementById('settings-menu'), x, y) ||
                (uiStore.getSnapshot().webpageMenu &&
                    containsPoint(document.getElementById('webpage-content-menu'), x, y))
            );
        };
        const scheduleClose = () => {
            cancelClose();
            if (!uiStore.getSnapshot().menu || mode.current !== 'hover') return;
            closeTimer.current = setTimeout(() => {
                closeTimer.current = null;
                if (mode.current !== 'hover' || !uiStore.getSnapshot().menu || isInside()) return;
                uiStore.set({ menu: false, webpageMenu: false });
            }, HOVER_CLOSE_DELAY_MS);
        };
        const move = (event) => {
            if (!isMouse(event) || event.buttons) return;
            pointer.current = { x: event.clientX, y: event.clientY };
            if (isInside()) cancelClose();
            else scheduleClose();
        };
        const leaveDocument = (event) => {
            if (!isMouse(event) || event.relatedTarget) return;
            pointer.current = null;
            cancelOpen();
            scheduleClose();
        };
        const unsubscribe = uiStore.subscribe(() => {
            const state = uiStore.getSnapshot();
            if (state.menu) return;
            mode.current = null;
            cancelOpen();
            cancelClose();
        });
        document.addEventListener('pointermove', move, { passive: true });
        document.addEventListener('pointerout', leaveDocument, { passive: true });
        return () => {
            unsubscribe();
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerout', leaveDocument);
            cancelOpen();
            cancelClose();
        };
    }, []);

    return {
        button: {
            onKeyDown(event) {
                if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
                event.preventDefault();
                cancelOpen();
                cancelClose();
                mode.current = 'click';
                uiStore.set({ menu: true, webpageMenu: false });
                requestAnimationFrame(() => {
                    if (!uiStore.getSnapshot().menu) return;
                    const items = [...document.querySelectorAll('#settings-menu [role="menuitem"]')].filter(
                        (item) => !item.closest('[hidden]') && item.getAttribute('aria-disabled') !== 'true'
                    );
                    (event.key === 'ArrowUp' ? items.at(-1) : items[0])?.focus({ preventScroll: true });
                });
            },
            onClick() {
                cancelOpen();
                cancelClose();
                const { menu } = uiStore.getSnapshot();
                // The first click confirms a hover-opened menu; the next click closes it.
                const keepOpen = !menu || mode.current === 'hover';
                mode.current = keepOpen ? 'click' : null;
                uiStore.set({ menu: keepOpen, webpageMenu: false });
            },
            onPointerEnter(event) {
                if (!isMouse(event)) return;
                cancelClose();
                if (uiStore.getSnapshot().menu) return;
                cancelOpen();
                openTimer.current = setTimeout(() => {
                    openTimer.current = null;
                    if (uiStore.getSnapshot().menu) return;
                    mode.current = 'hover';
                    uiStore.set({ menu: true });
                }, HOVER_OPEN_DELAY_MS);
            },
            onPointerLeave(event) {
                if (isMouse(event)) cancelOpen();
            },
        },
        pin,
        close,
        openSources,
        back,
    };
}
