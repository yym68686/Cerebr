import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/i18n.js', () => ({ t: (key) => key }));
vi.mock('../src/domain/chat/chat-store.js', () => ({ chatManager: {} }));
import { ImagePreview } from '../src/app/components/Overlays.jsx';
import { uiStore } from '../src/app/state/ui-store.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, viewport, picture, frames, width, height;
const source = 'data:image/png;base64,AQ==';

beforeEach(async () => {
    frames = new Map();
    let id = 0;
    vi.stubGlobal(
        'requestAnimationFrame',
        vi.fn((callback) => {
            frames.set(++id, callback);
            return id;
        })
    );
    vi.stubGlobal(
        'cancelAnimationFrame',
        vi.fn((key) => frames.delete(key))
    );
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await render(source);
    viewport = host.querySelector('.image-preview-modal');
    picture = host.querySelector('img');
    width = 1000;
    height = 800;
    viewport.getBoundingClientRect = () => ({ left: 0, top: 0, width, height });
    Object.defineProperty(viewport, 'clientHeight', { get: () => height });
    Object.defineProperty(picture, 'offsetWidth', { get: () => 900 });
    Object.defineProperty(picture, 'offsetHeight', { get: () => 600 });
    const captured = new Set();
    picture.setPointerCapture = vi.fn((pointerId) => captured.add(pointerId));
    picture.hasPointerCapture = (pointerId) => captured.has(pointerId);
    picture.releasePointerCapture = vi.fn((pointerId) => captured.delete(pointerId));
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});
async function render(image) {
    await act(async () => {
        uiStore.set({ image });
        root.render(<ImagePreview image={image} />);
    });
}
async function flush() {
    await act(async () => {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback();
    });
}
async function wheel(options, flushFrame = true) {
    const event = new WheelEvent('wheel', {
        clientX: 500,
        clientY: 400,
        bubbles: true,
        cancelable: true,
        ...options,
    });
    await act(async () => viewport.dispatchEvent(event));
    if (flushFrame) await flush();
    return event;
}
async function pointer(type, x, y, id = 1, target = picture) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { clientX: x, clientY: y, pointerId: id, button: 0 });
    await act(async () => target.dispatchEvent(event));
}
async function gesture(type, scale) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { scale, clientX: 500, clientY: 400 });
    await act(async () => viewport.dispatchEvent(event));
    await flush();
    return event;
}
function view() {
    const [, x, y, scale] = picture.style.transform.match(
        /translate3d\(([-\d.e]+)px, ([-\d.e]+)px, 0\) scale\(([-\d.e]+)\)/
    );
    return { x: +x, y: +y, scale: +scale };
}
const zoomTwice = { ctrlKey: true, deltaY: -Math.log(2) / 0.01 };

describe('image preview gestures', () => {
    it('keeps the close control outside the image content while zooming and panning', async () => {
        const close = host.querySelector('.image-preview-close');
        expect(close.parentElement).toBe(viewport);
        expect(host.querySelector('.image-preview-content').contains(close)).toBe(false);
        await wheel(zoomTwice);
        await wheel({ deltaX: 80, deltaY: 60 });
        expect(close.parentElement).toBe(viewport);
        expect(view()).toEqual({ x: -80, y: -60, scale: 2 });
        await pointer('pointerdown', 980, 20, 1, close);
        expect(picture.setPointerCapture).not.toHaveBeenCalled();
        await act(async () => close.click());
        expect(uiStore.getSnapshot().image).toBeNull();
    });

    it('keeps the point under the cursor stationary while pinching and prevents page zoom', async () => {
        const event = await wheel({ ...zoomTwice, clientX: 600, clientY: 450 });
        expect(event.defaultPrevented).toBe(true);
        expect(view().scale).toBeCloseTo(2);
        expect(view().x).toBeCloseTo(-100);
        expect(view().y).toBeCloseTo(-50);
        // An image point 100px right and 50px below its centre remains at (600, 450).
        expect(500 + view().x + 100 * view().scale).toBeCloseTo(600);
        expect(400 + view().y + 50 * view().scale).toBeCloseTo(450);
    });

    it('accumulates fine pinch deltas but renders only once per animation frame', async () => {
        for (let i = 0; i < 10; i++) await wheel({ ctrlKey: true, deltaY: -1 }, false);
        expect(view().scale).toBe(1);
        expect(frames.size).toBe(1);
        await flush();
        expect(view().scale).toBeCloseTo(Math.exp(0.1));
    });

    it('pans with two-finger scrolling including momentum and clamps to the image edges', async () => {
        await wheel(zoomTwice);
        await wheel({ deltaX: 30, deltaY: 40 });
        expect(view()).toEqual({ x: -30, y: -40, scale: 2 });
        await wheel({ deltaX: 10000, deltaY: -10000 });
        expect(view()).toEqual({ x: -400, y: 200, scale: 2 });
        await wheel({ deltaX: -10000, deltaY: 10000 });
        expect(view()).toEqual({ x: 400, y: -200, scale: 2 });
        await wheel({ ctrlKey: true, deltaY: 10000 });
        expect(view()).toEqual({ x: 0, y: 0, scale: 1 });
        await wheel({ ctrlKey: true, deltaY: -10000 });
        expect(view().scale).toBe(16);
    });

    it('normalizes mouse wheel line/page units and Shift scrolling', async () => {
        await wheel(zoomTwice);
        await wheel({ deltaY: 2, deltaMode: 1, shiftKey: true });
        expect(view().x).toBe(-32);
        expect(view().y).toBe(0);
        await wheel({ deltaY: 1, deltaMode: 2 });
        expect(view().y).toBe(-200);
    });

    it('captures a drag, stops at image edges and does not close on the resulting backdrop click', async () => {
        await wheel(zoomTwice);
        await pointer('pointerdown', 500, 400);
        expect(picture.setPointerCapture).toHaveBeenCalledWith(1);
        await pointer('pointermove', 800, 500);
        await flush();
        expect(view()).toEqual({ x: 300, y: 100, scale: 2 });
        await pointer('pointerup', 800, 500);
        expect(picture.releasePointerCapture).toHaveBeenCalledWith(1);
        await act(async () => viewport.click());
        expect(uiStore.getSnapshot().image).toBe(source);
        // A new, deliberate backdrop click still closes.
        await pointer('pointerdown', 5, 5, 2, viewport);
        await act(async () => viewport.click());
        expect(uiStore.getSnapshot().image).toBeNull();
    });

    it('combines touch pinch and pan, then continues with one finger without jumping', async () => {
        await pointer('pointerdown', 400, 400, 1);
        await pointer('pointerdown', 600, 400, 2);
        await pointer('pointermove', 800, 400, 2);
        await flush();
        expect(view()).toEqual({ x: 100, y: 0, scale: 2 });
        await pointer('pointerup', 800, 400, 2);
        await pointer('pointermove', 450, 430, 1);
        await flush();
        expect(view()).toEqual({ x: 150, y: 30, scale: 2 });
        await pointer('pointercancel', 450, 430, 1);
        await pointer('pointermove', 900, 700, 1);
        await flush();
        expect(view()).toEqual({ x: 150, y: 30, scale: 2 });
        expect(host.querySelector('.is-dragging')).toBeNull();
    });

    it('supports Safari trackpad pinch without applying simultaneous Ctrl+wheel twice', async () => {
        expect((await gesture('gesturestart', 1)).defaultPrevented).toBe(true);
        await gesture('gesturechange', 2);
        await wheel(zoomTwice);
        expect(view().scale).toBe(2);
        await gesture('gesturechange', 3);
        expect(view().scale).toBe(3);
        await gesture('gestureend', 3);
        await wheel({ deltaX: 20, deltaY: 10 });
        expect(view()).toEqual({ x: -20, y: -10, scale: 3 });
    });

    it('does not apply Safari touch gestures a second time over the two active pointers', async () => {
        await pointer('pointerdown', 400, 400, 1);
        await pointer('pointerdown', 600, 400, 2);
        await gesture('gesturestart', 1);
        await pointer('pointermove', 800, 400, 2);
        await gesture('gesturechange', 2);
        await flush();
        expect(view().scale).toBe(2);
    });

    it('double-clicks to zoom/reset and adjusts pan when the viewport grows', async () => {
        const doubleClick = () =>
            picture.dispatchEvent(
                new MouseEvent('dblclick', {
                    clientX: 500,
                    clientY: 400,
                    bubbles: true,
                    cancelable: true,
                })
            );
        await act(async () => doubleClick());
        await flush();
        expect(view().scale).toBe(2.5);
        await wheel({ deltaX: 10000, deltaY: 10000 });
        width = 2000;
        height = 1400;
        await act(async () => window.dispatchEvent(new Event('resize')));
        await flush();
        expect(view()).toEqual({ x: -125, y: -50, scale: 2.5 });
        await act(async () => doubleClick());
        await flush();
        expect(view()).toEqual({ x: 0, y: 0, scale: 1 });
    });

    it('releases captures on blur, preserves the close button and restores focus on closing', async () => {
        const input = document.createElement('input');
        document.body.append(input);
        await render(null);
        input.focus();
        expect(document.activeElement).toBe(input);
        const focus = vi.spyOn(input, 'focus');
        await render(source);
        expect(document.activeElement).toBe(host.querySelector('button'));
        await wheel(zoomTwice);
        await pointer('pointerdown', 500, 400);
        await pointer('pointermove', 550, 400);
        await act(async () => window.dispatchEvent(new Event('blur')));
        expect(picture.releasePointerCapture).toHaveBeenCalledWith(1);
        await act(async () => host.querySelector('button').click());
        expect(uiStore.getSnapshot().image).toBeNull();
        await render(null);
        expect(focus).toHaveBeenCalled();
        expect(document.activeElement).toBe(input);
        expect(frames.size).toBe(0);
        input.remove();
    });

    it('resets between images and removes wheel interception when hidden', async () => {
        await wheel(zoomTwice, false);
        await render('data:image/png;base64,Ag==');
        await flush();
        expect(view()).toEqual({ x: 0, y: 0, scale: 1 });
        await act(async () =>
            host
                .querySelector('button')
                .dispatchEvent(
                    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
                )
        );
        expect(uiStore.getSnapshot().image).toBeNull();
        await render(null);
        expect((await wheel(zoomTwice)).defaultPrevented).toBe(false);
        expect(view()).toEqual({ x: 0, y: 0, scale: 1 });
    });
});
