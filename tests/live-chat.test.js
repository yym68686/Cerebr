import { afterEach, expect, it } from 'vitest';
import { applyLiveChat, getLiveChat, reconcileLiveChat, clearLiveChats } from '../src/runtime/sync/live-chat.js';
afterEach(clearLiveChats);
const initial = { chatId: 'a', requestId: 'r1', sequence: 1, startedAt: 10, phase: 'thinking', chat: { id: 'a', title: 'Question', messages: [{ role: 'user', content: 'Question' }] } };
it('displays the sent question and streaming reasoning/text before any history write', () => {
    expect(applyLiveChat(initial)).toBe(true);
    expect(getLiveChat('a').messages[0].content).toBe('Question');
    applyLiveChat({ ...initial, chat: undefined, sequence: 2, phase: 'replying', index: 1, message: { role: 'assistant', reasoning_content: '**Thinking**', content: '' } });
    expect(getLiveChat('a').messages[1].reasoning_content).toBe('**Thinking**');
    applyLiveChat({ ...initial, chat: undefined, sequence: 3, phase: 'replying', index: 1, message: { role: 'assistant', content: 'Partial answer' } });
    expect(getLiveChat('a').messages[1].content).toBe('Partial answer');
    expect(applyLiveChat(initial)).toBe(false);
    reconcileLiveChat('a', initial.chat);
    expect(getLiveChat('a').messages[1].content).toBe('Partial answer');
});
it('keeps a finished frame until matching durable history arrives', () => {
    applyLiveChat(initial);
    const chat = { ...initial.chat, messages: [...initial.chat.messages, { role: 'assistant', content: 'Done', updating: false }] };
    applyLiveChat({ ...initial, sequence: 2, phase: 'idle', chat });
    reconcileLiveChat('a', initial.chat);
    expect(getLiveChat('a')).toEqual(chat);
    reconcileLiveChat('a', chat);
    expect(getLiveChat('a')).toBeUndefined();
});
it('releases a finished preview when later offline messages or edits arrive', () => {
    const chat = { ...initial.chat, updatedAt: '2026-10-20T00:00:00Z' };
    applyLiveChat({ ...initial, phase: 'idle', chat });
    reconcileLiveChat('a', { ...chat, messages: [...chat.messages, { role: 'user', content: 'Offline question' }] });
    expect(getLiveChat('a')).toBeUndefined();
    applyLiveChat({ ...initial, phase: 'idle', chat });
    reconcileLiveChat('a', { ...chat, updatedAt: '2026-10-20T00:01:00Z', messages: [{ role: 'user', content: 'Edited offline' }] });
    expect(getLiveChat('a')).toBeUndefined();
});
it('does not apply an old request or a delta without its own initial snapshot', () => {
    applyLiveChat(initial);
    expect(applyLiveChat({ ...initial, requestId: 'r2', chat: undefined, sequence: 2, index: 0, message: {} })).toBe(false);
    applyLiveChat({ ...initial, requestId: 'r2', startedAt: 20 });
    expect(applyLiveChat({ ...initial, sequence: 99 })).toBe(false);
});
