const imports = new WeakMap();
const changed = (input) => input.dispatchEvent(new Event('cerebr:filesReading'));
export const hasPendingFileImports = (input) => !!imports.get(input)?.size;
export const getPendingFileImports = (input) => [...(imports.get(input) || [])].filter(task => task.name);

export function beginFileImport(input, file = {}) {
    const pending = imports.get(input) || new Set();
    imports.set(input, pending);
    const controller = new AbortController();
    const task = {
        id: crypto.randomUUID(),
        name: file.name,
        type: file.type,
        signal: controller.signal,
        cancel() {
            controller.abort();
            task.finish();
        },
        finish() {
            if (pending.delete(task)) changed(input);
        },
    };
    pending.add(task);
    changed(input);
    return task;
}

export function cancelFileImports(input) {
    const pending = imports.get(input);
    imports.delete(input);
    for (const task of pending || []) task.cancel();
    changed(input);
}
