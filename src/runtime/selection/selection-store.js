import { storageAdapter, syncStorageAdapter } from '../../utils/storage-adapter.js';
import { createStore } from '../../app/state/store.js';
export const PAGE_SELECTION_KEY = 'selectionActionsOnWebpages';
export const ACTIONS_KEY = 'cerebr_selection_actions_v1';
export const ACTION_ICONS = ['sparkle', 'brain', 'search', 'compose', 'chat-list', 'tabs'];
export const selectionStore = createStore({ pageEnabled: true, actions: [], ready: false });
export function normalizeActions(value) {
    return (Array.isArray(value) ? value : [])
        .filter(
            (a) =>
                a &&
                typeof a.id === 'string' &&
                typeof a.name === 'string' &&
                a.name.trim() &&
                typeof a.prompt === 'string' &&
                a.prompt.trim()
        )
        .map((a) => ({
            id: a.id,
            name: a.name.trim().slice(0, 40),
            prompt: a.prompt.trim().slice(0, 8000),
            icon: ACTION_ICONS.includes(a.icon) ? a.icon : 'sparkle',
        }));
}
export async function loadSelectionSettings() {
    const [preferences, actions] = await Promise.all([
        syncStorageAdapter.get(PAGE_SELECTION_KEY),
        storageAdapter.get(ACTIONS_KEY),
    ]);
    selectionStore.set({
        pageEnabled: preferences[PAGE_SELECTION_KEY] !== false,
        actions: normalizeActions(actions[ACTIONS_KEY]),
        ready: true,
    });
}
export async function setPageSelectionEnabled(enabled) {
    await syncStorageAdapter.set({ [PAGE_SELECTION_KEY]: !!enabled });
    selectionStore.set({ pageEnabled: !!enabled });
}
export async function saveSelectionAction(action) {
    const list = selectionStore.getSnapshot().actions;
    const id = action.id || crypto.randomUUID();
    const next = normalizeActions([...list.filter((item) => item.id !== id), { ...action, id }]);
    await storageAdapter.set({ [ACTIONS_KEY]: next });
    selectionStore.set({ actions: next });
}
export async function removeSelectionAction(id) {
    const actions = selectionStore.getSnapshot().actions.filter((action) => action.id !== id);
    await storageAdapter.set({ [ACTIONS_KEY]: actions });
    selectionStore.set({ actions });
}
export function subscribeSelectionSettings() {
    const update = (changes, area) => {
        if (area === 'sync' && changes[PAGE_SELECTION_KEY])
            selectionStore.set({ pageEnabled: changes[PAGE_SELECTION_KEY].newValue !== false });
        if (area === 'local' && changes[ACTIONS_KEY])
            selectionStore.set({ actions: normalizeActions(changes[ACTIONS_KEY].newValue) });
    };
    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
        chrome.storage.onChanged.addListener(update);
        return () => chrome.storage.onChanged.removeListener(update);
    }
    const storage = () => void loadSelectionSettings();
    window.addEventListener('storage', storage);
    return () => window.removeEventListener('storage', storage);
}
