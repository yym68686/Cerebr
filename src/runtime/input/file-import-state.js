const imports = new WeakMap();
const changed = (input) => input.dispatchEvent(new Event('cerebr:filesReading'));
export const hasPendingFileImports = (input) => !!imports.get(input)?.size;

export function beginFileImport(input) {
    const pending = imports.get(input) || new Set();
    imports.set(input, pending);
    const controller = new AbortController();
    pending.add(controller);
    changed(input);
    return {
        signal: controller.signal,
        finish() {
            pending.delete(controller);
            changed(input);
        },
    };
}

export function cancelFileImports(input) {
    const pending = imports.get(input);
    imports.delete(input);
    for (const controller of pending || []) controller.abort();
    changed(input);
}
