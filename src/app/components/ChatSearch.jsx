import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { findChatMatches } from '../../runtime/search/chat-search.js';
import { t } from '../../utils/i18n.js';
import { Icon } from './Icon.jsx';

export function ChatSearch({ containerRef, chatId, disabled }) {
    const [open, setOpen] = useState(false),
        [query, setQuery] = useState('');
    const [matches, setMatches] = useState([]),
        [index, setIndex] = useState(0),
        [rects, setRects] = useState([]);
    const input = useRef(null),
        previousFocus = useRef(null),
        navigate = useRef(false);
    const close = () => {
        setOpen(false);
        if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
    };
    useEffect(() => {
        const show = (event) => {
            if (disabled) return;
            if (
                event &&
                (event.isComposing ||
                    event.altKey ||
                    !(event.metaKey || event.ctrlKey) ||
                    event.key?.toLowerCase() !== 'f')
            )
                return;
            event?.preventDefault();
            event?.stopPropagation();
            if (!open) previousFocus.current = document.activeElement;
            setOpen(true);
            input.current?.focus({ preventScroll: true });
            input.current?.select();
        };
        document.addEventListener('keydown', show, true);
        const detach = globalThis.cerebrDesktop?.onFind?.(() => show());
        return () => {
            document.removeEventListener('keydown', show, true);
            detach?.();
        };
    }, [disabled, open]);
    useEffect(() => {
        if (disabled) setOpen(false);
    }, [disabled]);
    useLayoutEffect(() => {
        if (open) {
            input.current?.focus({ preventScroll: true });
            input.current?.select();
        }
    }, [open]);
    useEffect(() => {
        if (!open) return;
        const container = containerRef.current;
        let timer;
        const update = () => {
            setMatches(findChatMatches(container, query));
        };
        update();
        const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(update, 100);
        });
        observer.observe(container, { subtree: true, childList: true, characterData: true });
        return () => {
            observer.disconnect();
            clearTimeout(timer);
        };
    }, [open, query, chatId, containerRef]);
    useEffect(() => {
        setIndex(0);
        navigate.current = !!query;
    }, [query, chatId]);
    const current = Math.min(index, Math.max(0, matches.length - 1));
    useLayoutEffect(() => {
        if (!open) return;
        const container = containerRef.current,
            range = matches[current];
        if (navigate.current && range) {
            navigate.current = false;
            container.__cerebrUserPausedAutoScroll = true;
            const bounds = range.getBoundingClientRect(),
                viewport = container.getBoundingClientRect();
            container.scrollTop += bounds.top - viewport.top - container.clientHeight * 0.35;
        }
        if (globalThis.CSS?.highlights && globalThis.Highlight) {
            CSS.highlights.set('cerebr-search', new Highlight(...matches));
            CSS.highlights.set('cerebr-search-current', new Highlight(...(range ? [range] : [])));
            return () => {
                CSS.highlights.delete('cerebr-search');
                CSS.highlights.delete('cerebr-search-current');
            };
        }
        const measure = () => {
            const bounds = container.getBoundingClientRect();
            setRects(
                matches.flatMap((match, i) =>
                    [...match.getClientRects()]
                        .filter((r) => r.bottom > bounds.top && r.top < bounds.bottom)
                        .map((r) => ({
                            x: r.x,
                            y: r.y,
                            width: r.width,
                            height: r.height,
                            active: i === current,
                        }))
                )
            );
        };
        measure();
        container.addEventListener('scroll', measure);
        window.addEventListener('resize', measure);
        return () => {
            container.removeEventListener('scroll', measure);
            window.removeEventListener('resize', measure);
        };
    }, [open, matches, current, containerRef]);
    const move = (delta) => {
        if (!matches.length) return;
        navigate.current = true;
        setIndex((current + delta + matches.length) % matches.length);
    };
    if (!open) return null;
    return (
        <>
            <div
                className="chat-find"
                role="search"
                aria-label={t('chat_find_title')}
                onKeyDown={(event) => {
                    if (event.isComposing) return;
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        close();
                    }
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        move(event.shiftKey ? -1 : 1);
                    }
                }}
            >
                <Icon name="search" />
                <input
                    ref={input}
                    type="text"
                    value={query}
                    spellCheck={false}
                    placeholder={t('chat_find_placeholder')}
                    aria-label={t('chat_find_title')}
                    onChange={(event) => setQuery(event.target.value)}
                />
                <span className="chat-find-count" aria-live="polite">
                    {query ? `${matches.length ? current + 1 : 0} / ${matches.length}` : ''}
                </span>
                <span className="chat-find-divider" />
                <button
                    type="button"
                    disabled={!matches.length}
                    onClick={() => move(-1)}
                    aria-label={t('chat_find_previous')}
                >
                    <Icon name="chevron-down" />
                </button>
                <button
                    type="button"
                    disabled={!matches.length}
                    onClick={() => move(1)}
                    aria-label={t('chat_find_next')}
                >
                    <Icon name="chevron-down" />
                </button>
                <button type="button" onClick={close} aria-label={t('chat_find_close')}>
                    <Icon name="close" />
                </button>
            </div>
            {!globalThis.CSS?.highlights && (
                <div className="chat-find-marks" aria-hidden="true">
                    {rects.map((r, i) => (
                        <span
                            key={i}
                            className={r.active ? 'is-current' : ''}
                            style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
                        />
                    ))}
                </div>
            )}
        </>
    );
}
