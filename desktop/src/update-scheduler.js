// Download updates in the background, but never request an unattended restart.
/** @param {{online?: () => boolean, now?: () => number}} [options] */
export function scheduleUpdateChecks(updater, options = {}) {
    const { online = () => true, now = Date.now } = options;
    let lastCheck = 0;
    const check = () => {
        if (!online() || ['checking', 'downloading', 'waiting', 'installing'].includes(updater.status.phase))
            return;
        if (lastCheck && updater.status.phase !== 'paused' && now() - lastCheck < 6 * 60 * 60 * 1000) return;
        lastCheck = now();
        void updater.check();
    };
    const startup = setTimeout(check, 15000);
    const interval = setInterval(check, 60000);
    startup.unref?.();
    interval.unref?.();
    return () => {
        clearTimeout(startup);
        clearInterval(interval);
    };
}
