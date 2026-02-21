export function normalizeChatCompletionsUrl(value) {
    if (typeof value !== 'string') return '';
    const raw = value.trim();
    if (!raw) return '';

    const normalizePath = (pathname) => {
        const withoutTrailingSlash = (pathname || '/').replace(/\/+$/, '');
        const base = withoutTrailingSlash === '/' ? '' : withoutTrailingSlash;
        if (base.endsWith('/chat/completions')) return base || '/chat/completions';
        if (base.endsWith('/v1')) return `${base}/chat/completions`;

        const hasV1Segment = /(^|\/)v1(\/|$)/.test((base || '/') + '/');
        if (!hasV1Segment) return `${base}/v1/chat/completions` || '/v1/chat/completions';

        return base || '/';
    };

    try {
        const url = new URL(raw);
        url.pathname = normalizePath(url.pathname);
        return url.toString();
    } catch {
        const withoutTrailingSlash = raw.replace(/\/+$/, '');
        if (withoutTrailingSlash.endsWith('/chat/completions')) return withoutTrailingSlash;
        if (withoutTrailingSlash.endsWith('/v1')) return `${withoutTrailingSlash}/chat/completions`;
        if (!/\/v1(\/|$)/.test(withoutTrailingSlash)) return `${withoutTrailingSlash}/v1/chat/completions`;
        return withoutTrailingSlash;
    }
}

