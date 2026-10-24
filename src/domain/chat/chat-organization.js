import { subscribeRemoteChanges } from '../../runtime/sync/replica.js';
import { storageAdapter } from '../../utils/storage-adapter.js';

export const CHAT_ORGANIZATION_KEY = 'cerebr_chat_organization_v1';
const defaults = () => ({ folders: [], assignments: {}, chatOrder: [], chatsCollapsed: false, sidebarCollapsed: false });

// New chats retain activity order at the top; saved chats keep their manual order.
export function orderChatIds(chatIds, savedOrder = []) {
    const remaining = new Set(chatIds);
    const ordered = savedOrder.filter((id) => remaining.delete(id));
    return [...remaining, ...ordered];
}

function normalize(value) {
    const ids = new Set();
    const folders = (Array.isArray(value?.folders) ? value.folders : []).flatMap((folder) => {
        if (
            !folder ||
            typeof folder.id !== 'string' ||
            ids.has(folder.id) ||
            !String(folder.name || '').trim()
        )
            return [];
        ids.add(folder.id);
        return [
            { id: folder.id, name: String(folder.name).trim().slice(0, 80), collapsed: !!folder.collapsed },
        ];
    });
    const assignments = Object.fromEntries(
        Object.entries(value?.assignments || {}).filter(([, id]) => ids.has(id))
    );
    return {
        folders,
        assignments,
        chatOrder: [...new Set((Array.isArray(value?.chatOrder) ? value.chatOrder : [])
            .filter((id) => typeof id === 'string' && id.length > 0))],
        chatsCollapsed: !!value?.chatsCollapsed,
        sidebarCollapsed: !!value?.sidebarCollapsed,
    };
}

// Separate, small navigation metadata: moving a chat never rewrites its message history.
export function createChatOrganization(storage = storageAdapter) {
    let snapshot = { ...defaults(), ready: false };
    const listeners = new Set();
    let queue = Promise.resolve(),
        loading;
    const publish = (data) => {
        const next = { ...data, ready: true };
        if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
        snapshot = next;
        listeners.forEach((listener) => listener());
    };
    const serialize = (task) => {
        const result = queue.catch(() => {}).then(task);
        queue = result;
        return result;
    };
    const read = async () => normalize((await storage.get(CHAT_ORGANIZATION_KEY))[CHAT_ORGANIZATION_KEY]);
    const change = (mutate) =>
        serialize(async () => {
            const save = async () => {
                const data = await read();
                const result = mutate(data);
                await storage.set({ [CHAT_ORGANIZATION_KEY]: { version: 1, ...data } });
                publish(data);
                return result;
            };
            return globalThis.navigator?.locks?.request
                ? navigator.locks.request(CHAT_ORGANIZATION_KEY, save)
                : save();
        });
    const validName = (data, value, exceptId) => {
        const name = String(value || '')
            .trim()
            .slice(0, 80);
        if (!name) throw new Error('nav_folder_name_required');
        if (
            data.folders.some(
                (folder) =>
                    folder.id !== exceptId && folder.name.toLocaleLowerCase() === name.toLocaleLowerCase()
            )
        )
            throw new Error('nav_folder_name_exists');
        return name;
    };
    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getSnapshot: () => snapshot,
        load() {
            if (!loading)
                loading = serialize(async () => publish(await read())).finally(() => {
                    loading = null;
                });
            return loading;
        },
        createFolder(name, chatId) {
            return change((data) => {
                const folder = { id: crypto.randomUUID(), name: validName(data, name), collapsed: false };
                data.folders.push(folder);
                data.chatsCollapsed = false;
                if (chatId) data.assignments[chatId] = folder.id;
                return folder;
            });
        },
        renameFolder(id, name) {
            return change((data) => {
                const folder = data.folders.find((folder) => folder.id === id);
                if (!folder) throw new Error('nav_folder_missing');
                folder.name = validName(data, name, id);
            });
        },
        deleteFolder(id) {
            return change((data) => {
                data.folders = data.folders.filter((folder) => folder.id !== id);
                data.assignments = Object.fromEntries(
                    Object.entries(data.assignments).filter(([, folderId]) => folderId !== id)
                );
            });
        },
        moveChat(chatId, folderId) {
            return change((data) => {
                if (folderId && !data.folders.some((folder) => folder.id === folderId))
                    throw new Error('nav_folder_missing');
                if (folderId) data.assignments[chatId] = folderId;
                else delete data.assignments[chatId];
            });
        },
        reorderChat(chatId, destination, chatIds) {
            return change((data) => {
                const order = orderChatIds(chatIds, data.chatOrder);
                if (!order.includes(chatId)) return;
                const { targetId, before = true } = destination;
                if (targetId === chatId || (targetId && !order.includes(targetId))) return;
                // Resolve membership from the latest metadata, including changes from other windows.
                const folderId = targetId ? data.assignments[targetId] : destination.folderId;
                const folder = folderId && data.folders.find((item) => item.id === folderId);
                if (folderId && !folder) throw new Error('nav_folder_missing');
                const next = order.filter((id) => id !== chatId);
                const index = targetId ? next.indexOf(targetId) + (before ? 0 : 1)
                    : next.findIndex((id) => (data.assignments[id] || null) === (folderId || null));
                next.splice(index < 0 ? next.length : index, 0, chatId);
                data.chatOrder = next;
                if (folderId) data.assignments[chatId] = folderId;
                else delete data.assignments[chatId];
                if (folder) folder.collapsed = false;
            });
        },
        setCollapsed(section, value) {
            return change((data) => {
                if (section === 'chats' || section === 'sidebar') data[`${section}Collapsed`] = !!value;
                else {
                    const folder = data.folders.find((folder) => folder.id === section);
                    if (folder) folder.collapsed = !!value;
                }
            });
        },
    };
}

export const chatOrganization = createChatOrganization();

subscribeRemoteChanges((keys) => { if (keys.includes(CHAT_ORGANIZATION_KEY)) void chatOrganization.load(); });
