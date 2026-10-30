// @vitest-environment node
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { callAPI } from '../src/runtime/chat/api-client.js';
let server, url, received;
beforeAll(async () => {
    server = createServer(async (req, res) => {
        const chunks = [];
        for await (const bytes of req) chunks.push(bytes);
        received = { path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const payload = Buffer.from(
            'data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\r\n\ndata:{"choices":[{"delta":{"content":"你好 🌏"}}]}\n\ndata: {"choices":[{"delta":{"content":"完成"}}]}'
        );
        // Split UTF-8 characters and SSE lines across physical network chunks.
        for (let i = 0; i < payload.length; i += 2) {
            res.write(payload.subarray(i, i + 2));
            await new Promise((r) => setTimeout(r, 1));
        }
        res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}/v1`;
});
afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
});
describe('real HTTP streaming transport', () => {
    it('sends configured credentials/model and preserves fragmented Unicode and final frames', async () => {
        const manager = { updateLastMessage: vi.fn() },
            update = vi.fn();
        const { processStream } = await callAPI(
            {
                apiConfig: {
                    baseUrl: url,
                    apiKey: 'local-test-only',
                    modelName: 'test-model',
                    advancedSettings: { systemPrompt: 'Reply in {{userLanguage}}' },
                },
                messages: [{ role: 'user', content: 'ping', reasoning_content: 'do not send' }],
                userLanguage: 'zh-CN',
                promptFragments: [{ pluginId: 'test', placement: 'system.append', content: 'extra' }],
            },
            manager,
            'chat-a',
            update
        );
        const result = await processStream();
        expect(received.path).toBe('/v1/chat/completions');
        expect(received.auth).toBe('Bearer local-test-only');
        expect(received.body.model).toBe('test-model');
        expect(received.body.stream).toBe(true);
        expect(received.body.messages[0].content).toBe('Reply in zh-CN\n\nextra');
        expect(received.body.messages.at(-1)).toEqual({ role: 'user', content: 'ping' });
        expect(result).toEqual({ content: '你好 🌏完成', reasoning_content: '思考' });
        expect(update).toHaveBeenLastCalledWith('chat-a', result);
    });

    it('sends document text beyond previous client limits unchanged to the configured API', async () => {
        const text = '完整文档内容 '.repeat(30_000);
        const { processStream } = await callAPI(
            {
                apiConfig: { baseUrl: url, apiKey: 'local-test-only', modelName: 'test-model' },
                messages: [{ role: 'user', content: text }],
                userLanguage: 'zh-CN',
            },
            { updateLastMessage: vi.fn() },
            'chat-large-document',
            vi.fn()
        );
        await processStream();
        const sent = received.body.messages.at(-1).content;
        expect(sent.length).toBe(text.length);
        expect(sent === text).toBe(true);
    });
});

 it.each(['data: [DONE]\n\n', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'])(
    'settles on %s even when the HTTP connection stays open', async (end) => {
        const cancel = vi.fn(() => new Promise(() => {}));
        const body = new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"finished"}}]}\n\n' + end));
        }, cancel });
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
        try {
            const {processStream} = await callAPI({apiConfig:{baseUrl:url,apiKey:'test',modelName:'test'},messages:[]},
                {updateLastMessage:vi.fn()},'a',vi.fn());
            let result;
            void processStream().then(value => result = value);
            await vi.waitFor(() => expect(result?.content).toBe('finished'), {timeout:500});
            expect(cancel).toHaveBeenCalled();
        } finally { fetchMock.mockRestore(); }
    });
