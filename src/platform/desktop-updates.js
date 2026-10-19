import { createStore } from '../app/state/store.js';

export const desktopUpdateStore = createStore({ phase: 'idle' });

// The native host only installs after the session confirms that durable writes
// have finished. A failed save leaves the running application intact.
export function attachDesktopUpdates({
    uiStore,
    persist,
    api = globalThis.cerebrDesktop?.updates,
    blockInput = (value) => {
        document.body.inert = value;
    },
}) {
    if (!api) return () => {};
    let disposed = false,
        preparing = false;
    const prepare = async () => {
        const ui = uiStore.getSnapshot();
        if (
            disposed ||
            preparing ||
            desktopUpdateStore.getSnapshot().phase !== 'waiting' ||
            ui.phase !== 'idle' ||
            ui.editing
        )
            return;
        preparing = true;
        blockInput(true);
        try {
            await persist();
            if (!disposed) await api.ready();
        } catch {
            if (!disposed) api.saveFailed();
        } finally {
            blockInput(false);
            preparing = false;
        }
    };
    const receive = (status) => {
        if (disposed) return;
        desktopUpdateStore.set(status);
        void prepare();
    };
    let received = false;
    const unsubscribe = api.subscribe((status) => {
        received = true;
        receive(status);
    });
    void api
        .status()
        .then((status) => {
            if (!received) receive(status);
        })
        .catch(() => {});
    const unsubscribeUI = uiStore.subscribe(() => void prepare());
    return () => {
        disposed = true;
        unsubscribe();
        unsubscribeUI();
        blockInput(false);
    };
}
