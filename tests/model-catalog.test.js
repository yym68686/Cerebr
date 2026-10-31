import { afterEach, expect, it, vi } from 'vitest';
import { modelsUrl } from '../src/utils/api-url.js';
import { fetchModelNames } from '../src/runtime/chat/model-catalog.js';

afterEach(() => vi.unstubAllGlobals());

it.each([
    ['https://api.test', 'https://api.test/v1/models'],
    ['https://api.test/', 'https://api.test/v1/models'],
    ['https://api.test/v1/', 'https://api.test/v1/models'],
    ['https://api.test/v1/chat/completions', 'https://api.test/v1/models'],
    [
        'https://api.test/proxy/v1/chat/completions?tenant=one#hash',
        'https://api.test/proxy/v1/models?tenant=one',
    ],
    ['http://localhost:8080/openai', 'http://localhost:8080/openai/v1/models'],
])('derives models endpoint from %s', (base, expected) => {
    expect(modelsUrl(base)).toBe(expected);
});

it('authenticates discovery and returns unique valid names in provider order', async () => {
    const fetch = vi.fn(
        async () =>
            new Response(
                JSON.stringify({
                    data: [
                        { id: 'first' },
                        { id: 'second' },
                        { id: 'first' },
                        { id: '' },
                        { id: 42 },
                        null,
                        { name: 'not-an-id' },
                        { id: ' trimmed ' },
                    ],
                })
            )
    );
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    expect(
        await fetchModelNames({ baseUrl: 'https://api.test/v1', apiKey: ' test-only ' }, controller.signal)
    ).toEqual(['first', 'second', 'trimmed']);
    expect(fetch).toHaveBeenCalledWith('https://api.test/v1/models', {
        headers: { Authorization: 'Bearer test-only' },
        signal: controller.signal,
    });
});

it.each([401, 404, 500])('returns no suggestions for HTTP %d without throwing', async (status) => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('Not available', { status }))
    );
    expect(await fetchModelNames({ baseUrl: 'https://api.test/v1', apiKey: 'test' })).toEqual([]);
});

it('silently handles network failures, aborts, invalid JSON and unexpected shapes', async () => {
    const fetch = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'))
        .mockResolvedValueOnce(new Response('<html>not json</html>'))
        .mockResolvedValueOnce(new Response('{"data":{}}'));
    vi.stubGlobal('fetch', fetch);
    for (let i = 0; i < 4; i++)
        expect(await fetchModelNames({ baseUrl: 'https://api.test/v1', apiKey: 'test' })).toEqual([]);
    expect(await fetchModelNames({ baseUrl: 'javascript:alert(1)', apiKey: 'test' })).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(4);
});
