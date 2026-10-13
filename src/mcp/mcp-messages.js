/**
 * Expand Cerebr chat messages that carry MCP tool calls into an OpenAI Chat Completions transcript.
 *
 * Stored assistant message shape:
 *   { role: 'assistant', content, reasoning_content, toolCalls: [{ id, name, arguments, round, offset,
 *     status, result: { text, images: [{ mimeType, dataUrl }], isError }, reasoningDetails? }] }
 * "offset" is the length of message.content when that round's tool calls were emitted, which lets us
 * split the visible text back into per-round assistant turns.
 */

const LIVE_RESULT_CHAR_LIMIT = 120000;
const HISTORY_RESULT_CHAR_LIMIT = 12000;

function clip(text, limit) {
    const value = String(text ?? '');
    if (value.length <= limit) return value;
    return value.slice(0, limit) + '\n…[已截断，原始长度 ' + value.length + ' 字符]';
}

export function describeToolCallOutcome(call, { limit = LIVE_RESULT_CHAR_LIMIT } = {}) {
    const status = call?.status;
    if (status === 'denied') return '用户拒绝执行此工具调用。';
    if (status === 'skipped') return call?.result?.text || '已跳过此工具调用。';
    if (status === 'cancelled') return '工具调用已被用户中断。';
    if (status === 'running' || status === 'pending_approval' || !call?.result) return '工具调用未完成（已中断）。';
    const text = clip(call.result.text, limit);
    if (call.result.isError || status === 'error') return '工具执行出错：\n' + text;
    return text;
}

function groupByRound(toolCalls) {
    const rounds = new Map();
    toolCalls.forEach((call) => {
        const round = Number(call?.round) || 1;
        if (!rounds.has(round)) rounds.set(round, []);
        rounds.get(round).push(call);
    });
    return [...rounds.entries()].sort((a, b) => a[0] - b[0]).map(([, calls]) => calls);
}

export function hasToolCalls(message) {
    return message?.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0;
}

function expandAssistant(message, { live, sendToolImages }) {
    const content = typeof message.content === 'string' ? message.content : '';
    const rounds = groupByRound(message.toolCalls);
    const output = [];
    let cursor = 0;

    rounds.forEach((calls) => {
        const offset = Math.max(cursor, Math.min(content.length, Number(calls[0]?.offset) || 0));
        const text = content.slice(cursor, offset).trim();
        cursor = offset;

        const assistantTurn = {
            role: 'assistant',
            content: text || null,
            tool_calls: calls.map((call) => ({
                id: call.id,
                type: 'function',
                function: {
                    name: call.name,
                    arguments: typeof call.arguments === 'string' && call.arguments.trim() ? call.arguments : '{}',
                },
            })),
        };
        const reasoningDetails = calls.find((call) => Array.isArray(call.reasoningDetails))?.reasoningDetails;
        if (live && reasoningDetails) {
            assistantTurn.reasoning_details = reasoningDetails;
        }
        const reasoningItems = calls.find((call) => Array.isArray(call.reasoningItems))?.reasoningItems;
        if (live && reasoningItems) assistantTurn.reasoning_items = reasoningItems;
        output.push(assistantTurn);

        const images = [];
        calls.forEach((call) => {
            output.push({
                role: 'tool',
                tool_call_id: call.id,
                content: describeToolCallOutcome(call, { limit: live ? LIVE_RESULT_CHAR_LIMIT : HISTORY_RESULT_CHAR_LIMIT }),
            });
            const callImages = Array.isArray(call?.result?.images) ? call.result.images : [];
            callImages.forEach((image) => {
                if (image?.dataUrl) images.push({ name: call.name, dataUrl: image.dataUrl });
            });
        });

        if (live && sendToolImages && images.length > 0) {
            output.push({
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: '[系统附注] 上面的工具调用返回了 ' + images.length + ' 张图片，按顺序附在下面供你查看（这不是用户的新问题）。',
                    },
                    ...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
                ],
            });
        }
    });

    const trailing = content.slice(cursor).trim();
    if (trailing) {
        output.push({ role: 'assistant', content: trailing });
    }
    return output;
}

/**
 * @param {Array} messages Cerebr messages (role/content plus optional toolCalls)
 * @param {{ withTools: boolean, sendToolImages?: boolean }} options
 *   withTools=false collapses tool turns to plain assistant text (no tool definitions in request).
 */
export function expandMessagesForApi(messages, { withTools = false, sendToolImages = true, allowedToolNames = null } = {}) {
    const output = [];
    (Array.isArray(messages) ? messages : []).forEach((message) => {
        if (!message) return;
        if (hasToolCalls(message)) {
            if (withTools) {
                const visible = allowedToolNames instanceof Set
                    ? { ...message, toolCalls: message.toolCalls.filter(call => allowedToolNames.has(call.name)) }
                    : message;
                if (hasToolCalls(visible)) {
                    output.push(...expandAssistant(visible, { live: !!message.__mcpLive, sendToolImages }));
                } else if (typeof message.content === 'string' && message.content.trim()) {
                    output.push({ role: 'assistant', content: message.content });
                }
            } else if (typeof message.content === 'string' && message.content.trim()) {
                output.push({ role: 'assistant', content: message.content });
            }
            return;
        }
        output.push(message);
    });
    return output;
}
