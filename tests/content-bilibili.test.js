// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.bilibili.com/video/BV1xx411c7mD/?p=2"}
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/plugin/page/page-plugin-runtime.js', () => ({
    createPagePluginRuntime: () => ({ start: async () => {} }),
}));
vi.mock('../src/plugin/page/user-script-page-plugin-host.js', () => ({
    handleUserScriptPagePluginHostRpc: async () => null,
}));

let handleMessage, listenerCleanup, subtitleResponse;
const video = '/video/BV1xx411c7mD/';
const json = (data) => new Response(JSON.stringify(data));
const extract = () => new Promise((resolve) => {
    expect(handleMessage({ type: 'GET_PAGE_CONTENT_INTERNAL', skipWaitContent: true }, {}, resolve)).toBe(true);
});

beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    window.history.replaceState(null, '', video + '?p=2');
    document.title = '测试视频 P2';
    document.body.innerHTML = '<p>简短简介</p>';
    listenerCleanup = [];
    for (const target of [window, document]) {
        const add = target.addEventListener.bind(target);
        vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
            listenerCleanup.push(() => target.removeEventListener(type, listener, options));
            add(type, listener, options);
        });
    }
    vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('chrome', {
        runtime: {
            getManifest: () => ({ background: { service_worker: 'dist/background.js' } }),
            getURL: (path) => `chrome-extension://test/${path}`,
            sendMessage: vi.fn(async () => ({ success: true })),
        },
        storage: {
            local: { get: async () => ({}), set: async () => {} },
            sync: { get: async () => ({}), set: async () => {} },
        },
    });
    subtitleResponse = () => json({ body: [{ content: 'AI 视频字幕' }] });
    vi.stubGlobal('fetch', vi.fn(async (value) => {
        if (value.includes('/x/web-interface/view')) return json({ code: 0, data: {
            cid: 111, pages: [{ page: 1, cid: 111 }, { page: 2, cid: 222 }],
        } });
        if (value.includes('/x/player/wbi/v2')) return json({ code: 0, data: { subtitle: { subtitles: [
            { lan: 'ai-zh', subtitle_url: '//aisubtitle.hdslb.com/subtitle.json' },
        ] } } });
        if (value.includes('aisubtitle.hdslb.com')) return subtitleResponse();
        return new Response('/* sidebar CSS */');
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    handleMessage = (await import('../src/host/content/content-script.js')).bootContentScript();
});
afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    listenerCleanup.forEach((remove) => remove());
    document.querySelectorAll('cerebr-root').forEach((node) => node.remove());
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it('returns AI subtitles through the real content entry even when the page body is short', async () => {
    const result = await extract();
    expect(result).toMatchObject({ url: window.location.href, content: '简短简介',
        bilibiliSubtitle: { bvid: 'BV1xx411c7mD', page: 2, cid: 222, lang: 'ai-zh', text: 'AI 视频字幕' } });
    expect(document.querySelector('iframe')).toBeNull();
});

it('coalesces content requests for the same page', async () => {
    const results = await Promise.all([extract(), extract()]);
    expect(results[0]).toEqual(results[1]);
    expect(fetch.mock.calls.filter(([value]) => value.includes('/x/web-interface/view'))).toHaveLength(1);
});

it('does not share an old in-flight extraction with a newly selected part', async () => {
    let finish;
    subtitleResponse = () => new Promise((resolve) => { finish = resolve; });
    const oldRead = extract();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    subtitleResponse = () => json({ body: [{ content: 'P1 字幕' }] });
    window.history.replaceState(null, '', video);
    const newRead = extract();
    expect(await oldRead).toBeNull();
    expect(await newRead).toMatchObject({ url: window.location.href, bilibiliSubtitle: { page: 1, cid: 111, text: 'P1 字幕' } });
    finish(json({ body: [{ content: '过期的 P2 字幕' }] }));
    expect((await extract()).bilibiliSubtitle.text).toBe('P1 字幕');
});

it('abandons subtitles on pagehide rather than waiting for the CDN', async () => {
    subtitleResponse = () => new Promise(() => {});
    const reading = extract();
    await vi.waitFor(() => expect(fetch.mock.calls.some(([value]) => value.includes('aisubtitle.hdslb.com'))).toBe(true));
    window.dispatchEvent(new Event('pagehide'));
    expect(await reading).toBeNull();
});

it('keeps normal page content available when there are no accessible subtitles', async () => {
    document.body.innerHTML = '<p>' + '完整视频简介。'.repeat(10) + '</p>';
    fetch.mockImplementation(async (value) => {
        if (value.includes('/x/web-interface/view')) return json({ code: 0, data: { pages: [{ page: 2, cid: 222 }] } });
        if (value.includes('/x/player/wbi/v2')) return json({ code: 0, data: { need_login_subtitle: true, subtitle: { subtitles: [] } } });
        return new Response('/* sidebar CSS */');
    });
    const result = await extract();
    expect(result.content).toContain('完整视频简介');
    expect(result.bilibiliSubtitle).toBeNull();
});
