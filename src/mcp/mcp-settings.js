import { loadMcpConfig, updateMcpConfig, normalizeMcpServer, parseMcpServersJson } from './mcp-config.js';
import { refreshServerTools, refreshStaleMcpServers, dropMcpClient, toolNeedsApproval } from './mcp-runtime.js';

function node(tag, text, cls) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (cls) el.className = cls;
    return el;
}
function button(text, action, cls = '') {
    const el = node('button', text, cls);
    el.type = 'button';
    el.addEventListener('click', action);
    return el;
}
function field(label, input) {
    const el = node('label', undefined, 'mcp-field');
    el.append(node('span', label), input);
    return el;
}
function input(value, type = 'text') {
    const el = node('input');
    el.type = type;
    el.value = value ?? '';
    return el;
}
function select(value, choices) {
    const el = node('select');
    for (const [key, text] of choices) {
        const option = node('option', text);
        option.value = key;
        option.selected = key === value;
        el.append(option);
    }
    return el;
}
function toggle(label, checked, onChange) {
    const el = input('', 'checkbox');
    el.checked = checked;
    el.addEventListener('change', () => onChange(el.checked));
    return field(label, el);
}

/** Built-in MCP settings: does not change the third-party plugin API or marketplace. */
export function initMcpSettings({ menu, closeMenu = () => {} } = {}) {
    if (!menu || document.getElementById('mcp-settings-toggle')) return;
    const dialog = node('dialog', undefined, 'mcp-settings-dialog');
    dialog.id = 'mcp-settings';
    dialog.setAttribute('aria-label', 'MCP 工具设置');
    const heading = node('header', undefined, 'mcp-settings-heading');
    heading.append(node('h2', 'MCP 工具'), button('返回', () => dialog.close()));
    const body = node('div', undefined, 'mcp-settings-body');
    const status = node('p', '', 'mcp-settings-notice');
    status.setAttribute('role', 'status');
    dialog.append(heading, status, body);
    document.body.append(dialog);
    let returnFocus = null;
    dialog.addEventListener('close', () => returnFocus?.focus?.());

    const report = async (action, success = '已保存') => {
        status.textContent = '';
        try {
            await action();
            status.textContent = success;
        } catch (error) {
            status.textContent = String(error?.message || error);
        }
    };
    const setSetting = (key, value) => report(() => updateMcpConfig((draft) => {
        draft.settings[key] = value;
    }));
    const changeServer = (id, mutate) => updateMcpConfig((draft) => {
        const server = draft.servers.find((item) => item.id === id);
        if (server) mutate(server);
    });

    async function render() {
        const config = await loadMcpConfig();
        body.replaceChildren();
        const settings = node('section', undefined, 'mcp-settings-options');
        settings.append(toggle('启用 MCP 工具', config.settings.enabled, (value) => setSetting('enabled', value)));
        const approval = select(config.settings.approvalMode, [
            ['auto', '始终允许所有工具（包括写操作）'], ['confirm-write', '只读自动执行，其余每次确认'], ['confirm-all', '所有工具每次确认'],
        ]);
        approval.addEventListener('change', () => setSetting('approvalMode', approval.value));
        settings.append(field('执行确认', approval));
        settings.append(toggle('将工具返回的图片交给模型查看', config.settings.sendToolImages, (value) => setSetting('sendToolImages', value)));
        for (const [key, label, min, max] of [['maxRounds', '每次回复最多工具轮数', 1, 200], ['toolTimeoutSec', '工具超时（秒）', 10, 7200]]) {
            const control = input(config.settings[key], 'number');
            control.min = min;
            control.max = max;
            control.addEventListener('change', () => setSetting(key, Number(control.value)));
            settings.append(field(label, control));
        }
        body.append(settings);
        const actions = node('div', undefined, 'mcp-settings-actions');
        actions.append(button('添加服务器', () => editServer()), button('导入 MCP JSON', () => importJson()), button('刷新已启用服务器', () => report(async () => {
            status.textContent = '正在连接服务器…';
            const enabled = config.servers.filter((server) => server.enabled);
            const results = await Promise.allSettled(enabled.map((server) => refreshServerTools(server.id)));
            await render();
            const failed = results.filter((result) => result.status === 'rejected');
            if (failed.length) throw new Error(failed.length + ' 个服务器连接失败，请查看下方错误。');
        }, '工具列表已刷新')));
        body.append(actions);
        body.append(node('p', '支持 Streamable HTTP 和旧版 SSE；浏览器不能直接启动本机 stdio 程序。默认只读工具自动执行，其余工具需确认；可显式选择始终允许。停用的工具不会提供给模型。', 'mcp-settings-hint'));
        if (!config.servers.length) body.append(node('p', '尚未添加 MCP 服务器。添加 URL 和认证请求头后点击“连接 / 刷新工具”。'));
        for (const server of config.servers) {
            const card = node('section', undefined, 'mcp-server-card');
            const top = node('div', undefined, 'mcp-server-heading');
            top.append(toggle(server.name, server.enabled, (value) => report(() => changeServer(server.id, (s) => { s.enabled = value; }))));
            top.append(button('编辑', () => editServer(server)));
            card.append(top, node('div', server.transport.toUpperCase() + ' · ' + server.tools.filter((tool) => tool.enabled).length + ' / ' + server.tools.length + ' 项工具', 'mcp-settings-hint'));
            const url = new URL(server.url);
            card.append(node('div', url.origin + url.pathname, 'mcp-server-url'));
            const row = node('div', undefined, 'mcp-settings-actions');
            row.append(button('连接 / 刷新工具', () => report(async () => {
                status.textContent = '正在连接 ' + server.name + '…';
                await refreshServerTools(server.id);
                await render();
            }, '已连接并刷新工具')));
            for (const [label, enabled] of [['全选工具', true], ['停用全部工具', false]]) {
                row.append(button(label, () => report(async () => {
                    await changeServer(server.id, (s) => { s.tools.forEach((tool) => { tool.enabled = enabled; }); });
                    await render();
                })));
            }
            if (server.autoApproveTools.length) row.append(button('清除始终允许', () => report(async () => {
                await changeServer(server.id, (s) => { s.autoApproveTools = []; });
                await render();
            })));
            card.append(row);
            if (server.lastError) card.append(node('p', server.lastError, 'mcp-settings-error'));
            const tools = node('details', undefined, 'mcp-tools-list');
            tools.append(node('summary', '工具列表 / 单独开关'));
            const search = input('');
            search.placeholder = '搜索工具名称或说明';
            search.setAttribute('aria-label', '搜索工具');
            tools.append(search);
            const entries = [];
            for (const tool of server.tools) {
                const entry = node('div', undefined, 'mcp-tool-setting');
                entry.append(toggle(tool.title || tool.name, tool.enabled, (value) => report(() => changeServer(server.id, (s) => {
                    const found = s.tools.find((item) => item.name === tool.name);
                    if (found) found.enabled = value;
                }))));
                entry.append(node('p', tool.name + (toolNeedsApproval(config.settings, server, tool) ? ' · 需确认' : ' · 始终允许') + (tool.annotations?.readOnlyHint === true ? ' · 只读' : '') + '\n' + tool.description, 'mcp-settings-hint'));
                tools.append(entry);
                entries.push({ entry, text: (tool.name + ' ' + tool.description).toLowerCase() });
            }
            search.addEventListener('input', () => entries.forEach(({ entry, text }) => { entry.hidden = !text.includes(search.value.toLowerCase()); }));
            card.append(tools);
            body.append(card);
        }
    }

    function editServer(server = null) {
        body.replaceChildren();
        const form = node('form', undefined, 'mcp-server-form');
        const name = input(server?.name || '');
        name.required = true;
        const url = input(server?.url || '', 'url');
        url.required = true;
        url.placeholder = 'https://example.com/mcp';
        const transport = select(server?.transport || 'http', [['http', 'Streamable HTTP'], ['sse', '旧版 HTTP + SSE']]);
        const headers = node('textarea');
        headers.rows = 5;
        headers.spellcheck = false;
        headers.value = JSON.stringify(server?.headers || {}, null, 2);
        form.append(field('名称', name), field('服务器 URL', url), field('传输协议', transport), field('请求头 JSON（含私人凭证，仅保存在本机）', headers));
        const actions = node('div', undefined, 'mcp-settings-actions');
        const save = button('保存', () => {});
        save.type = 'submit';
        actions.append(save, button('取消', () => report(render, '')));
        if (server) actions.append(button('移除服务器', () => {
            if (!window.confirm('移除“' + server.name + '”？不会删除远端服务器或聊天记录。')) return;
            report(async () => {
                await updateMcpConfig((draft) => { draft.servers = draft.servers.filter((s) => s.id !== server.id); });
                dropMcpClient(server.id);
                await render();
            }, '已移除');
        }, 'mcp-danger'));
        form.append(actions);
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            report(async () => {
                const parsed = JSON.parse(headers.value || '{}');
                if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('请求头必须是 JSON 对象。');
                const target = new URL(url.value);
                if (!['https:', 'http:'].includes(target.protocol)) throw new Error('URL 必须使用 HTTP 或 HTTPS。');
                if (target.username || target.password) throw new Error('认证信息请放在请求头，不要放入 URL。');
                const next = normalizeMcpServer({ ...server, name: name.value, url: target.href, transport: transport.value, headers: parsed });
                const endpointChanged = server && (server.url !== next.url || server.transport !== next.transport || JSON.stringify(server.headers) !== JSON.stringify(next.headers));
                if (endpointChanged) { next.tools = []; next.toolsUpdatedAt = 0; next.instructions = ''; next.serverInfo = null; next.autoApproveTools = []; }
                await updateMcpConfig((draft) => {
                    const index = draft.servers.findIndex((s) => s.id === next.id);
                    if (index < 0) draft.servers.push(next);
                    else draft.servers[index] = next;
                });
                dropMcpClient(next.id);
                await render();
            });
        });
        body.append(form);
        name.focus();
    }

    function importJson() {
        body.replaceChildren();
        const editor = node('textarea');
        editor.rows = 12;
        editor.placeholder = '{ "mcpServers": { "工具": { "url": "https://example.com/mcp", "headers": {} } } }';
        editor.setAttribute('aria-label', 'MCP JSON 配置');
        body.append(editor, button('导入（添加，不覆盖已有服务器）', () => report(async () => {
            const servers = parseMcpServersJson(editor.value);
            if (!servers.length) throw new Error('没有可导入的 HTTP / SSE 服务器；不支持 stdio 配置。');
            for (const server of servers) {
                const url = new URL(server.url);
                if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('服务器 URL 无效。');
            }
            await updateMcpConfig((draft) => {
                for (const server of servers) {
                    if (draft.servers.some((s) => s.id === server.id || (s.url === server.url && s.name === server.name))) continue;
                    draft.servers.push(server);
                }
            });
            await render();
        }, '服务器已导入，请连接 / 刷新工具')), button('取消', () => report(render, '')));
    }

    const entry = node('div', 'MCP 工具', 'menu-item');
    entry.id = 'mcp-settings-toggle';
    entry.setAttribute('role', 'menuitem');
    entry.tabIndex = 0;
    entry.addEventListener('click', () => {
        returnFocus = document.getElementById('settings-button');
        closeMenu();
        dialog.showModal();
        report(render, '');
    });
    menu.insertBefore(entry, document.getElementById('api-settings-toggle'));
    void refreshStaleMcpServers().catch(() => {});
    return { dialog, render };
}
