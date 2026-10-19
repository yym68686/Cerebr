// 浅比较：只比较顶层字段。store 里的值要么是原始值，要么整体替换（不做原地修改），
// 所以浅比较足够判断"这次 set 有没有真的改变状态"。
function isShallowEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const keysA = Object.keys(a);
    if (keysA.length !== Object.keys(b).length) return false;
    for (const key of keysA) {
        if (a[key] !== b[key]) return false;
    }
    return true;
}

export function createStore(initial) {
    let snapshot = initial;
    const listeners = new Set();
    return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        set(update) {
            const next = typeof update === 'function' ? update(snapshot) : { ...snapshot, ...update };
            // 流式回复期间 onPhase('replying', chatId) 每 100ms 调一次，值通常没变；
            // 无条件 notify 会让整棵 App 树（含四个常驻挂载的设置页）跟着重渲染。
            if (isShallowEqual(snapshot, next)) return;
            snapshot = next;
            listeners.forEach((listener) => listener());
        },
    };
}
