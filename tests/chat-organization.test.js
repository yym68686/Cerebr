import { beforeEach, expect, it, vi } from 'vitest';
import { createChatOrganization, CHAT_ORGANIZATION_KEY } from '../src/domain/chat/chat-organization.js';
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
