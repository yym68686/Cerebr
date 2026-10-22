import { expect, it } from 'vitest';
import { createProgressTracker } from '../src/runtime/sync/progress-tracker.js';
it('does not restart settled replies from delayed duplicate transports and keeps chats independent', () => {
    const tracker = createProgressTracker();
    const frame = (phase, startedAt = 10, chatId = 'a') => ({ phase, startedAt, chatId });
    expect(tracker.accept(frame('thinking'))).toBe(true);
    expect(tracker.accept(frame('replying'))).toBe(true);
    expect(tracker.accept(frame('idle'))).toBe(true);
    expect(tracker.accept(frame('replying'))).toBe(false);
    expect(tracker.accept(frame('thinking'))).toBe(false);
    expect(tracker.accept(frame('thinking', 10, 'b'))).toBe(true);
    expect(tracker.accept(frame('thinking', 20))).toBe(true);
    expect(tracker.accept(frame('idle', 10))).toBe(false);
    expect(tracker.accept(frame('idle', 20))).toBe(true);
    tracker.accept({ reset: true });
    expect(tracker.accept(frame('thinking'))).toBe(true);
});
