import { resolveToolApproval } from './mcp-runtime.js';
import { showImagePreview } from '../utils/ui.js';
import { getActiveLocale } from '../utils/i18n.js';

const DISPLAY_CHAR_LIMIT = 8000;
const openCards = new Set();
let listenersInstalled = false;

function isChinese() {
    try {
        return String(getActiveLocale() || '').startsWith('zh');
    } catch {
        return true;
    }
}

function L(zh, en) {
    return isChinese() ? zh : en;
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

const TOOL_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true"><path d="M10.2 2.2a3.2 3.2 0 0 0-3.9 4.2L2.4 10.3a1.3 1.3 0 0 0 1.8 1.8l3.9-3.9a3.2 3.2 0 0 0 4.2-3.9l-1.9 1.9-1.6-.4-.4-1.6 1.8-2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
const CHEVRON_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function statusInfo(status) {
    switch (status) {
        case 'running': return { cls: 'is-running', label: L('调用中', 'Running') };
        case 'pending_approval': return { cls: 'is-pending', label: L('等待确认', 'Needs approval') };
        case 'done': return { cls: 'is-done', label: L('完成', 'Done') };
        case 'error': return { cls: 'is-error', label: L('出错', 'Error') };
        case 'denied': return { cls: 'is-denied', label: L('已拒绝', 'Denied') };
        case 'cancelled': return { cls: 'is-cancelled', label: L('已中断', 'Cancelled') };
        case 'skipped': return { cls: 'is-skipped', label: L('已跳过', 'Skipped') };
        default: return { cls: 'is-running', label: String(status || '') };
    }
}

function prettyArguments(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return '{}';
    try {
        return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
        return text;
    }
}

function clipForDisplay(text) {
    const value = String(text ?? '');
    if (value.length <= DISPLAY_CHAR_LIMIT) return value;
    return value.slice(0, DISPLAY_CHAR_LIMIT) + '\n…' + L('（仅显示前 ' + DISPLAY_CHAR_LIMIT + ' 字符，共 ' + value.length + ' 字符）', ' (showing first ' + DISPLAY_CHAR_LIMIT + ' of ' + value.length + ' chars)');
}

function formatDuration(call) {
    if (!call?.startedAt || !call?.endedAt) return '';
    const seconds = Math.max(0, (call.endedAt - call.startedAt) / 1000);
    return seconds < 10 ? seconds.toFixed(1) + 's' : Math.round(seconds) + 's';
}

function installListeners() {
    if (listenersInstalled || typeof document === 'undefined') return;
    listenersInstalled = true;

    document.addEventListener('toggle', (event) => {
        const card = event.target;
        if (!card?.classList?.contains?.('mcp-tool-card')) return;
        const callId = card.dataset.callId;
        if (!callId) return;
        if (card.open) openCards.add(callId);
        else openCards.delete(callId);
    }, true);

    document.addEventListener('click', (event) => {
        const button = event.target?.closest?.('[data-mcp-approval]');
        if (button) {
            event.preventDefault();
            event.stopPropagation();
            const handled = resolveToolApproval(button.dataset.callId, button.dataset.mcpApproval);
            const bar = button.closest('.mcp-tool-approval');
            if (bar) {
                bar.classList.add('is-resolved');
                bar.querySelectorAll('button').forEach((item) => { item.disabled = true; });
                if (!handled) {
                    const note = bar.querySelector('.mcp-tool-approval-text');
                    if (note) note.textContent = L('该请求已结束', 'This request has ended');
                }
            }
            return;
        }
        const image = event.target?.closest?.('.mcp-tool-image');
        if (image) {
            event.preventDefault();
            event.stopPropagation();
            const previewModal = document.querySelector('.image-preview-modal');
            const previewImage = previewModal?.querySelector?.('img');
            if (previewModal && previewImage) {
                showImagePreview({ base64Data: image.getAttribute('src'), config: { previewModal, previewImage } });
            }
        }
    }, true);
}

function createApprovalBar(call) {
    const bar = el('div', 'mcp-tool-approval');
    bar.appendChild(el('span', 'mcp-tool-approval-text', L('允许执行这个工具吗？', 'Allow this tool call?')));
    const actions = el('span', 'mcp-tool-approval-actions');
    [
        ['allow', L('允许', 'Allow'), 'is-primary'],
        ['always', L('始终允许此工具', 'Always allow'), ''],
        ['deny', L('拒绝', 'Deny'), 'is-danger'],
    ].forEach(([decision, label, cls]) => {
        const button = el('button', 'mcp-tool-approval-button' + (cls ? ' ' + cls : ''), label);
        button.type = 'button';
        button.dataset.mcpApproval = decision;
        button.dataset.callId = call.id;
        actions.appendChild(button);
    });
    bar.appendChild(actions);
    return bar;
}

function createToolItem(call) {
    const status = statusInfo(call.status);
    const item = el('div', 'mcp-tool-item');
    const card = document.createElement('details');
    card.className = 'mcp-tool-card ' + status.cls;
    card.dataset.callId = call.id;
    if (openCards.has(call.id)) card.open = true;

    const summary = el('summary', 'mcp-tool-summary');
    const icon = el('span', 'mcp-tool-icon');
    icon.innerHTML = TOOL_ICON;
    summary.appendChild(icon);

    const title = el('span', 'mcp-tool-title');
    title.appendChild(el('span', 'mcp-tool-name', call.toolName || call.name || 'tool'));
    if (call.serverName) title.appendChild(el('span', 'mcp-tool-server', call.serverName));
    summary.appendChild(title);

    const statusNode = el('span', 'mcp-tool-status');
    if (call.status === 'running') statusNode.appendChild(el('span', 'mcp-tool-spinner'));
    statusNode.appendChild(el('span', 'mcp-tool-status-label', status.label));
    const duration = formatDuration(call);
    if (duration) statusNode.appendChild(el('span', 'mcp-tool-duration', duration));
    summary.appendChild(statusNode);

    const chevron = el('span', 'mcp-tool-chevron');
    chevron.innerHTML = CHEVRON_ICON;
    summary.appendChild(chevron);
    card.appendChild(summary);

    const body = el('div', 'mcp-tool-body');
    body.appendChild(el('div', 'mcp-tool-section-label', L('参数', 'Arguments')));
    body.appendChild(el('pre', 'mcp-tool-pre', clipForDisplay(prettyArguments(call.arguments))));
    if (call.result) {
        body.appendChild(el('div', 'mcp-tool-section-label', L('结果', 'Result')));
        body.appendChild(el('pre', 'mcp-tool-pre' + (call.result.isError ? ' is-error' : ''), clipForDisplay(call.result.text)));
        const images = Array.isArray(call.result.images) ? call.result.images : [];
        if (images.length > 0) {
            const gallery = el('div', 'mcp-tool-images');
            images.forEach((image) => {
                if (!image?.dataUrl) return;
                const img = document.createElement('img');
                img.className = 'mcp-tool-image';
                img.src = image.dataUrl;
                img.alt = call.toolName || 'tool image';
                img.loading = 'lazy';
                gallery.appendChild(img);
            });
            body.appendChild(gallery);
        }
    }
    card.appendChild(body);
    item.appendChild(card);

    if (call.status === 'pending_approval') {
        item.appendChild(createApprovalBar(call));
    }
    return item;
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

/**
 * Render assistant text interleaved with MCP tool call cards (Kelivo style).
 */
export function renderAssistantContent(container, {
    text = '',
    toolCalls = [],
    awaiting = false,
    renderMarkdown,
    createTypingIndicator,
} = {}) {
    installListeners();
    container.classList.add('has-mcp-tools');
    const content = String(text ?? '');
    let cursor = 0;

    const appendText = (segment) => {
        if (!segment.trim()) return;
        const block = el('div', 'mcp-text-segment');
        block.innerHTML = renderMarkdown ? renderMarkdown(segment) : '';
        if (!renderMarkdown) block.textContent = segment;
        container.appendChild(block);
    };

    groupByRound(toolCalls).forEach((calls) => {
        const offset = Math.max(cursor, Math.min(content.length, Number(calls[0]?.offset) || 0));
        appendText(content.slice(cursor, offset));
        cursor = offset;
        const group = el('div', 'mcp-tool-group');
        calls.forEach((call) => group.appendChild(createToolItem(call)));
        container.appendChild(group);
    });
    appendText(content.slice(cursor));

    if (awaiting && typeof createTypingIndicator === 'function') {
        const waiting = el('div', 'mcp-awaiting');
        waiting.appendChild(createTypingIndicator());
        container.appendChild(waiting);
    }
    return container;
}
