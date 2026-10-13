import { readServerSentEvents } from '../../mcp/mcp-client.js';

export function isResponsesUrl(url) {
    try { return /\/responses\/?$/.test(new URL(url).pathname); } catch { return false; }
}

function contentParts(content, role) {
    if (typeof content === 'string') return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }];
    return (Array.isArray(content) ? content : []).flatMap(part => {
        if (part.type === 'text') return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text || '' }];
        if (part.type === 'image_url') return [{ type: 'input_image', image_url: part.image_url?.url || '', detail: part.image_url?.detail || 'auto' }];
        return [];
    });
}

/** Preserve the existing chat UI; only translate its API transcript at the wire boundary. */
export function toResponsesBody(body) {
    const input = [];
    for (const message of body.messages || []) {
        if (message.role === 'tool') {
            input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: String(message.content ?? '') });
            continue;
        }
        const role = message.role === 'system' ? 'developer' : message.role;
        const content = contentParts(message.content, role);
        if (content.length) input.push({ type: 'message', role, content });
        // Encrypted reasoning from the current GPT turn only; never replay Claude IDs.
        for (const item of message.reasoning_items || []) {
            if (item.type === 'reasoning' && item.encrypted_content) input.push(item);
        }
        for (const call of message.tool_calls || []) {
            input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments || '{}' });
        }
    }
    const result = { model: body.model, input, stream: true, store: false, include: ['reasoning.encrypted_content'] };
    if (body.reasoning) result.reasoning = body.reasoning;
    if (body.service_tier) result.service_tier = body.service_tier;
    if (body.temperature !== undefined) result.temperature = body.temperature;
    if (body.top_p !== undefined) result.top_p = body.top_p;
    if (body.max_tokens !== undefined) result.max_output_tokens = body.max_tokens;
    if (Array.isArray(body.tools)) result.tools = body.tools.map(tool => ({
        type: 'function', name: tool.function.name, description: tool.function.description,
        parameters: tool.function.parameters, strict: false,
    }));
    if (body.tool_choice) result.tool_choice = typeof body.tool_choice === 'string'
        ? body.tool_choice : { type: 'function', name: body.tool_choice.function?.name || body.tool_choice.name };
    return result;
}

async function sniffResponse(response) {
    // Some compatible gateways label native SSE as application/json. Sniff the actual
    // first non-whitespace byte without buffering the response or losing stream chunks.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Responses 返回了空响应体');
    const chunks = [];
    const decoder = new TextDecoder();
    let prefix = '';
    while (!prefix.trim()) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        prefix += decoder.decode(value, { stream: true });
    }
    const first = prefix.trimStart()[0];
    const isSse = first !== '{' && first !== '[';
    const body = new ReadableStream({
        async pull(controller) {
            if (chunks.length) { controller.enqueue(chunks.shift()); return; }
            const { value, done } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
        },
        cancel(reason) { return reader.cancel(reason); },
    });
    return { isSse, response: new Response(body) };
}

/** Normalize native Responses SSE (and JSON fallback) into the existing Chat Completions reader. */
export function adaptResponsesResponse(response) {
    const encoder = new TextEncoder();
    let iterator;
    let cancelled = false;
    const calls = new Map();
    const finishedCalls = new Set();
    const finishedMessages = new Set();
    const reasoning = new Set();
    let textSeen = false;
    const stream = new ReadableStream({
        async start(controller) {
            const emit = delta => { if (!cancelled) controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n')); };
            const emitError = error => { if (!cancelled) controller.enqueue(encoder.encode('data: ' + JSON.stringify({ error }) + '\n\n')); };
            const addCall = item => {
                const key = item.id || item.call_id;
                let call = calls.get(key);
                if (!call) {
                    call = { index: calls.size, arguments: '' };
                    calls.set(key, call);
                    emit({ tool_calls: [{ index: call.index, id: item.call_id || item.id, type: 'function', function: { name: item.name, arguments: '' } }] });
                }
                return call;
            };
            const finishItem = item => {
                if (item.type === 'function_call') {
                    const key = item.id || item.call_id;
                    if (finishedCalls.has(key)) return;
                    const call = addCall(item);
                    if (!call.arguments && item.arguments) {
                        call.arguments = item.arguments;
                        emit({ tool_calls: [{ index: call.index, function: { arguments: item.arguments } }] });
                    }
                    finishedCalls.add(key);
                } else if (item.type === 'reasoning' && item.encrypted_content && !reasoning.has(item.id)) {
                    reasoning.add(item.id);
                    emit({ reasoning_items: [item] });
                } else if (item.type === 'message' && !textSeen) {
                    if (item.id && finishedMessages.has(item.id)) return;
                    if (item.id) finishedMessages.add(item.id);
                    const text = (item.content || []).filter(part => part.type === 'output_text').map(part => part.text || '').join('');
                    if (text) { emit({ content: text }); }
                }
            };
            const complete = data => {
                for (const item of data.output || []) finishItem(item);
                if (data.error || data.status === 'failed' || data.status === 'incomplete') {
                    emitError(data.error || { message: 'Responses 请求未完成：' + (data.incomplete_details?.reason || data.status) });
                }
            };
            try {
                const detected = await sniffResponse(response);
                if (!detected.isSse) {
                    complete(await detected.response.json());
                } else {
                    iterator = readServerSentEvents(detected.response);
                    let completed = false;
                    for await (const event of iterator) {
                        if (cancelled) break;
                        if (!event.data || event.data === '[DONE]') continue;
                        const data = JSON.parse(event.data);
                        const type = data.type || event.event;
                        if (type === 'response.output_text.delta') { textSeen = true; emit({ content: data.delta || '' }); }
                        else if (type === 'response.reasoning_summary_text.delta') emit({ reasoning_content: data.delta || '' });
                        else if (type === 'response.output_item.added' && data.item?.type === 'function_call') addCall(data.item);
                        else if (type === 'response.function_call_arguments.delta') {
                            const call = calls.get(data.item_id);
                            if (call) {
                                call.arguments += data.delta || '';
                                emit({ tool_calls: [{ index: call.index, function: { arguments: data.delta || '' } }] });
                            }
                        } else if (type === 'response.output_item.done' && data.item) finishItem(data.item);
                        else if (type === 'response.completed' || type === 'response.incomplete') {
                            completed = true;
                            complete(data.response || {});
                            break;
                        }
                        else if (type === 'response.failed' || type === 'error' || data.error) {
                            completed = true;
                            emitError(data.response?.error || data.error || { message: data.message || 'Responses 流式请求失败' });
                            break;
                        }
                    }
                    if (!completed && !cancelled) emitError({ message: 'Responses 连接在 response.completed 之前断开' });
                }
                if (!cancelled) {
                    controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: calls.size ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n'));
                    controller.close();
                }
            } catch (error) { if (!cancelled) controller.error(error); }
        },
        async cancel() {
            cancelled = true;
            await iterator?.return?.();
        },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}
