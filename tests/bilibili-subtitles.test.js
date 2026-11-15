// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createBilibiliSubtitleExtractor, getBilibiliVideoRef, matchesBilibiliSubtitle, rankBilibiliSubtitles,
} from '../src/runtime/webpage/bilibili-subtitles.js';

const video = 'https://www.bilibili.com/video/BV1xx411c7mD/';
const otherVideo = 'https://www.bilibili.com/video/BV1yy411c7mD/';
const track = (lan, file = lan) => ({ lan, subtitle_url: `//aisubtitle.hdslb.com/${file}.json` });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const body = (...lines) => ({ body: lines.map((content, i) => ({ from: i, to: i + 1, content })) });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
let url, fetchImpl, extractor, player, clock, subtitleResponse;

beforeEach(() => {
    url = video;
    clock = 0;
    player = { subtitle: { subtitles: [track('ai-en'), track('ai-zh')] } };
    subtitleResponse = () => response(body('第一句', '第二句'));
    fetchImpl = vi.fn(async (value) => {
        if (value.includes('/x/web-interface/view')) return response({ code: 0, data: {
            cid: 111, pages: [{ page: 1, cid: 111 }, { page: 2, cid: 222 }],
        } });
        if (value.includes('/x/player/wbi/v2')) return response({ code: 0, data: player });
        return subtitleResponse(value);
    });
    extractor = createBilibiliSubtitleExtractor({ getUrl: () => url, fetchImpl, now: () => clock });
});
afterEach(() => {
    extractor.cancel();
    vi.useRealTimers();
});

describe('Bilibili video identity and language selection', () => {
    it('supports BV videos on desktop and mobile, with a strict current part', () => {
        expect(getBilibiliVideoRef(video)).toEqual({ bvid: 'BV1xx411c7mD', page: 1 });
        expect(getBilibiliVideoRef(video + '?p=2')).toEqual({ bvid: 'BV1xx411c7mD', page: 2 });
        expect(getBilibiliVideoRef('https://m.bilibili.com/video/BV1xx411c7mD?p=3')).toMatchObject({ page: 3 });
        for (const value of [video + '?p=0', video + '?p=2.5', video + '?p=invalid',
            video.replace('bilibili.com', 'bilibili.com.evil.test'),
            video.replace('https:', 'file:'), video + 'invalid', 'https://www.bilibili.com/bangumi/play/ep1']) {
            expect(getBilibiliVideoRef(value)).toBeNull();
        }
    });

    it('filters missing/unsafe URLs before preferring manual Chinese, then AI Chinese', () => {
        const tracks = [track('ai-en'), track('ai-zh'), track('zh-TW'), track('zh-Hans'),
            { lan: 'zh-CN', subtitle_url: '' }, { lan: 'zh-CN', subtitle_url: 'javascript:bad' }, null];
        expect(rankBilibiliSubtitles(tracks).map((item) => item.lan)).toEqual(['zh-Hans', 'zh-TW', 'ai-zh', 'ai-en']);
        expect(rankBilibiliSubtitles(tracks, 'AI-EN')[0].lan).toBe('ai-en');
        expect(rankBilibiliSubtitles([track('zh-CN')])[0].subtitle_url).toMatch(/^https:/);
    });

    it('validates cached subtitles against both the video and the part', () => {
        const subtitle = { bvid: 'BV1xx411c7mD', page: 1, cid: 111, text: '字幕' };
        expect(matchesBilibiliSubtitle(subtitle, video)).toBe(true);
        expect(matchesBilibiliSubtitle(subtitle, video + '?p=2')).toBe(false);
        expect(matchesBilibiliSubtitle(subtitle, otherVideo)).toBe(false);
        expect(matchesBilibiliSubtitle({ ...subtitle, cid: null }, video)).toBe(false);
    });
});

describe('subtitle extraction', () => {
    it('fetches AI Chinese with local login credentials, but omits them on the CDN', async () => {
        expect(await extractor.extract()).toMatchObject({
            bvid: 'BV1xx411c7mD', page: 1, cid: 111, lang: 'ai-zh', text: '第一句\n第二句',
        });
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(fetchImpl.mock.calls.map(([, init]) => init.credentials)).toEqual(['include', 'include', 'omit']);
        expect(fetchImpl.mock.calls[2][0]).toBe('https://aisubtitle.hdslb.com/ai-zh.json');
    });

    it('uses the selected part cid instead of the first part', async () => {
        url += '?p=2';
        expect(await extractor.extract()).toMatchObject({ page: 2, cid: 222 });
        expect(fetchImpl.mock.calls[1][0]).toContain('cid=222');
    });

    it('does not guess P1 when the requested part is missing', async () => {
        url += '?p=3';
        expect(await extractor.extract()).toBeNull();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('accepts a subtitle-only page and skips unavailable preferred tracks', async () => {
        player.subtitle.subtitles.unshift({ lan: 'zh-CN', subtitle_url: '' });
        expect((await extractor.extract()).lang).toBe('ai-zh');
    });

    it('tries the next usable track when the preferred download fails', async () => {
        player.subtitle.subtitles.unshift(track('zh-CN'));
        subtitleResponse = (value) => value.includes('zh-CN') ? response({}, 403) : response(body('AI 中文'));
        expect(await extractor.extract()).toMatchObject({ lang: 'ai-zh', text: 'AI 中文' });
    });

    it('refreshes an expired subtitle URL once', async () => {
        player.subtitle.subtitles = [track('ai-zh', 'expired')];
        subtitleResponse = (value) => {
            if (value.includes('expired')) {
                player.subtitle.subtitles = [track('ai-zh', 'fresh')];
                return response({}, 403);
            }
            return response(body('新地址字幕'));
        };
        expect((await extractor.extract()).text).toBe('新地址字幕');
        expect(fetchImpl.mock.calls.filter(([value]) => value.includes('/x/player/'))).toHaveLength(2);
    });

    it('stops after one refresh if every subtitle URL is broken', async () => {
        player.subtitle.subtitles = [track('ai-zh')];
        subtitleResponse = () => response({}, 403);
        expect(await extractor.extract()).toBeNull();
        expect(fetchImpl).toHaveBeenCalledTimes(5);
    });

    it('does not drop repeated sentences or truncate long subtitles', async () => {
        const text = '文'.repeat(120_000);
        subtitleResponse = () => response(body('重复', '重复', text));
        expect((await extractor.extract()).text).toBe(`重复\n重复\n${text}`);
    });

    it('treats absent subtitles or a login requirement as unavailable, not as text', async () => {
        player = { need_login_subtitle: true, subtitle: { subtitles: [] } };
        expect(await extractor.extract()).toBeNull();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        player.subtitle.subtitles = [track('ai-zh')];
        expect((await extractor.extract()).text).toBe('第一句\n第二句');
    });

    it('handles API errors, invalid JSON, and offline requests without rejecting the page read', async () => {
        fetchImpl.mockResolvedValueOnce(response({ code: -412, message: 'Unavailable' }));
        expect(await extractor.extract()).toBeNull();
        fetchImpl.mockResolvedValueOnce(new Response('not json'));
        expect(await extractor.extract()).toBeNull();
        fetchImpl.mockRejectedValueOnce(new TypeError('Offline'));
        expect(await extractor.extract()).toBeNull();
        expect((await extractor.extract()).text).toContain('第一句');
    });

    it('does not request unrelated pages or fetch an audio transcription', async () => {
        url = 'https://example.test/video/BV1xx411c7mD/';
        expect(await extractor.extract()).toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('cache, request deadlines and navigation', () => {
    it('coalesces concurrent reads and reuses a five-minute cache per video/part', async () => {
        const first = extractor.extract(), second = extractor.extract();
        expect(second).toBe(first);
        const result = await first;
        expect(await extractor.extract()).toBe(result);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        url += '?p=2';
        expect((await extractor.extract()).cid).toBe(222);
        url = video;
        expect(await extractor.extract()).toBe(result);
        expect(fetchImpl).toHaveBeenCalledTimes(6);
        clock = 5 * 60 * 1000;
        await extractor.extract();
        expect(fetchImpl).toHaveBeenCalledTimes(9);
    });

    it('bounds the number of cached videos', async () => {
        for (let p = 1; p <= 9; p++) {
            url = video + `?p=${p}`;
            fetchImpl.mockResolvedValueOnce(response({ code: 0, data: { pages: [{ page: p, cid: p }] } }));
            await extractor.extract();
        }
        url = video;
        fetchImpl.mockClear();
        await extractor.extract();
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('settles the whole read on timeout even if fetch ignores abort', async () => {
        vi.useFakeTimers();
        fetchImpl.mockImplementation(() => new Promise(() => {}));
        const reading = extractor.extract();
        const signal = fetchImpl.mock.calls[0][1].signal;
        await vi.advanceTimersByTimeAsync(6000);
        expect(await reading).toBeNull();
        expect(signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('also bounds a stuck response body', async () => {
        vi.useFakeTimers();
        fetchImpl.mockResolvedValueOnce({ ok: true, json: () => new Promise(() => {}) });
        const reading = extractor.extract();
        await vi.advanceTimersByTimeAsync(6000);
        expect(await reading).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels on SPA navigation and never caches the delayed old result', async () => {
        vi.useFakeTimers();
        const waiting = deferred();
        fetchImpl.mockReturnValueOnce(waiting.promise);
        const reading = extractor.extract();
        url = otherVideo;
        await vi.advanceTimersByTimeAsync(100);
        expect(await reading).toBeNull();
        waiting.resolve(response({ code: 0, data: { cid: 999 } }));
        await Promise.resolve();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect((await extractor.extract()).bvid).toBe('BV1yy411c7mD');
        url = video;
        await extractor.extract();
        expect(fetchImpl).toHaveBeenCalledTimes(7);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels a previous part immediately when a new extraction starts', async () => {
        const waiting = deferred();
        fetchImpl.mockReturnValueOnce(waiting.promise);
        const first = extractor.extract();
        const signal = fetchImpl.mock.calls[0][1].signal;
        url += '?p=2';
        expect((await extractor.extract()).cid).toBe(222);
        expect(await first).toBeNull();
        expect(signal.aborted).toBe(true);
    });

    it('cleans up an explicitly cancelled request and can try again', async () => {
        fetchImpl.mockImplementationOnce(() => new Promise(() => {}));
        const reading = extractor.extract();
        extractor.cancel();
        expect(await reading).toBeNull();
        expect((await extractor.extract()).text).toContain('第一句');
    });
});
