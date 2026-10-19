import { useEffect, useState } from 'react';
// Keep long local archives from blocking the composer while React mounts rows.
export function useProgressiveCount(key, total, chunk = 40) {
    const [state, setState] = useState({ key, count: Math.min(total, chunk) });
    const count = state.key === key ? Math.min(total, state.count) : Math.min(total, chunk);
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
            setState({ key, count: next });
            if (next < total) task = schedule(advance);
        };
        if (count < total || state.key !== key) task = schedule(advance);
        return () => {
            cancelled = true;
            if (typeof cancelIdleCallback === 'function') cancelIdleCallback(task);
            else clearTimeout(task);
        };
    }, [key, total]);
    return count;
}
