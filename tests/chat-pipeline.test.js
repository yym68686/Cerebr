import { describe, it, expect, vi } from 'vitest';
vi.mock('../src/runtime/chat/api-client.js', () => ({ callAPI: vi.fn() }));
vi.mock('../src/utils/ui.js', () => ({ showToast: vi.fn() }));
import { callAPI } from '../src/runtime/chat/api-client.js';
import { createChatPipeline } from '../src/runtime/chat/chat-pipeline.js';
import { showToast } from '../src/utils/ui.js';
import { resolveChatApiConfig } from '../src/domain/chat/model-selection.js';

function setup(plugins = {}, getWebpageInfo = async () => null, managerOverrides = {}, selectApi) {
    const chat = { id: 'a', title: '', messages: [] };
    const manager = {
        chats: new Map([['a', chat]]),
        getCurrentChat: () => chat,
        addMessageToChat: async (id, m) => manager.chats.get(id).messages.push(m),
        markChatDirty: vi.fn(),
        saveChats: async () => {},
        flushNow: async () => {},
        ...managerOverrides,
    };
    const editor = {
        getDraftSnapshot: () => ({ text: 'hello', imageTags: [], empty: false }),
        clear: vi.fn(),
        focus: vi.fn(),
    };
    const phase = vi.fn();
    const submitted = vi.fn();
    const pipeline = createChatPipeline({
        chatManager: manager,
        editor,
        getSelectedApiConfig: selectApi || (() => ({
            baseUrl: 'https://test.invalid/v1',
            apiKey: 'test-only',
            modelName: 'test',
        })),
        getWebpageInfo,
        getUserLanguage: () => 'zh-CN',
        pluginRuntime: plugins,
        onPhase: phase,
        onSubmitted: submitted,
    });
    return { pipeline, chat, editor, phase, manager, submitted };
}
describe('React chat session pipeline', () => {
    it('sends and regenerates with the conversation model rather than the new-chat default', async () => {
        const a={id:'a',modelName:'old-model',apiKey:'test-only',baseUrl:'https://test.invalid/v1'};
        const b={...a,id:'b',modelName:'new-default'};
        const state={configs:[a,b],selected:1,defaultSelection:{configId:'b',modelName:'new-default'}};
        const select=vi.fn(chat=>resolveChatApiConfig(chat,state));
        const {pipeline,chat}=setup({},async()=>null,{},select);
        chat.modelSelection={configId:'a',modelName:'old-model'};
        chat.messages=[{role:'user',content:'original'},{role:'assistant',content:'old answer'}];
        callAPI.mockReset().mockResolvedValue({controller:new AbortController(),processStream:async()=>({content:'answer'})});
        await pipeline.sendMessage();
        expect(select).toHaveBeenCalledWith(chat);
        expect(callAPI.mock.calls[0][0].apiConfig.modelName).toBe('old-model');
        await pipeline.regenerateMessage(1);
        expect(callAPI.mock.calls[1][0].apiConfig.modelName).toBe('old-model');
        state.configs=[b];
        expect(await pipeline.sendMessage()).toBe(false);
        expect(callAPI).toHaveBeenCalledTimes(2);
    });
    it('sends a selection as a new quoted question and preserves the existing composer draft', async () => {
        const { pipeline, chat, editor, phase, submitted } = setup();
        chat.messages.push({ role: 'assistant', content: 'Old answer' });
        callAPI
            .mockReset()
            .mockResolvedValue({
                controller: new AbortController(),
                processStream: async () => ({ content: 'Explanation' }),
            });
        expect(await pipeline.sendSelection('Quoted passage\nSecond line', 'Why?')).toBe(true);
        await vi.waitFor(() => expect(phase).toHaveBeenLastCalledWith('idle', 'a'));
        expect(chat.messages[1]).toMatchObject({
            role: 'user',
            content: '> Quoted passage\n> Second line\n\nWhy?',
            selectionQuotes: ['Quoted passage\nSecond line'],
            selectionQuestion: 'Why?',
        });
        expect(callAPI.mock.calls[0][0].messages.at(-1).content).toBe(
            '> Quoted passage\n> Second line\n\nWhy?'
        );
        expect(editor.clear).not.toHaveBeenCalled();
        expect(editor.focus).not.toHaveBeenCalled();
        expect(phase).toHaveBeenNthCalledWith(1, 'thinking', 'a', { preserveReadingPosition: true });
        expect(submitted).toHaveBeenCalledWith('a', { preserveDraft: true, preserveReadingPosition: true });
        expect(editor.getDraftSnapshot().text).toBe('hello');
    });
    it('acknowledges a selected-text question before the answer arrives, while keeping cancellation active', async () => {
        const {pipeline, chat, phase} = setup();
        const controller = new AbortController();
        let finish;
        const answer = new Promise(resolve => { finish = resolve; });
        callAPI.mockReset().mockResolvedValue({controller, processStream:() => answer});
        expect(await pipeline.sendSelection('Passage', 'Why?')).toBe(true);
        expect(chat.messages[0].selectionQuestion).toBe('Why?');
        expect(phase).toHaveBeenLastCalledWith('thinking', 'a', { preserveReadingPosition: true });
        await vi.waitFor(() => expect(callAPI).toHaveBeenCalledOnce());
        const stopped = pipeline.abortActiveReply();
        expect(controller.signal.aborted).toBe(true);
        finish({content:'Partial answer'});
        await stopped;
        expect(phase).toHaveBeenLastCalledWith('idle', 'a');
    });
    it('rejects selection submissions before a message is added when configuration or hooks prevent sending', async () => {
        const missing = setup({}, async()=>null, {}, ()=>null);
        expect(await missing.pipeline.sendSelection('Passage','Why?')).toBe(false);
        expect(missing.chat.messages).toHaveLength(0);
        const canceled = setup({runBeforeSend: async()=>({cancel:true})});
        expect(await canceled.pipeline.sendSelection('Passage','Why?')).toBe(false);
        expect(canceled.chat.messages).toHaveLength(0);
    });
    it('sends composer quotes together with images and text', async () => {
        const { pipeline, chat, editor } = setup();
        const tag = document.createElement('span');
        tag.setAttribute('data-image', 'data:image/png;base64,AQ==');
        editor.getDraftSnapshot = () => ({
            text: 'Compare',
            quotes: ['A passage'],
            imageTags: [tag],
            empty: false,
        });
        callAPI
            .mockReset()
            .mockResolvedValue({
                controller: new AbortController(),
                processStream: async () => ({ content: 'Answer' }),
            });
        await pipeline.sendMessage();
        expect(chat.messages[0].content).toEqual([
            { type: 'text', text: '> A passage\n\nCompare' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } },
        ]);
        expect(editor.clear).toHaveBeenCalledOnce();
    });
    it('starts an immediate flush before waiting for an idle-scheduled save', async () => {
        let complete;
        const saved = new Promise((resolve) => {
            complete = resolve;
        });
        const flushNow = vi.fn(async () => complete());
        callAPI.mockReset().mockResolvedValue({
            controller: new AbortController(),
            processStream: async () => ({ content: 'answer' }),
        });
        const { pipeline } = setup({}, async () => null, { saveChats: () => saved, flushNow });
        const request = pipeline.sendMessage();
        try {
            await vi.waitFor(() => expect(flushNow).toHaveBeenCalled(), { timeout: 100 });
        } finally {
            complete();
            await request;
        }
    });

    it('allows another send and chat switching while persistence is still pending', async () => {
        let complete;
        const saved = new Promise((resolve) => {
            complete = resolve;
        });
        callAPI.mockReset().mockResolvedValue({
            controller: new AbortController(),
            processStream: async () => ({ content: 'answer' }),
        });
        const { pipeline, phase } = setup({}, async () => null, {
            saveChats: () => saved,
            flushNow: () => saved,
        });
        let finished = false;
        const first = pipeline.sendMessage().then(() => {
            finished = true;
        });
        try {
            await vi.waitFor(() => expect(finished).toBe(true), { timeout: 100 });
            await pipeline.abortActiveReply();
            await pipeline.sendMessage();
            expect(callAPI).toHaveBeenCalledTimes(2);
            expect(phase).toHaveBeenLastCalledWith('idle', 'a');
        } finally {
            complete();
            await first;
        }
    });
    it('preserves the draft and does not call the model when a selected PDF is missing', async () => {
        callAPI.mockClear();
        const failure = new Error('Could not read selected PDF: missing.pdf');
        const { pipeline, editor, chat, phase } = setup({}, async () => {
            throw failure;
        });
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect(await pipeline.sendMessage()).toBe(false);
            expect(callAPI).not.toHaveBeenCalled();
            expect(editor.clear).not.toHaveBeenCalled();
            expect(chat.messages).toEqual([]);
            expect(showToast).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ type: 'error' })
            );
            expect(phase).toHaveBeenLastCalledWith('idle', 'a');
        } finally {
            errors.mockRestore();
        }
    });
    it('uses transformed drafts and the full request/plugin lifecycle', async () => {
        const plugins = {
            runBeforeSend: vi.fn(async (p) => ({
                payload: { ...p, userMessage: { role: 'user', content: 'transformed' } },
            })),
            buildPromptFragments: vi.fn(async () => ({ fragments: [{ content: 'extra' }] })),
            transformRequest: vi.fn(),
            handleAfterResponse: vi.fn(),
            handleStreamChunk: vi.fn(),
        };
        const { pipeline, chat, editor, phase } = setup(plugins);
        callAPI.mockImplementation(async (params, manager, id, onUpdate, options) => ({
            controller: new AbortController(),
            processStream: async () => {
                expect(params.messages.at(-1).content).toBe('transformed');
                expect(params.promptFragments).toEqual([{ content: 'extra' }]);
                expect(options.lifecycle.beforeRequest).toBeTypeOf('function');
                await onUpdate(id, { content: 'reply' });
                return { content: 'reply' };
            },
        }));
        expect(await pipeline.sendMessage()).toBe(true);
        expect(chat.messages[0].content).toBe('transformed');
        expect(editor.clear).toHaveBeenCalledOnce();
        expect(plugins.handleAfterResponse).toHaveBeenCalledOnce();
        expect(phase).toHaveBeenLastCalledWith('idle', 'a');
    });
    it('keeps the draft and history when a plugin cancels sending', async () => {
        callAPI.mockClear();
        const { pipeline, editor, chat } = setup({ runBeforeSend: async () => ({ cancel: true }) });
        expect(await pipeline.sendMessage()).toBe(false);
        expect(editor.clear).not.toHaveBeenCalled();
        expect(chat.messages).toEqual([]);
        expect(callAPI).not.toHaveBeenCalled();
    });
    it('can abort before receiving a first token and always returns to idle', async () => {
        let started;
        const ready = new Promise((r) => {
            started = r;
        });
        callAPI.mockImplementation(async () => {
            const controller = new AbortController();
            return {
                controller,
                processStream: () =>
                    new Promise((resolve) => {
                        controller.signal.addEventListener('abort', () => resolve(undefined));
                        started();
                    }),
            };
        });
        const { pipeline, phase } = setup();
        const request = pipeline.sendMessage();
        await ready;
        pipeline.abortActiveReply();
        await request;
        expect(phase).toHaveBeenLastCalledWith('idle', 'a');
        expect(pipeline.abortControllerRef.current).toBe(null);
    });
    it('leaves thinking for idle even when saving the chat fails', async () => {
        // phase 是唯一驱动「正在思考 N 秒」的状态，而 onPhase('idle') 只有一处写入。以前它排在
        // 两个 await 的持久化后面，写盘一 reject 就跳出 finally，界面永远停在 thinking。
        const boom = new Error('QuotaExceededError');
        callAPI.mockReset().mockResolvedValue({
            controller: new AbortController(),
            processStream: async () => ({ content: 'answer' }),
        });
        const { pipeline, phase } = setup({}, async () => null, {
            saveChats: async () => {
                throw boom;
            },
        });
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await pipeline.sendMessage();
            expect(phase).toHaveBeenLastCalledWith('idle', 'a');
            await vi.waitFor(() =>
                expect(errors).toHaveBeenCalledWith(expect.stringContaining('persist'), boom)
            );
        } finally {
            errors.mockRestore();
        }
    });
    it('stops a reply that is still waiting on page context, before any controller exists', async () => {
        // 扩展里取网页正文要跨标签页发消息，这一跳没有超时。停止更新必须能打断这段等待，
        // 而不是等它自己结束才被 pendingAbort 读到。
        callAPI.mockReset();
        let contextRequested;
        const asked = new Promise((r) => {
            contextRequested = r;
        });
        const { pipeline, phase } = setup({}, () => {
            contextRequested();
            return new Promise(() => {}); // 永不 resolve：模拟挂死的标签页
        });
        const request = pipeline.sendMessage();
        await asked;
        await pipeline.abortActiveReply();
        expect(await request).toBe(false);
        expect(phase).toHaveBeenLastCalledWith('idle', 'a');
        expect(callAPI).not.toHaveBeenCalled();
    });
    it('tracks the run before sendMessage() returns, so a stop in the same tick is honored', async () => {
        // abortActiveReply 在 running 为空时直接返回，这只在 running 与 onPhase('thinking') 同步
        // 赋值时才安全。以后若在 schedule() 里 run() 之前加 await，这里的停止会被丢掉、请求挂死。
        callAPI.mockReset();
        const { pipeline, phase } = setup({}, () => new Promise(() => {}));
        const request = pipeline.sendMessage();
        pipeline.abortActiveReply(); // 与 sendMessage() 同一个同步段，中间没有让出事件循环
        expect(await request).toBe(false);
        expect(phase).toHaveBeenLastCalledWith('idle', 'a');
        expect(callAPI).not.toHaveBeenCalled();
    });
    it('regenerates from a selected question and truncates later messages', async () => {
        const { pipeline, chat } = setup();
        chat.messages.push(
            { role: 'user', content: 'one' },
            { role: 'assistant', content: 'old' },
            { role: 'user', content: 'later' }
        );
        callAPI.mockImplementation(async (params) => ({
            controller: new AbortController(),
            processStream: async () => {
                expect(params.messages).toEqual([{ role: 'user', content: 'one' }]);
                return { content: 'new' };
            },
        }));
        await pipeline.regenerateMessage(1);
        expect(chat.messages).toEqual([{ role: 'user', content: 'one', updating: false }]);
    });
    it('regenerates an edited tutorial answer even if its question is still localized', async () => {
        const { pipeline, chat } = setup();
        chat.messages.push(
            { role: 'user', content: 'example question', seedLocaleBound: true },
            { role: 'assistant', content: 'edited answer' }
        );
        callAPI.mockReset().mockResolvedValue({
            controller: new AbortController(),
            processStream: async () => ({ content: 'new answer' }),
        });
        expect(await pipeline.regenerateMessage(1)).toBe(true);
        expect(callAPI).toHaveBeenCalledOnce();
        expect(callAPI.mock.calls[0][0].messages).toMatchObject([
            { role: 'user', content: 'example question', seedLocaleBound: true },
        ]);
    });
    it('retries reasoning-only responses using the plugin retry policy', async () => {
        const { pipeline } = setup({ handleResponseError: async () => ({ retry: { maxAttempts: 2 } }) });
        callAPI
            .mockReset()
            .mockResolvedValueOnce({
                controller: new AbortController(),
                processStream: async () => ({ content: '', reasoning_content: 'thought' }),
            })
            .mockResolvedValueOnce({
                controller: new AbortController(),
                processStream: async () => ({ content: 'answer' }),
            });
        expect(await pipeline.sendMessage()).toBe(true);
        expect(callAPI).toHaveBeenCalledTimes(2);
    });
});

 it('streams conversations independently, including navigation during preflight and stopping only the active one', async () => {
    let resolveContext;
    const { pipeline, manager, editor, phase, chat } = setup({}, () => new Promise(r => resolveContext = r));
    const second = { id:'b', messages:[] };
    manager.chats.set('b', second);
    let current = chat;
    manager.getCurrentChat = () => current;
    const streams = new Map();
    callAPI.mockReset().mockImplementation(async (params, store, id, update) => {
        const controller = new AbortController();
        return { controller, processStream: () => new Promise(resolve => {
            streams.set(id, { controller, resolve, update });
            controller.signal.addEventListener('abort', () => resolve());
        }) };
    });
    const firstRequest = pipeline.sendMessage();
    current = second;
    resolveContext(null);
    await vi.waitFor(() => expect(streams.has('a')).toBe(true));
    expect(chat.messages[0].content).toBe('hello');
    expect(second.messages).toHaveLength(0);
    expect(editor.clear).not.toHaveBeenCalled();
    const secondRequest = pipeline.sendMessage();
    resolveContext(null);
    await vi.waitFor(() => expect(streams.has('b')).toBe(true));
    await streams.get('a').update('a', {content:'still running'});
    expect(streams.get('a').controller.signal.aborted).toBe(false);
    await pipeline.abortActiveReply();
    await secondRequest;
    expect(streams.get('a').controller.signal.aborted).toBe(false);
    expect(phase).toHaveBeenLastCalledWith('idle', 'b');
    streams.get('a').resolve({content:'complete'});
    expect(await firstRequest).toBe(true);
    expect(phase).toHaveBeenLastCalledWith('idle', 'a');
 });

it('includes complete TXT attachments in requests and persists compact file metadata', async () => {
    const {pipeline,chat,editor}=setup();
    editor.getDraftSnapshot=()=>({text:'Summarize',imageTags:[],textFiles:[{id:'f',name:'notes.txt',text:'Full file body',size:14}],empty:false});
    callAPI.mockReset().mockResolvedValue({controller:new AbortController(),processStream:async()=>({content:'Summary'})});
    await pipeline.sendMessage();
    expect(chat.messages[0].textFiles).toEqual([{id:'f',name:'notes.txt',size:14,textLength:14}]);
    expect(callAPI.mock.calls[0][0].messages.at(-1).content).toBe('--- notes.txt ---\nFull file body\n---\n\nSummarize');
    expect(editor.clear).toHaveBeenCalledOnce();
});
