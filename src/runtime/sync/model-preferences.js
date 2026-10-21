import { storageAdapter } from '../../utils/storage-adapter.js';
import { modelSelection } from '../../domain/chat/model-selection.js';

// These keys deliberately never enter the replica or Chrome sync storage.
export const DEFAULT_MODEL = 'cerebr_default_model_local_v1';
export const LEGACY_MODEL = 'cerebr_legacy_model_local_v1';
export async function readModelPreferences(fallback) {
    const saved = await storageAdapter.get([DEFAULT_MODEL, LEGACY_MODEL]);
    const defaultSelection = saved[DEFAULT_MODEL] || modelSelection(fallback);
    const legacySelection = saved[LEGACY_MODEL] || defaultSelection;
    const initial = {};
    if (!saved[DEFAULT_MODEL] && defaultSelection) initial[DEFAULT_MODEL] = defaultSelection;
    if (!saved[LEGACY_MODEL] && legacySelection) initial[LEGACY_MODEL] = legacySelection;
    if (Object.keys(initial).length) await storageAdapter.set(initial);
    return { defaultSelection, legacySelection };
}
export async function writeDefaultModel(config) {
    await readModelPreferences(config);
    const selection = modelSelection(config);
    if (selection) await storageAdapter.set({ [DEFAULT_MODEL]: selection });
    return selection;
}
