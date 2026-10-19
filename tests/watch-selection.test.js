import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { watchTextSelection } from '../src/runtime/selection/watch-selection.js';
let passage, changed, dispose;
const advance = (ms) => vi.advanceTimersByTimeAsync(ms);
const select = (end) => {
    const range = document.createRange();
    range.setStart(passage.firstChild, 0);
    range.setEnd(passage.firstChild, end);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
};
const pointer = (type, target = passage) => target.dispatchEvent(new MouseEvent(type, { bubbles: true }));
beforeEach(() => {
    vi.useFakeTimers();
    passage = document.createElement('p');
    passage.textContent = 'A selected passage.';
    document.body.append(passage);
    Range.prototype.getBoundingClientRect = () => ({
        left: 100,
        right: 200,
        top: 200,
        bottom: 220,
        width: 100,
        height: 20,
    });
    changed = vi.fn();
    dispose = watchTextSelection({ scope: () => passage, onChange: changed });
});
afterEach(() => {
    dispose();
    passage.remove();
    window.getSelection().removeAllRanges();
    delete Range.prototype.getBoundingClientRect;
    vi.clearAllTimers();
    vi.useRealTimers();
});
it('does not chase a dragged selection even during pauses and reveals only the final range after release', async () => {
    pointer('pointerdown');
    select(1);
    await advance(300);
    select(10);
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    await advance(300);
    expect(changed).not.toHaveBeenCalled();
    select(19);
    pointer('pointerup');
    await advance(100);
    expect(changed).not.toHaveBeenCalled();
    await advance(100);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.lastCall[0].text).toBe('A selected passage.');
});
it('coalesces keyboard or touch-handle changes, hides the previous menu once, then shows the settled selection', async () => {
    select(1);
    await advance(200);
    changed.mockClear();
    select(4);
    await advance(100);
    select(10);
    await advance(100);
    expect(changed.mock.calls).toEqual([[null]]);
    select(19);
    await advance(200);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(changed.mock.lastCall[0].text).toBe('A selected passage.');
});
it('allows visible bars to follow scrolling without bypassing a pending selection delay', async () => {
    select(10);
    await advance(100);
    window.dispatchEvent(new Event('scroll'));
    await advance(40);
    expect(changed).not.toHaveBeenCalled();
    await advance(60);
    changed.mockClear();
    window.dispatchEvent(new Event('scroll'));
    await advance(20);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.lastCall[0].text).toBe('A selected');
});
it('cancels pending reveals on lost gestures and disposal', async () => {
    select(10);
    await advance(20);
    pointer('pointercancel');
    await advance(200);
    expect(changed).not.toHaveBeenCalled();
    select(19);
    dispose();
    await advance(200);
    expect(changed).not.toHaveBeenCalled();
});
