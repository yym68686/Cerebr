// Local and cloud transports can deliver the same lifecycle out of order.
// Keep the terminal watermark so a delayed chunk cannot restart a settled spinner.
export function createProgressTracker() {
    const latest = new Map();
    return {
        accept(value) {
            if (value?.reset) {
                latest.clear();
                return true;
            }
            if (!value?.chatId || !['thinking', 'replying', 'idle'].includes(value.phase)) return false;
            const previous = latest.get(value.chatId);
            const startedAt = Number(value.startedAt) || previous?.startedAt || 0;
            if (
                previous &&
                (startedAt < previous.startedAt ||
                    (startedAt === previous.startedAt &&
                        ((previous.phase === 'idle' && value.phase !== 'idle') ||
                            (previous.phase === 'replying' && value.phase === 'thinking'))))
            )
                return false;
            latest.set(value.chatId, { startedAt, phase: value.phase });
            return true;
        },
    };
}
