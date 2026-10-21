export function updateError(code, message, cause) {
    return Object.assign(new Error(message, { cause }), { updateCode: code });
}

export function updateErrorCode(error) {
    if (error?.updateCode) return error.updateCode;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
    // Chromium can reject while consuming the body, after fetch has resolved.
    if (/net::ERR_|network|fetch failed|terminated|ECONN|EAI_AGAIN|ENET/i.test(error?.message || ''))
        return 'network';
    return undefined;
}

export async function requestUpdate(fetch, url, version, timeout = 30000) {
    const signal = AbortSignal.timeout(timeout);
    let response;
    try {
        response = await fetch(url, {
            headers: { 'User-Agent': `Cerebr/${version}`, Accept: 'application/vnd.github+json' },
            signal,
            cache: 'no-store',
        });
    } catch (error) {
        throw updateError(signal.aborted ? 'timeout' : 'network', error.message, error);
    }
    if (!response.ok) {
        const rateLimited = response.status === 429 ||
            (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
        const code = rateLimited ? 'rate_limit' :
            response.status === 408 ? 'timeout' : response.status >= 500 ? 'server' : 'release';
        await response.body?.cancel();
        throw updateError(code, `Update request failed (HTTP ${response.status}, ${new URL(url).hostname})`);
    }
    return response;
}

// Retry the entire operation, including a response body interrupted mid-download.
// Validation failures and rate limits must not cause repeated downloads/requests.
/**
 * @template T
 * @param {() => Promise<T>} operation
 * @param {{sleep?: (ms: number) => Promise<void>, onRetry?: (error: unknown, attempt: number) => unknown}} [options]
 */
export async function retryUpdate(operation, {
    sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    onRetry = () => {},
} = {}) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await operation();
        } catch (error) {
            const code = updateErrorCode(error);
            if (attempt >= 3 || !['network', 'timeout', 'server'].includes(code)) throw error;
            await onRetry(error, attempt);
            await sleep(attempt * 1000);
        }
    }
}
