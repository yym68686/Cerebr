import { storageAdapter, isExtensionEnvironment } from '../utils/storage-adapter.js';

export const MCP_CONFIG_STORAGE_KEY = 'cerebrMcpConfigV1';
export const MCP_APPROVAL_MODES = Object.freeze(['auto', 'confirm-write', 'confirm-all']);
export const DEFAULT_MCP_SETTINGS = Object.freeze({
    enabled: true,
    approvalMode: 'confirm-write',
    quietImageRetention: false,
    maxRounds: 30,
    sendToolImages: true,
    toolTimeoutSec: 900,
});

function generateId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return 'mcp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clampInt(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, Math.round(numeric)));
}

export function normalizeMcpTool(tool = {}) {
    return {
        name: String(tool.name || '').trim(),
        title: typeof tool.title === 'string' ? tool.title : '',
        description: typeof tool.description === 'string' ? tool.description : '',
        descriptionOverride: typeof tool.descriptionOverride === 'string' ? tool.descriptionOverride : '',
        inputSchema: isPlainObject(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
        annotations: isPlainObject(tool.annotations) ? tool.annotations : {},
        enabled: tool.enabled !== false,
    };
}

export function normalizeHeaders(headers) {
    const result = {};
    if (Array.isArray(headers)) {
        headers.forEach((item) => {
            const name = String(item?.name ?? item?.key ?? '').trim();
            if (name) result[name] = String(item?.value ?? '');
        });
        return result;
    }
    if (isPlainObject(headers)) {
        Object.entries(headers).forEach(([name, value]) => {
            const key = String(name || '').trim();
            if (key) result[key] = String(value ?? '');
        });
    }
    return result;
}

export function normalizeMcpServer(server = {}) {
    const tools = Array.isArray(server.tools)
        ? server.tools.map(normalizeMcpTool).filter((tool) => tool.name)
        : [];
    return {
        id: String(server.id || '').trim() || generateId(),
        name: String(server.name || '').trim() || 'MCP Server',
        enabled: server.enabled !== false,
        transport: server.transport === 'sse' ? 'sse' : 'http',
        url: String(server.url || '').trim(),
        headers: normalizeHeaders(server.headers),
        tools,
        toolsUpdatedAt: Number(server.toolsUpdatedAt) || 0,
        autoApproveTools: Array.isArray(server.autoApproveTools)
            ? [...new Set(server.autoApproveTools.map(String))]
            : [],
        instructions: typeof server.instructions === 'string' ? server.instructions : '',
        instructionsEnabled: server.instructionsEnabled !== false,
        serverInfo: isPlainObject(server.serverInfo) ? server.serverInfo : null,
        lastError: typeof server.lastError === 'string' ? server.lastError : '',
    };
}

export function normalizeMcpSettings(settings = {}) {
    const source = isPlainObject(settings) ? settings : {};
    return {
        enabled: source.enabled !== undefined ? !!source.enabled : DEFAULT_MCP_SETTINGS.enabled,
        quietImageRetention: source.quietImageRetention === true,
        approvalMode: MCP_APPROVAL_MODES.includes(source.approvalMode)
            ? source.approvalMode
            : DEFAULT_MCP_SETTINGS.approvalMode,
        maxRounds: clampInt(source.maxRounds, 1, 200, DEFAULT_MCP_SETTINGS.maxRounds),
        sendToolImages: source.sendToolImages !== undefined ? !!source.sendToolImages : DEFAULT_MCP_SETTINGS.sendToolImages,
        toolTimeoutSec: clampInt(source.toolTimeoutSec, 10, 7200, DEFAULT_MCP_SETTINGS.toolTimeoutSec),
    };
}

export function normalizeMcpConfig(raw = {}) {
    const source = isPlainObject(raw) ? raw : {};
    const seen = new Set();
    const servers = [];
    (Array.isArray(source.servers) ? source.servers : []).forEach((server) => {
        const normalized = normalizeMcpServer(server);
        if (seen.has(normalized.id)) return;
        seen.add(normalized.id);
        servers.push(normalized);
    });
    return {
        version: 1,
        settings: normalizeMcpSettings(source.settings),
        servers,
    };
}

let cachedConfig = null;
let loadPromise = null;
let lastSerialized = '';
const listeners = new Set();

function notify() {
    listeners.forEach((listener) => {
        try {
            listener(cachedConfig);
        } catch (error) {
            console.error('[Cerebr MCP] config listener failed', error);
        }
    });
}

function adoptConfig(raw) {
    const normalized = normalizeMcpConfig(raw);
    const serialized = JSON.stringify(normalized);
    const changed = serialized !== lastSerialized;
    cachedConfig = normalized;
    lastSerialized = serialized;
    return changed;
}

if (isExtensionEnvironment && chrome?.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !changes?.[MCP_CONFIG_STORAGE_KEY]) return;
        const nextValue = changes[MCP_CONFIG_STORAGE_KEY].newValue;
        if (adoptConfig(nextValue || {})) notify();
    });
}

export async function hasStoredMcpConfig() {
    const result = await storageAdapter.get(MCP_CONFIG_STORAGE_KEY);
    return isPlainObject(result?.[MCP_CONFIG_STORAGE_KEY]);
}

export async function loadMcpConfig({ force = false } = {}) {
    if (cachedConfig && !force) return cachedConfig;
    if (!loadPromise || force) {
        loadPromise = storageAdapter.get(MCP_CONFIG_STORAGE_KEY)
            .then((result) => {
                adoptConfig(result?.[MCP_CONFIG_STORAGE_KEY] || {});
                return cachedConfig;
            })
            .finally(() => {
                loadPromise = null;
            });
    }
    return loadPromise;
}

export function getCachedMcpConfig() {
    return cachedConfig || normalizeMcpConfig({});
}

export async function saveMcpConfig(config) {
    const changed = adoptConfig(config);
    await storageAdapter.set({ [MCP_CONFIG_STORAGE_KEY]: cachedConfig });
    if (changed) notify();
    return cachedConfig;
}

let updateChain = Promise.resolve();

/** Serialized read-modify-write on the MCP config. */
export function updateMcpConfig(mutator) {
    const run = async () => {
        const current = await loadMcpConfig();
        const draft = JSON.parse(JSON.stringify(current));
        const returned = await mutator(draft);
        return saveMcpConfig(returned && typeof returned === 'object' ? returned : draft);
    };
    updateChain = updateChain.catch(() => {}).then(run);
    return updateChain;
}

export function subscribeMcpConfig(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * Merge a freshly fetched tools/list result into a stored server, keeping per-tool switches.
 * New tools are enabled only when every existing tool is enabled (i.e. the user never curated the list).
 */
export function mergeFetchedTools(server, fetchedTools = []) {
    const previous = new Map((server?.tools || []).map((tool) => [tool.name, tool]));
    const curated = (server?.tools || []).some((tool) => tool.enabled === false);
    return fetchedTools
        .filter((tool) => tool && tool.name)
        .map((tool) => {
            const old = previous.get(tool.name);
            return normalizeMcpTool({
                ...tool,
                enabled: old ? old.enabled !== false : !curated,
                descriptionOverride: old?.descriptionOverride || '',
            });
        });
}

/** Normal imports preserve settings; an explicit versioned sync refreshes only seed-owned servers. */
export async function applyMcpSeed(seed = {}) {
    const hadConfig = await hasStoredMcpConfig();
    return updateMcpConfig((draft) => {
        if ((!hadConfig || seed.syncExisting === true) && isPlainObject(seed.settings)) {
            draft.settings = normalizeMcpSettings({ ...draft.settings, ...seed.settings });
        }
        const existingIds = new Set(draft.servers.map((server) => server.id));
        (Array.isArray(seed.servers) ? seed.servers : []).forEach((server) => {
            const normalized = normalizeMcpServer(server);
            if (!normalized.url) return;
            if (existingIds.has(normalized.id)) {
                if (seed.syncExisting === true) {
                    const index = draft.servers.findIndex((entry) => entry.id === normalized.id);
                    const old = draft.servers[index];
                    draft.servers[index] = { ...normalized, autoApproveTools: old.autoApproveTools };
                }
                return;
            }
            draft.servers.push(normalized);
            existingIds.add(normalized.id);
        });
        return draft;
    });
}

/**
 * Parse common MCP JSON shapes: { mcpServers: { name: {...} } }, an array of servers, or a single server.
 */
export function parseMcpServersJson(text) {
    const data = JSON.parse(text);
    const entries = [];
    const pushServer = (name, value) => {
        if (!isPlainObject(value)) return;
        const url = value.url || value.baseUrl || value.serverUrl || value.endpoint;
        if (!url) return;
        const type = String(value.type || value.transport || '').toLowerCase();
        entries.push(normalizeMcpServer({
            id: value.id,
            name: value.name || name,
            url,
            transport: type === 'sse' ? 'sse' : 'http',
            headers: value.headers || value.requestHeaders || {},
            enabled: value.enabled !== false && value.disabled !== true && value.isActive !== false,
        }));
    };
    if (Array.isArray(data)) {
        data.forEach((item, index) => pushServer(item?.name || ('MCP ' + (index + 1)), item));
    } else if (isPlainObject(data?.mcpServers)) {
        Object.entries(data.mcpServers).forEach(([name, value]) => pushServer(name, value));
    } else if (isPlainObject(data?.servers)) {
        Object.entries(data.servers).forEach(([name, value]) => pushServer(name, value));
    } else {
        pushServer(data?.name || 'MCP Server', data);
    }
    return entries;
}
