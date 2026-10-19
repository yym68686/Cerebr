import { useEffect, useId, useRef, useState } from 'react';
import { t } from '../../utils/i18n.js';
import { Icon } from './Icon.jsx';

function ElapsedTime({ active, startedAt }) {
    const start = useRef(null);
    const wasActive = useRef(false);
    const [elapsed, setElapsed] = useState(null);
    useEffect(() => {
        const update = () => setElapsed(Math.max(0, Date.now() - start.current));
        if (!active) {
            if (wasActive.current && start.current !== null) update();
            wasActive.current = false;
            return;
        }
        wasActive.current = true;
        start.current = startedAt ?? Date.now();
        update();
        const timer = setInterval(update, 100);
        return () => clearInterval(timer);
    }, [active, startedAt]);
    if (elapsed === null) return null;
    const seconds = elapsed / 1000;
    const formatted =
        seconds < 60
            ? t('thinking_elapsed_seconds', [seconds.toFixed(1)])
            : t('thinking_elapsed_minutes', [Math.floor(seconds / 60), (seconds % 60).toFixed(1)]);
    // The status label is announced once; a ticking timer must not repeatedly interrupt speech.
    return (
        <span className="thinking-elapsed" aria-hidden="true">
            {formatted}
        </span>
    );
}

export function PixelGrid() {
    return (
        <span className="thinking-pixel-grid" aria-hidden="true">
            {Array.from({ length: 9 }, (_, index) => (
                <span
                    key={index}
                    style={{
                        '--pixel-delay': `${((index % 3) + Math.abs(Math.floor(index / 3) - 1)) * 90}ms`,
                    }}
                />
            ))}
        </span>
    );
}

export function LoadingState({ startedAt }) {
    return (
        <div className="thinking-loader" role="status" aria-label={t('label_thinking')}>
            <PixelGrid />
            <span className="thinking-shimmer" aria-hidden="true">
                {t('label_thinking')}
            </span>
            <ElapsedTime active startedAt={startedAt} />
        </div>
    );
}

export function ThinkingState({ active, startedAt, children }) {
    const id = useId();
    const [manualExpanded, setManualExpanded] = useState(null);
    const expanded = manualExpanded ?? active;
    return (
        <section className={`reasoning-wrapper${active ? ' is-thinking' : ''}`}>
            <button
                type="button"
                className="reasoning-toggle"
                aria-label={t(active ? 'label_thinking' : 'label_reasoning_process')}
                aria-expanded={expanded}
                aria-controls={id}
                onClick={() => setManualExpanded(!expanded)}
            >
                <Icon name="sparkle" />
                <span role="status" className={active ? 'thinking-shimmer' : 'reasoning-label'}>
                    {t(active ? 'label_thinking' : 'label_reasoning_process')}
                </span>
                <ElapsedTime active={active} startedAt={startedAt} />
                <span className="reasoning-chevron">
                    <Icon name="chevron-down" />
                </span>
            </button>
            <div
                id={id}
                className={`reasoning-content${expanded ? '' : ' collapsed'}`}
                aria-hidden={!expanded}
                inert={!expanded}
            >
                <div className="reasoning-clip">
                    <div className="reasoning-trace">{children}</div>
                </div>
            </div>
        </section>
    );
}
