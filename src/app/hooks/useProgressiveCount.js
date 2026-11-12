import { useEffect, useState } from 'react';
// Keep long local archives from blocking the composer while React mounts rows.
export function useProgressiveCount(key, total, chunk = 40) {
    const [state, setState] = useState({ key, total, count: Math.min(total, chunk) });
    // Once history is mounted, new messages must appear in the same render.
    // Idle scheduling is only for loading an archive, never for a live send.
    const count = state.key === key
        ? state.count >= state.total && total - state.total <= chunk ? total : Math.min(total, state.count)
        : Math.min(total, chunk);
    useEffect(() => {
        let cancelled = false,
            task;
        let next = count;
        const schedule = (callback) =>
            typeof requestIdleCallback === 'function'
                ? requestIdleCallback(callback, { timeout: 150 })
                : setTimeout(callback, 0);
        const advance = () => {
            if (cancelled) return;
            next = Math.min(total, next + chunk);
            setState({ key, total, count: next });
            if (next < total) task = schedule(advance);
        };
        if (count < total || state.key !== key) task = schedule(advance);
        else if (state.total !== total) setState({ key, total, count });
        return () => {
            cancelled = true;
            if (typeof cancelIdleCallback === 'function') cancelIdleCallback(task);
            else clearTimeout(task);
        };
    }, [key, total]);
    return count;
}
