/**
 * Minimal Model Context Protocol client for browser extension pages.
 *
 * Supports:
 * - Streamable HTTP transport (JSON or SSE responses, Mcp-Session-Id, session re-init on 404)
 * - Legacy HTTP+SSE transport (GET event stream + POST endpoint)
 *
 * Runs anywhere a WHATWG fetch is available (extension pages, service workers, Node 18+).
 */

export const MCP_LATEST_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_REQUEST_TIMEOUT_MS = 60000;

export class McpError extends Error {
    constructor(message, { code = null, data = null, status = null, cause = null } = {}) {
        super(message);
        this.name = 'McpError';
        this.code = code;
        this.data = data;
        this.status = status;
        if (cause) this.cause = cause;
    }
}

function isAbortLike(error) {
    return error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

function combineSignals(signals) {
    const list = signals.filter(Boolean);
    if (list.length === 0) return undefined;
    if (list.length === 1) return list[0];
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
        return AbortSignal.any(list);
    }
    const controller = new AbortController();
    for (const signal of list) {
        if (signal.aborted) {
            controller.abort(signal.reason);
            break;
        }
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    return controller.signal;
}

function truncate(text, max = 600) {
    const value = String(text ?? '');
    return value.length > max ? value.slice(0, max) + '…' : value;
}

function httpError(status, body) {
    return new McpError('HTTP ' + status + (body ? ': ' + body : ''), { status });
}

/**
 * Incremental Server-Sent Events parser over a fetch Response body.
 * Cancels the underlying reader when the consumer stops iterating.
 */
export async function* readServerSentEvents(response) {
    const reader = response.body?.getReader?.();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName = 'message';
    let dataLines = [];
    let eventId = null;

    const dispatch = () => {
        const event = dataLines.length
            ? { event: eventName || 'message', data: dataLines.join('\n'), id: eventId }
            : null;
        eventName = 'message';
        dataLines = [];
        eventId = null;
        return event;
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                buffer += decoder.decode();
            } else {
                buffer += decoder.decode(value, { stream: true });
            }

            while (true) {
                const match = /\r\n|\r|\n/.exec(buffer);
                if (!match) break;
                // A trailing lone CR may be the first half of a CRLF split across chunks.
                if (match[0] === '\r' && match.index === buffer.length - 1 && !done) break;
                const line = buffer.slice(0, match.index);
                buffer = buffer.slice(match.index + match[0].length);

                if (line === '') {
                    const event = dispatch();
                    if (event) yield event;
                    continue;
                }
                if (line.startsWith(':')) continue;

                const colon = line.indexOf(':');
                const field = colon === -1 ? line : line.slice(0, colon);
                let fieldValue = colon === -1 ? '' : line.slice(colon + 1);
                if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);

                if (field === 'event') eventName = fieldValue;
                else if (field === 'data') dataLines.push(fieldValue);
                else if (field === 'id') eventId = fieldValue;
            }

            if (done) {
                if (buffer.startsWith('data:')) {
                    dataLines.push(buffer.slice(5).replace(/^ /, ''));
                }
                buffer = '';
                const event = dispatch();
                if (event) yield event;
                return;
            }
        }
    } finally {
        try {
            await reader.cancel();
        } catch {
            // ignore
        }
    }
}

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

async function readErrorBody(response) {
    try {
        return truncate(await response.text(), 800);
    } catch {
        return '';
    }
}

async function discardBody(response) {
    try {
        await response.body?.cancel?.();
    } catch {
        // ignore
    }
}

function isResponseFor(item, id) {
    return !!item && item.id === id && ('result' in item || 'error' in item);
}

class StreamableHttpTransport {
    constructor({ url, headers = {}, fetchImpl }) {
        this.url = url;
        this.headers = { ...headers };
        this.fetch = fetchImpl;
        this.sessionId = null;
        this.protocolVersion = null;
    }

    buildHeaders() {
        const headers = {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...this.headers,
        };
        if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
        if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;
        return headers;
    }

    resetSession() {
        this.sessionId = null;
        this.protocolVersion = null;
    }

    async post(message, signal) {
        const response = await this.fetch(this.url, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(message),
            signal,
            cache: 'no-store',
        });
        const sessionId = response.headers.get('mcp-session-id');
        if (sessionId) this.sessionId = sessionId;
        if (!response.ok) {
            throw httpError(response.status, await readErrorBody(response));
        }
        return response;
    }

    async notify(message, { signal } = {}) {
        const response = await this.post(message, signal);
        await discardBody(response);
    }

    async respond(message) {
        try {
            await this.notify(message);
        } catch {
            // best effort
        }
    }

    async request(message, { signal, onMessage } = {}) {
        const response = await this.post(message, signal);
        const contentType = String(response.headers.get('content-type') || '').toLowerCase();

        if (contentType.includes('text/event-stream')) {
            for await (const event of readServerSentEvents(response)) {
                if (!event.data) continue;
                const payload = parseJson(event.data);
                if (!payload) continue;
                const items = Array.isArray(payload) ? payload : [payload];
                for (const item of items) {
                    if (isResponseFor(item, message.id)) return item;
                    await onMessage?.(item);
                }
            }
            throw new McpError('MCP 服务器在返回结果前关闭了事件流');
        }

        if (response.status === 202 || response.status === 204) {
            throw new McpError('MCP 服务器没有返回结果（HTTP ' + response.status + '）');
        }

        const text = await response.text();
        const payload = parseJson(text);
        if (!payload) {
            throw new McpError('MCP 服务器返回了无法解析的响应：' + truncate(text, 200));
        }
        const items = Array.isArray(payload) ? payload : [payload];
        let matched = null;
        for (const item of items) {
            if (isResponseFor(item, message.id)) {
                matched = item;
            } else {
                await onMessage?.(item);
            }
        }
        if (!matched) {
            throw new McpError('MCP 服务器响应中没有匹配的请求 ID');
        }
        return matched;
    }

    async close() {
        if (!this.sessionId) return;
        const headers = this.buildHeaders();
        this.resetSession();
        try {
            const response = await this.fetch(this.url, { method: 'DELETE', headers });
            await discardBody(response);
        } catch {
            // ignore
        }
    }
}

class LegacySseTransport {
    constructor({ url, headers = {}, fetchImpl }) {
        this.url = url;
        this.headers = { ...headers };
        this.fetch = fetchImpl;
        this.endpoint = null;
        this.pending = new Map();
        this.streamController = null;
        this.startPromise = null;
        this.protocolVersion = null;
        this.sessionId = null;
        this.onMessage = null;
    }

    resetSession() {
        void this.close();
    }

    async start(signal) {
        if (this.endpoint) return;
        if (!this.startPromise) {
            this.startPromise = this.openStream(signal);
        }
        try {
            await this.startPromise;
        } catch (error) {
            this.startPromise = null;
            throw error;
        }
    }

    async openStream(signal) {
        const controller = new AbortController();
        this.streamController = controller;
        const onAbort = () => controller.abort(signal.reason);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
        try {
        const response = await this.fetch(this.url, {
            method: 'GET',
            headers: { Accept: 'text/event-stream', ...this.headers },
            signal: controller.signal,
            cache: 'no-store',
        });
        if (!response.ok) {
            throw httpError(response.status, await readErrorBody(response));
        }

        const iterator = readServerSentEvents(response);
        while (true) {
            const { value, done } = await iterator.next();
            if (done) throw new McpError('SSE 连接在收到 endpoint 之前已关闭');
            if (value.event === 'endpoint') {
                const endpoint = new URL(value.data.trim(), this.url);
                if (endpoint.origin !== new URL(this.url).origin || endpoint.username || endpoint.password) {
                    await iterator.return();
                    throw new McpError('拒绝将 MCP 认证请求头发送到跨域 SSE endpoint');
                }
                this.endpoint = endpoint.toString();
                break;
            }
        }

        void this.pump(iterator);
        } finally {
            // The initialize request timeout must not kill the long-lived SSE stream later.
            signal?.removeEventListener('abort', onAbort);
        }
    }

    async pump(iterator) {
        try {
            while (true) {
                const { value: event, done } = await iterator.next();
                if (done) break;
                if (event.event !== 'message' || !event.data) continue;
                const payload = parseJson(event.data);
                if (!payload) continue;
                const items = Array.isArray(payload) ? payload : [payload];
                for (const item of items) {
                    if (item && item.id !== undefined && ('result' in item || 'error' in item)) {
                        const waiter = this.pending.get(item.id);
                        if (waiter) {
                            this.pending.delete(item.id);
                            waiter.resolve(item);
                        }
                    } else {
                        await this.onMessage?.(item);
                    }
                }
            }
        } catch (error) {
            if (!isAbortLike(error)) {
                console.warn('[Cerebr MCP] SSE stream error', error);
            }
        } finally {
            this.endpoint = null;
            this.startPromise = null;
            const closedError = new McpError('MCP SSE 连接已断开');
            for (const waiter of this.pending.values()) waiter.reject(closedError);
            this.pending.clear();
        }
    }

    async postMessage(message, signal) {
        await this.start(signal);
        const response = await this.fetch(this.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...this.headers },
            body: JSON.stringify(message),
            signal,
        });
        if (!response.ok) {
            throw httpError(response.status, await readErrorBody(response));
        }
        await discardBody(response);
    }

    async notify(message, { signal } = {}) {
        await this.postMessage(message, signal);
    }

    async respond(message) {
        try {
            await this.postMessage(message);
        } catch {
            // ignore
        }
    }

    async request(message, { signal, onMessage } = {}) {
        if (onMessage) this.onMessage = onMessage;
        await this.start(signal);
        if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
        let cleanup = () => {};
        const resultPromise = new Promise((resolve, reject) => {
            const onAbort = () => {
                if (!this.pending.has(message.id)) return;
                this.pending.delete(message.id);
                const reason = signal.reason;
                reject(reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError'));
            };
            cleanup = () => signal?.removeEventListener('abort', onAbort);
            this.pending.set(message.id, {
                resolve: (value) => { cleanup(); resolve(value); },
                reject: (error) => { cleanup(); reject(error); },
            });
            signal?.addEventListener('abort', onAbort, { once: true });
        });
        // POST and event-stream failures may race; consume rejection before awaiting the POST.
        resultPromise.catch(() => {});
        try {
            await this.postMessage(message, signal);
        } catch (error) {
            this.pending.delete(message.id);
            cleanup();
            throw error;
        }
        return resultPromise;
    }

    async close() {
        this.streamController?.abort();
        this.streamController = null;
        this.endpoint = null;
        this.startPromise = null;
    }
}

export class McpClient {
    constructor({
        url,
        transport = 'http',
        headers = {},
        fetchImpl = (...args) => fetch(...args),
        clientInfo = { name: 'Cerebr-MCP', version: '1.0.0' },
    } = {}) {
        if (!url) throw new McpError('MCP 服务器 URL 不能为空');
        this.url = url;
        this.clientInfo = clientInfo;
        const TransportClass = transport === 'sse' ? LegacySseTransport : StreamableHttpTransport;
        this.transport = new TransportClass({ url, headers, fetchImpl });
        this.nextId = 1;
        this.initPromise = null;
        this.ready = false;
        this.serverInfo = null;
        this.serverCapabilities = null;
        this.instructions = '';
        this.progressHandlers = new Map();
    }

    async handleIncoming(message) {
        if (!message || typeof message !== 'object') return;
        if (message.method === 'notifications/progress') {
            const handler = this.progressHandlers.get(message.params?.progressToken);
            try {
                handler?.(message.params);
            } catch {
                // ignore
            }
            return;
        }
        if (message.method && message.id !== undefined) {
            const reply = message.method === 'ping'
                ? { jsonrpc: '2.0', id: message.id, result: {} }
                : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported by client' } };
            void this.transport.respond(reply);
        }
    }

    async connect({ signal } = {}) {
        if (this.ready) return;
        if (!this.initPromise) {
            this.initPromise = (async () => {
                const result = await this.rawRequest('initialize', {
                    protocolVersion: MCP_LATEST_PROTOCOL_VERSION,
                    capabilities: {},
                    clientInfo: this.clientInfo,
                }, { signal, timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS });
                this.serverInfo = result?.serverInfo || null;
                this.serverCapabilities = result?.capabilities || {};
                this.instructions = typeof result?.instructions === 'string' ? result.instructions : '';
                this.transport.protocolVersion = result?.protocolVersion || MCP_LATEST_PROTOCOL_VERSION;
                await this.transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' }, { signal });
                this.ready = true;
            })();
        }
        try {
            await this.initPromise;
        } catch (error) {
            this.initPromise = null;
            this.ready = false;
            this.transport.resetSession();
            throw error;
        }
    }

    async rawRequest(method, params = {}, { signal, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, onProgress } = {}) {
        const id = this.nextId++;
        const nextParams = { ...(params || {}) };
        if (typeof onProgress === 'function') {
            nextParams._meta = { ...(nextParams._meta || {}), progressToken: id };
            this.progressHandlers.set(id, onProgress);
        }
        const timeoutSignal = timeoutMs > 0 && typeof AbortSignal?.timeout === 'function'
            ? AbortSignal.timeout(timeoutMs)
            : null;
        const combined = combineSignals([signal, timeoutSignal]);
        try {
            const response = await this.transport.request(
                { jsonrpc: '2.0', id, method, params: nextParams },
                { signal: combined, onMessage: (message) => this.handleIncoming(message) }
            );
            if (response.error) {
                throw new McpError(response.error.message || ('MCP 错误 ' + response.error.code), {
                    code: response.error.code,
                    data: response.error.data,
                });
            }
            return response.result;
        } catch (error) {
            if (signal?.aborted) {
                if (this.ready) {
                    void this.transport.respond({
                        jsonrpc: '2.0',
                        method: 'notifications/cancelled',
                        params: { requestId: id, reason: 'User aborted' },
                    });
                }
                throw error;
            }
            if (timeoutSignal?.aborted || error?.name === 'TimeoutError') {
                throw new McpError('MCP 请求超时（' + Math.round(timeoutMs / 1000) + ' 秒）', { cause: error });
            }
            if (error instanceof McpError) throw error;
            throw new McpError('无法连接 MCP 服务器：' + (error?.message || error), { cause: error });
        } finally {
            this.progressHandlers.delete(id);
        }
    }

    async request(method, params, options = {}) {
        await this.connect({ signal: options.signal });
        try {
            return await this.rawRequest(method, params, options);
        } catch (error) {
            // Streamable HTTP: an expired session answers 404 -> re-initialize once.
            const sessionExpired = error instanceof McpError && error.status === 404;
            if (sessionExpired && !options.signal?.aborted) {
                this.ready = false;
                this.initPromise = null;
                this.transport.resetSession();
                await this.connect({ signal: options.signal });
                return this.rawRequest(method, params, options);
            }
            throw error;
        }
    }

    async listTools({ signal } = {}) {
        const tools = [];
        let cursor;
        let pages = 0;
        do {
            const result = await this.request('tools/list', cursor ? { cursor } : {}, { signal, timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS });
            if (Array.isArray(result?.tools)) tools.push(...result.tools);
            cursor = result?.nextCursor;
            pages += 1;
        } while (cursor && pages < 50);
        return tools;
    }

    async callTool(name, args = {}, { signal, timeoutMs = 900000, onProgress } = {}) {
        return this.request('tools/call', { name, arguments: args ?? {} }, { signal, timeoutMs, onProgress });
    }

    async close() {
        this.ready = false;
        this.initPromise = null;
        await this.transport.close();
    }
}
