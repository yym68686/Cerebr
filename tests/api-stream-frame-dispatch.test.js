import { afterEach, expect, it, vi } from 'vitest';
import { callAPI } from '../src/runtime/chat/api-client.js';

// 流式分发改成了 rAF 对齐（见 api-client.js 的 scheduleFrameUpdate）：rAF 只负责把写入挪到
// 帧边界，原来的 setTimeout 节流保留作兜底。这里钉住两个回归点：
//   1. 流在帧回调触发之前就结束了，最后一批内容不能丢；
//   2. rAF 完全不触发（后台标签页会被压到几乎不跑）时，仍然要有人把内容分发出去。

function sseResponse(frames) {
    const encoder = new TextEncoder();
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: {
            getReader() {
                let i = 0;
                return {
                    async read() {
                        if (i >= frames.length) return { done: true, value: undefined };
                        const chunk = frames[i++];
                        return {
                            done: false,
                            value: encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: chunk }] })}\n\n`),
                        };
                    },
                    async cancel() {},
                };
            },
        },
    };
}

async function runStream({ rafImpl }) {
    const originalFetch = globalThis.fetch;
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    globalThis.fetch = vi.fn(async () => sseResponse([{ content: '一' }, { content: '二' }, { content: '三' }]));
    globalThis.requestAnimationFrame = rafImpl;
    globalThis.cancelAnimationFrame = () => {};
    try {
        const updates = [];
        const manager = { updateLastMessage: vi.fn() };
        const { processStream } = await callAPI(
            {
                apiConfig: { baseUrl: 'https://example.invalid/v1', apiKey: 'k', modelName: 'm' },
                messages: [{ role: 'user', content: 'ping' }],
            },
            manager,
            'chat-frame',
            (chatId, message) => updates.push(message.content)
        );
        const result = await processStream();
        return { result, updates, storeWrites: manager.updateLastMessage.mock.calls.length };
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.requestAnimationFrame = originalRaf;
        globalThis.cancelAnimationFrame = originalCancel;
    }
}

afterEach(() => {
    vi.restoreAllMocks();
});

it('does not strand the tail when the stream ends before the frame fires', async () => {
    // rAF 排了但永远不回调：模拟流结束得比帧还快。
    const { result, updates, storeWrites } = await runStream({ rafImpl: () => 1 });
    expect(result).toEqual({ content: '一二三', reasoning_content: '' });
    // 收尾的 flush 必须把完整内容交出去，不能因为帧没到就丢掉。
    expect(updates.at(-1)).toBe('一二三');
    expect(storeWrites).toBeGreaterThan(0);
});

it('still delivers content when requestAnimationFrame never runs', async () => {
    // 后台标签页里 rAF 会被压到几乎不触发，兜底路径必须自己把内容送出去。
    const { result, updates } = await runStream({ rafImpl: () => 0 });
    expect(result.content).toBe('一二三');
    expect(updates.at(-1)).toBe('一二三');
});

it('dispatches through the frame callback when one is available', async () => {
    // 正常情况：帧回调真的跑起来，内容经由它分发。
    let frameRan = 0;
    const { result, updates } = await runStream({
        rafImpl: (cb) => {
            frameRan++;
            setTimeout(() => cb(performance.now()), 0);
            return frameRan;
        },
    });
    expect(result.content).toBe('一二三');
    expect(updates.at(-1)).toBe('一二三');
});
