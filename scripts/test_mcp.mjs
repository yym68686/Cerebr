import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// Storage is entirely in-memory. These tests never read/write an installed extension's data.
const values = {};
globalThis.chrome = { runtime: {}, storage: { local: {
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(values[key])])); },
    async set(payload) { Object.assign(values, structuredClone(payload)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
}, onChanged: { addListener() {} } } };
// UI preferences are nonsecret sync values; private API/MCP data stays in local.
const syncValues = {};
chrome.storage.sync = {
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(syncValues[key])])); },
    async set(payload) { Object.assign(syncValues, structuredClone(payload)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete syncValues[key]; },
};

const { McpClient, readServerSentEvents } = await import('../src/mcp/mcp-client.js');
const configModule = await import('../src/mcp/mcp-config.js');
const runtime = await import('../src/mcp/mcp-runtime.js');
const { McpTurn } = await import('../src/mcp/mcp-turn.js');
const { expandMessagesForApi } = await import('../src/mcp/mcp-messages.js');
const { callAPI } = await import('../src/runtime/chat/api-client.js');
const { toResponsesBody } = await import('../src/runtime/chat/responses-adapter.js');
const { modelSupportsReasoningEffort } = await import('../src/utils/reasoning-effort.js');
const { applyAssistantMessageSettings } = await import('../src/runtime/chat/assistant-settings.js');
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function sse(text, width = 1) {
    const bytes = new TextEncoder().encode(text);
    return new Response(new ReadableStream({ start(controller) {
        for (let i = 0; i < bytes.length; i += width) controller.enqueue(bytes.slice(i, i + width));
        controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
}
const frame = delta => 'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n';
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS', name); }

await test('SSE UTF-8 / CRLF 分块 / 多行 / 无末尾换行', async () => {
    const events = [];
    for await (const event of readServerSentEvents(sse('event: message\r\ndata: 中文\r\ndata: 第二行\r\n\r\ndata: 最后'))) events.push(event);
    assert.deepEqual(events.map(event => event.data), ['中文\n第二行', '最后']);
});

await test('HTTP 初始化 / 工具分页 / 404 会话恢复 / JSON-RPC 错误', async () => {
    let init = 0, expired = false;
    const client = new McpClient({ url: 'https://test.invalid/mcp', fetchImpl: async (_url, options) => {
        if (options.method === 'DELETE') return new Response(null, { status: 204 });
        const message = JSON.parse(options.body);
        if (!message.id) return new Response(null, { status: 202 });
        if (message.method === 'initialize') { init++; return json({ id: message.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'test' } } }); }
        if (message.method === 'tools/list') return json({ id: message.id, result: message.params.cursor ? { tools: [{ name: 'second' }] } : { tools: [{ name: 'first' }], nextCursor: 'page2' } });
        if (!expired) { expired = true; return new Response('expired', { status: 404 }); }
        return json({ id: message.id, error: { code: -32602, message: 'bad argument' } });
    } });
    assert.equal((await client.listTools()).length, 2);
    await assert.rejects(client.callTool('first'), error => error.code === -32602);
    assert.equal(init, 2);
    await client.close();
});

await test('旧版 SSE 初始化超时不影响长连接 / 调用 / 取消', async () => {
    let stream, streamSignal;
    const encoder = new TextEncoder();
    const client = new McpClient({ url: 'https://test.invalid/sse', transport: 'sse', fetchImpl: async (_url, options) => {
        if (options.method === 'GET') {
            streamSignal = options.signal;
            return new Response(new ReadableStream({ start(controller) {
                stream = controller;
                controller.enqueue(encoder.encode('event: endpoint\ndata: /messages\n\n'));
                options.signal.addEventListener('abort', () => controller.close(), { once: true });
            } }), { headers: { 'content-type': 'text/event-stream' } });
        }
        const message = JSON.parse(options.body);
        if (message.id && message.params?.name !== 'wait') {
            stream.enqueue(encoder.encode('event: message\ndata: ' + JSON.stringify({ id: message.id, result: message.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { content: [{ type: 'text', text: 'ok' }] } }) + '\n\n'));
        }
        return new Response(null, { status: 202 });
    } });
    const initSignal = new AbortController();
    await client.connect({ signal: initSignal.signal });
    initSignal.abort();
    assert.equal(streamSignal.aborted, false);
    assert.equal((await client.callTool('echo')).content[0].text, 'ok');
    const stop = new AbortController();
    const call = client.callTool('wait', {}, { signal: stop.signal });
    await new Promise(resolve => setTimeout(resolve, 5));
    stop.abort();
    await assert.rejects(call, error => error.name === 'AbortError');
    await client.close();
});

await test('旧版 SSE 不向跨域 endpoint 泄露认证头', async () => {
    let posted = false;
    const client = new McpClient({ url: 'https://test.invalid/sse', transport: 'sse', headers: { Authorization: 'Bearer test-only' }, fetchImpl: async (_url, options) => {
        if (options.method === 'POST') posted = true;
        return sse('event: endpoint\ndata: https://other.invalid/messages\n\n');
    } });
    await assert.rejects(client.connect(), /跨域/);
    assert.equal(posted, false);
});

await test('工具刷新保留单项开关 / 新增默认停用 / 名称碰撞', async () => {
    const merged = configModule.mergeFetchedTools({ tools: [{ name: 'a', enabled: true }, { name: 'b', enabled: false }] }, [{ name: 'a' }, { name: 'b' }, { name: 'new' }]);
    assert.deepEqual(merged.map(tool => tool.enabled), [true, false, false]);
    const cfg = configModule.normalizeMcpConfig({ settings: { approvalMode: 'confirm-write' }, servers: [{ id: 'one', url: 'https://test.invalid', tools: [{ name: 'same' }] }, { id: 'two', url: 'https://test.invalid', tools: [{ name: 'same' }] }] });
    const plan = runtime.buildToolPlan(cfg);
    assert.equal(new Set(plan.definitions.map(tool => tool.function.name)).size, 2);
    assert.equal(runtime.toolNeedsApproval(cfg.settings, cfg.servers[0], { annotations: { readOnlyHint: true } }), false);
    assert.equal(runtime.toolNeedsApproval(cfg.settings, cfg.servers[0], {}), true);
    const overridden = configModule.mergeFetchedTools({ tools: [{ name: 'task_status', enabled: true, descriptionOverride: '学习任务结果' }] }, [{ name: 'task_status', description: '原始服务器描述' }]);
    assert.equal(overridden[0].descriptionOverride, '学习任务结果');
    const study = configModule.normalizeMcpConfig({ servers: [{ id: 'study', url: 'https://test.invalid', instructions: 'private server context', instructionsEnabled: false, tools: overridden }] });
    const studyPlan = runtime.buildToolPlan(study);
    assert.equal(studyPlan.definitions[0].function.description, '学习任务结果');
    assert.ok(!new McpTurn(study, studyPlan).getPromptFragments()[0].content.includes('private server context'));
});

await test('确认拒绝 / 立即确认无竞态 / 中断等待 / 限制轮数', async () => {
    const cfg = configModule.normalizeMcpConfig({ settings: { maxRounds: 1, approvalMode: 'confirm-all' }, servers: [{ id: 'test', url: 'https://test.invalid', tools: [{ name: 'write' }] }] });
    const turn = new McpTurn(cfg, runtime.buildToolPlan(cfg));
    await turn.runToolRound({ content: '开始', tool_calls: [{ id: 'deny1', function: { name: 'write', arguments: '{}' } }] }, { sync: async message => {
        for (const call of message.toolCalls) if (call.status === 'pending_approval') assert.equal(runtime.resolveToolApproval(call.id, 'deny'), true);
    } });
    assert.equal(turn.toolCalls[0].status, 'denied');
    await turn.runToolRound({ content: '开始', tool_calls: [{ id: 'limit', function: { name: 'write', arguments: '{}' } }] }, { sync: async () => {} });
    assert.equal(turn.getToolChoice(), 'none');
    assert.equal(turn.toolCalls[1].status, 'skipped');
    const stop = new AbortController();
    const wait = runtime.waitForToolApproval('stop', stop.signal);
    stop.abort();
    assert.equal(await wait, 'deny');
});

await test('多轮历史 / 工具结果与图片 / 禁用 MCP 降级', async () => {
    const message = { role: 'assistant', content: '前文后文', __mcpLive: true, toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}', round: 1, offset: 2, status: 'done', result: { text: '结果', images: [{ dataUrl: 'data:image/png;base64,aA==' }] } }] };
    const transcript = expandMessagesForApi([message], { withTools: true });
    assert.deepEqual(transcript.map(item => item.role), ['assistant', 'tool', 'user', 'assistant']);
    assert.equal(transcript[1].tool_call_id, 'c1');
    assert.equal(expandMessagesForApi([message], { withTools: false })[0].content, '前文后文');
    assert.equal(runtime.formatToolResult({ content: [{ type: 'image', mimeType: 'image/png', data: 'aA==' }] }).images.length, 1);
});

await test('停用的历史工具不再发送结果 / 保留存储历史 / 不转发旧图片', async () => {
    const message = { role: 'assistant', content: '已讲解', __mcpLive: true, toolCalls: [
        { id: 'old', name: 'server_context', arguments: '{}', round: 1, offset: 0, status: 'done', result: { text: 'old private server context', images: [{ dataUrl: 'data:image/png;base64,aA==' }] } },
        { id: 'new', name: 'book_catalog', arguments: '{}', round: 2, offset: 0, status: 'done', result: { text: 'study catalog' } },
    ] };
    const result = expandMessagesForApi([message], { withTools: true, allowedToolNames: new Set(['book_catalog']) });
    assert.ok(!JSON.stringify(result).includes('old private server context'));
    assert.ok(!JSON.stringify(result).includes('data:image'));
    assert.ok(JSON.stringify(result).includes('study catalog'));
    assert.equal(message.toolCalls.length, 2);
});

await test('Chat Completions 分块工具调用 / 中文 UTF-8 / 流内错误', async () => {
    const old = globalThis.fetch;
    try {
        globalThis.fetch = async () => sse(frame({ content: '中文' }) + frame({ tool_calls: [{ index: 0, id: 'c', function: { name: 'echo', arguments: '{"x":' } }] }) + frame({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }) + 'data: [DONE]');
        const { processStream } = await callAPI({ messages: [{ role: 'user', content: '测试' }], apiConfig: { baseUrl: 'https://test.invalid/v1', apiKey: 'test-only' } });
        const result = await processStream();
        assert.equal(result.content, '中文');
        assert.equal(result.tool_calls[0].function.arguments, '{"x":1}');
        globalThis.fetch = async () => sse('data: {"error":{"message":"test stream failure"}}\n\n');
        const request = await callAPI({ messages: [], apiConfig: { baseUrl: 'https://test.invalid/v1', apiKey: 'test-only' } });
        await assert.rejects(request.processStream(), error => error.code === 'API_STREAM_ERROR');
    } finally { globalThis.fetch = old; }
});

await test('Responses 多轮函数转换 / 原生流 / 加密推理 / 未完成报错', async () => {
    const body = toResponsesBody({ model: 'example-provider/gpt-5', messages: [
        { role: 'system', content: '提示' },
        { role: 'assistant', content: null, reasoning_items: [{ type: 'reasoning', id: 'rs', encrypted_content: 'test-encrypted' }], tool_calls: [{ id: 'c', function: { name: 'echo', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c', content: '结果' },
    ], tools: [{ type: 'function', function: { name: 'echo', parameters: { type: 'object' } } }], tool_choice: { type: 'function', function: { name: 'echo' } } });
    assert.deepEqual(body.input.map(item => item.type), ['message', 'reasoning', 'function_call', 'function_call_output']);
    assert.equal(body.input[0].role, 'developer');
    assert.equal(body.tool_choice.name, 'echo');
    assert.equal(body.store, false);
    assert.equal(modelSupportsReasoningEffort('example-provider/gpt-5'), true);
    const old = globalThis.fetch;
    try {
        const events = [
            { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc', call_id: 'c', name: 'echo', arguments: '' } },
            { type: 'response.function_call_arguments.delta', item_id: 'fc', delta: '{"x":1}' },
            { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc', call_id: 'c', name: 'echo', arguments: '{"x":1}' } },
            { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs', encrypted_content: 'test-encrypted', summary: [] } },
            { type: 'response.completed', response: { status: 'completed', output: [] } },
        ];
        globalThis.fetch = async () => {
            const response = sse(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
            // Regression: the actual production gateway returned SSE with a JSON header.
            response.headers.set('content-type', 'application/json');
            return response;
        };
        const request = await callAPI({ messages: [], apiConfig: { baseUrl: 'https://test.invalid/v1/responses', apiKey: 'test-only', modelName: 'test' } });
        const result = await request.processStream();
        assert.equal(result.tool_calls[0].id, 'c');
        assert.equal(result.tool_calls[0].function.arguments, '{"x":1}');
        assert.equal(result.reasoning_items.length, 1);
        let cancelled = false;
        globalThis.fetch = async () => new Response(new ReadableStream({
            start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","id":"m","content":[{"type":"output_text","text":"完成"}]}]}}\n\n')); },
            cancel() { cancelled = true; },
        }), { headers: { 'content-type': 'application/json' } });
        const terminal = await callAPI({ messages: [], apiConfig: { baseUrl: 'https://test.invalid/v1/responses', apiKey: 'test-only' } });
        const deadline = setTimeout(() => terminal.controller.abort(), 1000);
        assert.equal((await terminal.processStream()).content, '完成');
        clearTimeout(deadline);
        assert.equal(cancelled, true, 'terminal event must close an otherwise open stream');
        globalThis.fetch = async () => sse('data: {"type":"response.output_text.delta","delta":"半截"}\n\n');
        const broken = await callAPI({ messages: [], apiConfig: { baseUrl: 'https://test.invalid/v1/responses', apiKey: 'test-only' } });
        await assert.rejects(broken.processStream(), /response.completed/);
    } finally { globalThis.fetch = old; }
});

await test('始终允许写入及未知权限工具 / 停用工具不暴露 / 不出现确认状态', async () => {
    const old = globalThis.fetch;
    const cfg = configModule.normalizeMcpConfig({ settings: { approvalMode: 'auto' }, servers: [{ id: 'auto-test', url: 'https://test.invalid/auto', tools: [{ name: 'write', annotations: { destructiveHint: true } }, { name: 'disabled', enabled: false }] }] });
    const plan = runtime.buildToolPlan(cfg);
    assert.equal(cfg.settings.approvalMode, 'auto');
    assert.equal(plan.definitions.length, 1);
    assert.equal(runtime.toolNeedsApproval(cfg.settings, cfg.servers[0], {}), false);
    try {
        let called = 0;
        globalThis.fetch = async (_url, options) => {
            if (options.method === 'DELETE') return new Response(null, { status: 204 });
            const message = JSON.parse(options.body);
            if (!message.id) return new Response(null, { status: 202 });
            if (message.method === 'initialize') return json({ id: message.id, result: { protocolVersion: '2025-06-18' } });
            assert.equal(message.method, 'tools/call');
            called++;
            return json({ id: message.id, result: { content: [{ type: 'text', text: 'mock only, no remote write' }] } });
        };
        const turn = new McpTurn(cfg, plan);
        await turn.runToolRound({ tool_calls: [{ id: 'auto-write', function: { name: 'write', arguments: '{}' } }] }, { sync: async snapshot => {
            assert.ok(snapshot.toolCalls.every(call => call.status !== 'pending_approval'));
        } });
        assert.equal(called, 1);
        assert.equal(turn.toolCalls[0].status, 'done');
        runtime.dropMcpClient('auto-test');
    } finally { globalThis.fetch = old; }
});

await test('Kelivo 版本升级覆盖旧确认策略和绑定开关 / 自建服务器保留', async () => {
    await configModule.saveMcpConfig({ settings: { approvalMode: 'confirm-write' }, servers: [{ id: 'bound', url: 'https://test.invalid/old', enabled: false, tools: [{ name: 'a', enabled: false }] }, { id: 'custom', url: 'https://test.invalid/custom' }] });
    const seed = { settings: { approvalMode: 'auto' }, servers: [{ id: 'bound', url: 'https://test.invalid/new', enabled: true, tools: [{ name: 'a', enabled: true }, { name: 'b', enabled: false }] }] };
    await configModule.applyMcpSeed(seed);
    assert.equal((await configModule.loadMcpConfig()).settings.approvalMode, 'confirm-write');
    await configModule.applyMcpSeed({ ...seed, syncExisting: true });
    const updated = await configModule.loadMcpConfig();
    assert.equal(updated.settings.approvalMode, 'auto');
    assert.equal(updated.servers.find(server => server.id === 'bound').enabled, true);
    assert.equal(updated.servers.find(server => server.id === 'bound').url, 'https://test.invalid/new');
    assert.deepEqual(updated.servers.find(server => server.id === 'bound').tools.map(tool => tool.enabled), [true, false]);
    assert.ok(updated.servers.some(server => server.id === 'custom'));
});

await test('Kelivo 消息模板 / 时间随历史稳定 / 图片保留 / 系统缓存前缀稳定', async () => {
    const messages = [{ role: 'user', createdAt: '2026-10-13T07:00:00.000Z', content: '问题' }, { role: 'user', createdAt: '2026-10-13T07:01:00.000Z', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aA==' } }, { type: 'text', text: '看图' }] }];
    const settings = { kelivo: { appendCurrentTimeToUserMessage: true, useIso8601TimeFormat: true, messageTemplate: '<问题>{{ message }}</问题>', limitContextMessages: false } };
    const result = applyAssistantMessageSettings(messages, settings);
    assert.match(result[0].content, /<问题>问题<\/问题>/);
    assert.match(result[0].content, /2026-10-13T07:00:00.000Z/);
    assert.equal(result[1].content[0].type, 'image_url');
    assert.equal(messages[0].content, '问题');
    assert.deepEqual(applyAssistantMessageSettings(messages, settings), result);
    assert.equal(applyAssistantMessageSettings([{ role: 'user', content: '旧历史' }], { kelivo: { appendCurrentTimeToUserMessage: true } })[0].content, '旧历史');
    const config = configModule.normalizeMcpConfig({});
    const turn = new McpTurn(config, runtime.buildToolPlan(config));
    assert.deepEqual(turn.getPromptFragments(), turn.getPromptFragments());
    assert.ok(!turn.getPromptFragments()[0].content.includes('当前时间'));
});

await test('私有初始化升级一次 / API 与提示词合并 / 语言主题同步', async () => {
    const old = globalThis.fetch;
    try {
        const { applyLocalSeedIfNeeded } = await import('../src/app/shell/local-seed.js');
        chrome.runtime.getURL = path => 'https://test.invalid/' + path;
        values.cerebrLocalSeedVersion = 'old-version';
        values.unrelatedChatSentinel = 'keep-history';
        globalThis.fetch = async () => json({ seedVersion: 'test-seed', preferences: { uiLanguage: 'zh_CN', theme: 'light' }, apiConfigs: [{ id: 'seed', apiKey: 'test-only', advancedSettings: { systemPrompt: '测试提示' } }], selectedConfigId: 'seed', mcp: { syncExisting: true, settings: { approvalMode: 'auto' }, servers: [{ id: 'seed-server', url: 'https://test.invalid/mcp' }] } });
        let writes = 0, stored;
        const deps = { readApiConfigMeta: async () => ({ apiConfigs: [{ id: 'existing', apiKey: 'test-only' }] }),
            normalizeApiConfig: config => config, stripApiConfigForSync: config => config,
            getSystemPromptKey: id => 'prompt_' + id,
            writeApiConfigMeta: async payload => { writes++; stored = payload; } };
        await applyLocalSeedIfNeeded(deps);
        await applyLocalSeedIfNeeded(deps);
        assert.equal(writes, 1);
        assert.deepEqual(stored.apiConfigs.map(config => config.id), ['seed', 'existing']);
        assert.equal((await configModule.loadMcpConfig()).servers.some(server => server.id === 'seed-server'), true);
        assert.equal(values.prompt_seed, '测试提示');
        assert.equal(syncValues.uiLanguage, 'zh_CN');
        assert.equal(syncValues.theme, 'light');
        assert.equal(values.unrelatedChatSentinel, 'keep-history');
    } finally { globalThis.fetch = old; }
});

if (process.env.CEREBR_TEST_DOM_MODULE) {
    await test('MCP 设置页 DOM / 服务器单项开关 / 卡片与图片渲染', async () => {
        const { parseHTML } = await import(pathToFileURL(process.env.CEREBR_TEST_DOM_MODULE));
        const { document, window } = parseHTML('<html><body><button id="settings-button"></button><div id="settings-menu"><div id="api-settings-toggle"></div></div></body></html>');
        globalThis.document = document;
        globalThis.window = window;
        window.confirm = () => true;
        const { initMcpSettings } = await import('../src/mcp/mcp-settings.js');
        const cfg = configModule.normalizeMcpConfig({ servers: [{ id: 'dom', url: 'https://test.invalid/mcp', toolsUpdatedAt: Date.now(), tools: [{ name: 'read', annotations: { readOnlyHint: true } }] }] });
        await configModule.saveMcpConfig(cfg);
        const page = initMcpSettings({ menu: document.getElementById('settings-menu') });
        await page.render();
        assert.equal(document.querySelectorAll('.mcp-server-card').length, 1);
        assert.equal(document.querySelectorAll('.mcp-tool-setting').length, 1);
        const { renderAssistantContent } = await import('../src/mcp/mcp-render.js');
        const container = document.createElement('div');
        renderAssistantContent(container, { text: '完成', toolCalls: [{ id: 'dom-call', name: 'read', status: 'done', round: 1, offset: 0, result: { text: '<script>bad()</script>', images: [{ dataUrl: 'data:image/png;base64,aA==' }] } }] });
        assert.equal(container.querySelectorAll('.mcp-tool-card').length, 1);
        assert.equal(container.querySelectorAll('img').length, 1);
        assert.equal(container.querySelectorAll('script').length, 0);
        assert.ok(document.querySelector('#mcp-settings-toggle'));
    });
}
console.log('TOTAL PASS', passed);
