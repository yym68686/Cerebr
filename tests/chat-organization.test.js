import { beforeEach, expect, it, vi } from 'vitest';
import { createChatOrganization, CHAT_ORGANIZATION_KEY, orderChatIds } from '../src/domain/chat/chat-organization.js';
let memory, storage, organization;
beforeEach(() => {
    memory = {};
    storage = {
        get: vi.fn(async (key) => ({ [key]: structuredClone(memory[key]) })),
        set: vi.fn(async (data) => Object.assign(memory, structuredClone(data))),
    };
    organization = createChatOrganization(storage);
});
it('persists folders, membership and collapsed sections across reloads without writing messages', async () => {
    await organization.load();
    const folder = await organization.createFolder('  Research  ');
    await organization.moveChat('chat-a', folder.id);
    await organization.setCollapsed(folder.id, true);
    await organization.setCollapsed('chats', true);
    await organization.setCollapsed('sidebar', true);
    const restored = createChatOrganization(storage);
    await restored.load();
    expect(restored.getSnapshot()).toMatchObject({
        ready: true,
        folders: [{ name: 'Research', collapsed: true }],
        assignments: { 'chat-a': folder.id },
        chatsCollapsed: true,
        sidebarCollapsed: true,
    });
    expect(Object.keys(memory)).toEqual([CHAT_ORGANIZATION_KEY]);
});
it('creates a folder and moves a chat atomically, then returns its members to unfiled when deleted', async () => {
    const folder = await organization.createFolder('Project', 'chat-a');
    expect(storage.set).toHaveBeenCalledOnce();
    await organization.moveChat('chat-b', folder.id);
    await organization.renameFolder(folder.id, 'Renamed');
    expect(organization.getSnapshot().folders[0].name).toBe('Renamed');
    await organization.deleteFolder(folder.id);
    expect(organization.getSnapshot()).toMatchObject({ folders: [], assignments: {} });
});
it('serializes rapid writes and permits retry after failure without publishing an unsaved move', async () => {
    const folder = await organization.createFolder('Research');
    storage.set.mockRejectedValueOnce(new Error('Storage failed'));
    await expect(organization.moveChat('chat-a', folder.id)).rejects.toThrow('Storage failed');
    expect(organization.getSnapshot().assignments).toEqual({});
    await Promise.all([
        organization.moveChat('chat-a', folder.id),
        organization.moveChat('chat-b', folder.id),
    ]);
    expect(organization.getSnapshot().assignments).toEqual({ 'chat-a': folder.id, 'chat-b': folder.id });
});
it('validates folder names and does not retain assignments to missing folders', async () => {
    await expect(organization.createFolder(' ')).rejects.toThrow('nav_folder_name_required');
    await organization.createFolder('Work');
    await expect(organization.createFolder(' work ')).rejects.toThrow('nav_folder_name_exists');
    await expect(organization.moveChat('a', 'missing')).rejects.toThrow('nav_folder_missing');
    memory[CHAT_ORGANIZATION_KEY] = {
        folders: [{ id: 'f', name: 'Valid' }, { id: 'f', name: 'Duplicate' }, null],
        assignments: { a: 'f', b: 'missing' },
    };
    await organization.load();
    expect(organization.getSnapshot()).toMatchObject({
        folders: [{ id: 'f', name: 'Valid' }],
        assignments: { a: 'f' },
    });
});
it('reads newer stored metadata before applying a change', async () => {
    const first = await organization.createFolder('First');
    const other = createChatOrganization(storage);
    const second = await other.createFolder('Second');
    await organization.moveChat('a', first.id);
    expect(organization.getSnapshot().folders.map((folder) => folder.id)).toEqual([first.id, second.id]);
});

it('restores manual order without writing chat history, keeps new chats first and ignores deleted chats', async () => {
    await organization.reorderChat('c', { targetId: 'a', before: true }, ['a', 'b', 'c']);
    const restored = createChatOrganization(storage);
    await restored.load();
    expect(restored.getSnapshot().chatOrder).toEqual(['c', 'a', 'b']);
    // Activity changes no longer override a manual order; a new chat still appears first.
    expect(orderChatIds(['new', 'b', 'a', 'c'], restored.getSnapshot().chatOrder)).toEqual(['new', 'c', 'a', 'b']);
    expect(orderChatIds(['b', 'c'], restored.getSnapshot().chatOrder)).toEqual(['c', 'b']);
    await restored.reorderChat('c', { targetId: 'b', before: false }, ['b', 'c']);
    expect(restored.getSnapshot().chatOrder).toEqual(['b', 'c']);
    expect(Object.keys(memory)).toEqual([CHAT_ORGANIZATION_KEY]);
});

it('moves between folders and unfiled atomically while preserving hidden chats', async () => {
    const folder = await organization.createFolder('Project', 'b');
    await organization.setCollapsed(folder.id, true);
    await organization.reorderChat('a', { targetId: 'b', before: false }, ['a', 'hidden', 'b']);
    expect(organization.getSnapshot()).toMatchObject({
        chatOrder: ['hidden', 'b', 'a'],
        assignments: { a: folder.id, b: folder.id },
        folders: [{ collapsed: false }],
    });
    await organization.reorderChat('a', { folderId: null }, ['a', 'hidden', 'b']);
    expect(organization.getSnapshot()).toMatchObject({ chatOrder: ['a', 'hidden', 'b'], assignments: { b: folder.id } });
    await organization.reorderChat('a', { folderId: folder.id }, ['a', 'hidden', 'b']);
    expect(organization.getSnapshot().chatOrder).toEqual(['hidden', 'a', 'b']);
});

it('applies moves against the latest saved order and does not publish failed reorders', async () => {
    await organization.load();
    const other = createChatOrganization(storage);
    await other.reorderChat('c', { targetId: 'a' }, ['a', 'b', 'c']);
    await organization.reorderChat('b', { targetId: 'a' }, ['a', 'b', 'c']);
    expect(organization.getSnapshot().chatOrder).toEqual(['c', 'b', 'a']);
    storage.set.mockRejectedValueOnce(new Error('Storage failed'));
    await expect(organization.reorderChat('a', { targetId: 'c' }, ['a', 'b', 'c'])).rejects.toThrow('Storage failed');
    expect(organization.getSnapshot().chatOrder).toEqual(['c', 'b', 'a']);
    await organization.reorderChat('a', { targetId: 'c' }, ['a', 'b', 'c']);
    expect(organization.getSnapshot().chatOrder).toEqual(['a', 'c', 'b']);
});

it('normalizes legacy or malformed order and safely ignores removed drag targets', async () => {
    await organization.load();
    expect(organization.getSnapshot().chatOrder).toEqual([]);
    memory[CHAT_ORGANIZATION_KEY] = { chatOrder: ['a', 'a', null, 2, '', 'b'] };
    await organization.load();
    expect(organization.getSnapshot().chatOrder).toEqual(['a', 'b']);
    await organization.reorderChat('b', { targetId: 'removed' }, ['a', 'b']);
    await organization.reorderChat('removed', { targetId: 'a' }, ['a', 'b']);
    expect(organization.getSnapshot().chatOrder).toEqual(['a', 'b']);
    await expect(organization.reorderChat('b', { folderId: 'removed' }, ['a', 'b'])).rejects.toThrow('nav_folder_missing');
});
