import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../utils/i18n.js';
import { Icon } from './Icon.jsx';
import { WebpageIcon } from './WebpageIcon.jsx';

function Selection({ checked, mixed = false, label, onChange }) {
    const ref = useRef(null);
    useLayoutEffect(() => {
        ref.current.indeterminate = mixed;
    }, [mixed]);
    return (
        <input
            ref={ref}
            type="checkbox"
            checked={checked}
            aria-label={label}
            onChange={(event) => onChange(event.target.checked)}
        />
    );
}
function hostname(url) {
    try {
        return new URL(url).hostname || url;
    } catch {
        return url;
    }
}

export function WebpageMenu({ sources, onBack, onDone, onSelected }) {
    const searchRef = useRef(null),
        listRef = useRef(null);
    const [search, setSearch] = useState(''),
        [collapsed, setCollapsed] = useState({});
    useLayoutEffect(() => {
        searchRef.current?.focus({ preventScroll: true });
    }, []);
    const groups = useMemo(() => {
        const items = new Map();
        for (const tab of sources.tabs) {
            const id = tab.groupId >= 0 ? tab.groupId : -1;
            if (!items.has(id)) items.set(id, []);
            items.get(id).push(tab);
        }
        return [...items];
    }, [sources.tabs]);
    const query = search.trim().toLowerCase();
    const hasGroups = groups.some(([id]) => id >= 0);
    const enabled = (tab) => sources.switches[tab.id] === true;
    const toggle = async (tabs, value) => {
        if (await sources.toggle(tabs, value)) onSelected?.();
    };
    let count = 0;
    return (
        <div
            id="webpage-content-menu"
            className="composer-source-picker"
            onKeyDown={(event) => {
                if (
                    event.key === 'Escape' ||
                    (event.key === 'ArrowLeft' && event.target !== searchRef.current)
                ) {
                    event.stopPropagation();
                    event.preventDefault();
                    onBack();
                    return;
                }
                const items = [...listRef.current.querySelectorAll('input[type="checkbox"], button')].filter(
                    (item) => !item.closest('[hidden]')
                );
                const index = items.indexOf(document.activeElement);
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                if (event.target === searchRef.current && !['ArrowDown', 'ArrowUp'].includes(event.key))
                    return;
                event.preventDefault();
                const next =
                    event.key === 'Home' || (index < 0 && event.key === 'ArrowDown')
                        ? 0
                        : event.key === 'End' || (index < 0 && event.key === 'ArrowUp')
                          ? items.length - 1
                          : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
                items[next]?.focus();
            }}
        >
            <div className="composer-picker-header">
                <button type="button" onClick={onBack} aria-label={t('composer_back_to_menu')}>
                    <Icon name="back" />
                </button>
                <span>{t('composer_choose_webpages')}</span>
            </div>
            <label className="composer-picker-search">
                <Icon name="search" />
                <input
                    ref={searchRef}
                    type="search"
                    autoComplete="off"
                    spellCheck={false}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t('webpage_tabs_search_placeholder')}
                    aria-label={t('webpage_tabs_search_placeholder')}
                />
            </label>
            <div className="composer-picker-results" ref={listRef}>
                {sources.loading && <div className="composer-picker-status">{t('webpage_tabs_loading')}</div>}
                {sources.error && (
                    <div className="composer-picker-status" role="alert">
                        {t('composer_sources_load_error')}
                        <button type="button" onClick={() => void sources.refresh()}>
                            {t('composer_retry')}
                        </button>
                    </div>
                )}
                {groups.map(([id, tabs]) => {
                    const group = sources.groups[id];
                    const title =
                        id === -1
                            ? t('webpage_group_ungrouped')
                            : group?.title || `${t('webpage_group_default_name')} ${id}`;
                    const shown = tabs.filter(
                        (tab) => !query || `${title}\n${tab.title}\n${tab.url}`.toLowerCase().includes(query)
                    );
                    count += shown.length;
                    if (!shown.length) return null;
                    const isCollapsed = !query && (collapsed[id] ?? group?.collapsed ?? false);
                    const all = shown.every(enabled),
                        some = shown.some(enabled);
                    return (
                        <div className="composer-picker-group" key={id}>
                            {hasGroups && (
                                <div className="composer-picker-group-heading">
                                    <button
                                        type="button"
                                        aria-expanded={!isCollapsed}
                                        onClick={() =>
                                            setCollapsed((previous) => ({ ...previous, [id]: !isCollapsed }))
                                        }
                                    >
                                        <Icon name="chevron-down" />
                                        <span>{title}</span>
                                        <span>{shown.length}</span>
                                    </button>
                                    <Selection
                                        label={t('composer_select_group', [title])}
                                        checked={all}
                                        mixed={!all && some}
                                        onChange={(value) => void toggle(shown, value)}
                                    />
                                </div>
                            )}
                            <div hidden={hasGroups && isCollapsed}>
                                {shown.map((tab) => (
                                    <label className="composer-picker-item" key={tab.id}>
                                        <WebpageIcon tab={tab} />
                                        <span className="composer-picker-page">
                                            <span
                                                className="composer-picker-title"
                                                title={tab.title || tab.url}
                                            >
                                                {tab.title || tab.url}
                                            </span>
                                            <span className="composer-picker-detail">
                                                {/^https?:\/\//i.test(tab.url) ? <a href={tab.url} target="_blank" rel="noopener noreferrer" title={tab.url}
                                                    onClick={event => event.stopPropagation()}>{hostname(tab.url)}</a> : hostname(tab.url)}
                                                {tab.id === sources.current?.id
                                                    ? ` · ${t('composer_current_page')}`
                                                    : ''}
                                            </span>
                                        </span>
                                        <Selection
                                            label={tab.title || tab.url}
                                            checked={enabled(tab)}
                                            onChange={(value) => void toggle([tab], value)}
                                        />
                                    </label>
                                ))}
                            </div>
                        </div>
                    );
                })}
                {!count && !sources.loading && !sources.error && (
                    <div className="composer-picker-status">
                        {t(query ? 'webpage_tabs_no_match' : 'webpage_tabs_empty')}
                    </div>
                )}
            </div>
            <div className="composer-picker-footer">
                <span aria-live="polite">{t('composer_selected_webpages', [sources.selected.length])}</span>
                <button type="button" onClick={onDone}>
                    {t('composer_done')}
                </button>
            </div>
        </div>
    );
}
