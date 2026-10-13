import { McpClient } from './mcp-client.js';
import {
    loadMcpConfig,
    mergeFetchedTools,
    updateMcpConfig,
    DEFAULT_MCP_SETTINGS,
} from './mcp-config.js';

const CLIENT_INFO = Object.freeze({ name: 'Cerebr-MCP', version: '1.0.0' });
const clientCache = new Map();

function clientSignature(server) {
    return JSON.stringify([server.url, server.transport, server.headers]);
}

export function getMcpClient(server) {
    const signature = clientSignature(server);
    const cached = clientCache.get(server.id);
    if (cached && cached.signature === signature) {
        return cached.client;
    }
    if (cached) {
        void cached.client.close().catch(() => {});
    }
    const client = new McpClient({
        url: server.url,
        transport: server.transport,
        headers: server.headers,
        clientInfo: CLIENT_INFO,
    });
    clientCache.set(server.id, { signature, client });
    return client;
}

export function dropMcpClient(serverId) {
    const cached = clientCache.get(serverId);
    if (!cached) return;
    clientCache.delete(serverId);
    void cached.client.close().catch(() => {});
}

function truncateText(value, max) {
    const text = String(value ?? '');
    return text.length > max ? text.slice(0, max) + '…' : text;
}

/** Connect, list tools and merge them into the stored server config. Returns the tool count. */
export async function refreshServerTools(serverId, { signal, serverOverride = null } = {}) {
    const config = await loadMcpConfig();
    const server = serverOverride || config.servers.find((item) => item.id === serverId);
    if (!server) throw new Error('MCP 服务器不存在');
    if (!server.url) throw new Error('MCP 服务器 URL 为空');

    const client = getMcpClient(server);
    try {
        const tools = await client.listTools({ signal });
        await updateMcpConfig((draft) => {
            const target = draft.servers.find((item) => item.id === serverId);
            if (!target) return draft;
            target.tools = mergeFetchedTools(target, tools);
            target.toolsUpdatedAt = Date.now();
            target.lastError = '';
            target.serverInfo = client.serverInfo
                ? { name: String(client.serverInfo.name || ''), version: String(client.serverInfo.version || '') }
                : null;
            target.instructions = truncateText(client.instructions || '', 6000);
            return draft;
        });
        return tools.length;
    } catch (error) {
        dropMcpClient(serverId);
        if (!signal?.aborted) {
            await updateMcpConfig((draft) => {
                const target = draft.servers.find((item) => item.id === serverId);
                if (target) target.lastError = String(error?.message || error);
                return draft;
            });
        }
        throw error;
    }
}

const refreshInFlight = new Map();

/** Refresh tool lists of enabled servers whose cache is older than maxAgeMs (non-blocking callers). */
export async function refreshStaleMcpServers({ maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
    const config = await loadMcpConfig();
    const now = Date.now();
    const stale = config.servers.filter((server) => server.enabled && server.url && now - (server.toolsUpdatedAt || 0) > maxAgeMs);
    await Promise.all(stale.map((server) => {
        if (refreshInFlight.has(server.id)) return refreshInFlight.get(server.id);
        const task = refreshServerTools(server.id)
            .catch((error) => console.warn('[Cerebr MCP] refresh failed', server.name, error?.message || error))
            .finally(() => refreshInFlight.delete(server.id));
        refreshInFlight.set(server.id, task);
        return task;
    }));
}

function sanitizeFunctionName(name) {
    const cleaned = String(name || '').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
    return cleaned || 'tool';
}

function sanitizeSchema(schema) {
    let copy;
    try {
        copy = JSON.parse(JSON.stringify(schema || {}));
    } catch {
        copy = {};
    }
    if (!copy || typeof copy !== 'object' || Array.isArray(copy)) copy = {};
    delete copy.$schema;
    copy.type = 'object';
    if (!copy.properties || typeof copy.properties !== 'object') copy.properties = {};
    return copy;
}

function describeTool(tool) {
    const title = tool.title && tool.title !== tool.name ? tool.title + '. ' : '';
    return truncateText(title + (tool.descriptionOverride || tool.description || ''), 6000);
}

/** Build OpenAI-compatible tool definitions for every enabled tool of every enabled server. */
export function buildToolPlan(config) {
    const definitions = [];
    const byName = new Map();
    const servers = [];
    if (!config?.settings?.enabled) return { definitions, byName, servers };

    config.servers.forEach((server) => {
        if (!server.enabled || !server.url) return;
        const enabledTools = server.tools.filter((tool) => tool.enabled && tool.name);
        if (enabledTools.length === 0) return;
        servers.push({ server, toolCount: enabledTools.length });
        enabledTools.forEach((tool) => {
            let functionName = sanitizeFunctionName(tool.name).slice(0, 64);
            if (byName.has(functionName)) {
                functionName = (sanitizeFunctionName(server.id).slice(0, 20) + '__' + sanitizeFunctionName(tool.name)).slice(0, 64);
            }
            let suffix = 2;
            while (byName.has(functionName)) {
                functionName = functionName.slice(0, 60) + '_' + suffix;
                suffix += 1;
            }
            byName.set(functionName, { server, tool });
            definitions.push({
                type: 'function',
                function: {
                    name: functionName,
                    description: describeTool(tool),
                    parameters: sanitizeSchema(tool.inputSchema),
                },
            });
        });
    });

    return { definitions, byName, servers };
}

export function isReadOnlyTool(tool) {
    return tool?.annotations?.readOnlyHint === true;
}

export function toolNeedsApproval(settings, server, tool) {
    const mode = settings?.approvalMode || DEFAULT_MCP_SETTINGS.approvalMode;
    if (mode === 'auto') return false;
    if (Array.isArray(server?.autoApproveTools) && server.autoApproveTools.includes(tool?.name)) return false;
    if (mode === 'confirm-all') return true;
    return !isReadOnlyTool(tool);
}

/** Convert an MCP CallToolResult into display/model friendly text + images. */
export function formatToolResult(result) {
    const parts = [];
    const images = [];
    const content = Array.isArray(result?.content) ? result.content : [];
    content.forEach((item) => {
        if (!item || typeof item !== 'object') return;
        if (item.type === 'text') {
            parts.push(String(item.text ?? ''));
        } else if (item.type === 'image' && item.data) {
            const mimeType = item.mimeType || 'image/png';
            images.push({ mimeType, dataUrl: 'data:' + mimeType + ';base64,' + item.data });
            parts.push('[图片 #' + images.length + '（' + mimeType + '）]');
        } else if (item.type === 'audio') {
            parts.push('[音频内容（' + (item.mimeType || 'audio') + '）已省略]');
        } else if (item.type === 'resource' && item.resource) {
            const resource = item.resource;
            if (typeof resource.text === 'string') {
                parts.push('[资源 ' + (resource.uri || '') + ']\n' + resource.text);
            } else {
                parts.push('[二进制资源 ' + (resource.uri || '') + '（' + (resource.mimeType || 'unknown') + '）]');
            }
        } else if (item.type === 'resource_link') {
            parts.push('[资源链接] ' + (item.name || '') + ' ' + (item.uri || ''));
        }
    });
    if (parts.length === 0 && result?.structuredContent !== undefined) {
        try {
            parts.push(JSON.stringify(result.structuredContent, null, 2));
        } catch {
            // ignore
        }
    }
    const text = parts.join('\n\n').trim();
    return {
        text: text || '（工具没有返回内容）',
        images,
        isError: result?.isError === true,
    };
}

export async function callMcpTool(entry, args, { signal, timeoutMs } = {}) {
    const client = getMcpClient(entry.server);
    try {
        const raw = await client.callTool(entry.tool.name, args, { signal, timeoutMs });
        return formatToolResult(raw);
    } catch (error) {
        if (!signal?.aborted && !(error?.code !== null && error?.code !== undefined)) {
            // transport level failure: rebuild the client next time
            dropMcpClient(entry.server.id);
        }
        throw error;
    }
}

const approvalWaiters = new Map();

export function waitForToolApproval(callId, signal) {
    return new Promise((resolve) => {
        const onAbort = () => finish('deny');
        const finish = (decision) => {
            if (!approvalWaiters.has(callId)) return;
            approvalWaiters.delete(callId);
            signal?.removeEventListener('abort', onAbort);
            resolve(decision);
        };
        approvalWaiters.set(callId, finish);
        if (signal?.aborted) {
            finish('deny');
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export function resolveToolApproval(callId, decision) {
    const finish = approvalWaiters.get(callId);
    if (!finish) return false;
    finish(decision === 'allow' || decision === 'always' ? decision : 'deny');
    return true;
}

export async function addAutoApprovedTool(serverId, toolName) {
    await updateMcpConfig((draft) => {
        const server = draft.servers.find((item) => item.id === serverId);
        if (server && !server.autoApproveTools.includes(toolName)) {
            server.autoApproveTools.push(toolName);
        }
        return draft;
    });
}
