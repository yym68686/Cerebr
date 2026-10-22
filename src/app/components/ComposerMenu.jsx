import { useLayoutEffect, useRef, useState } from 'react';
import { t } from '../../utils/i18n.js';
import { MenuItem } from './common.jsx';
import { Icon } from './Icon.jsx';
import { WebpageIcon } from './WebpageIcon.jsx';
import { PluginMenuItems } from './PluginSurfaces.jsx';
import { WebpageMenu } from './WebpageMenu.jsx';

export function ComposerMenu({ ui, sources, events, onAddImages, onNewChat, onNavigate, developerMode }) {
    const choosingSources = ui.webpageMenu && sources.available;
    const menuRef = useRef(null);
    const [position, setPosition] = useState(null);
    useLayoutEffect(() => {
        if (!ui.menu || !choosingSources) {
            setPosition(null);
            return;
        }
        const composer = menuRef.current.closest('[data-composer]');
        if (!composer) return;
        const anchorTop =
            composer.getBoundingClientRect().top + composer.clientTop + menuRef.current.offsetTop;
        const place = () => {
            const rect = composer.getBoundingClientRect();
            // Keep the list's top edge stable when source chips grow below it.
            // Only its scrollable area shrinks, leaving the editor accessible.
            const top = Math.max(8, Math.min(anchorTop, rect.top - 148));
            const borderBottom = parseFloat(getComputedStyle(composer).borderBottomWidth) || 0;
            const distanceFromBottom = rect.bottom - borderBottom - top;
            // The composer's bottom stays fixed when source chips grow. CSS
            // resolves these percentages in the same layout pass as that growth;
            // a pixel top offset followed by ResizeObserver correction flashes.
            const next = {
                top: `calc(100% - ${distanceFromBottom}px)`,
                bottom: 'auto',
                maxHeight: `max(60px, calc(${distanceFromBottom - composer.clientTop - 8}px - 100%))`,
            };
            setPosition((previous) =>
                previous?.top === next.top && previous?.maxHeight === next.maxHeight ? previous : next
            );
        };
        place();
        const sizes = new ResizeObserver(place);
        sizes.observe(composer);
        window.addEventListener('resize', place);
        window.visualViewport?.addEventListener('resize', place);
        window.visualViewport?.addEventListener('scroll', place);
        return () => {
            sizes.disconnect();
            window.removeEventListener('resize', place);
            window.visualViewport?.removeEventListener('resize', place);
            window.visualViewport?.removeEventListener('scroll', place);
        };
    }, [ui.menu, choosingSources]);
    const focusEditor = () => document.getElementById('message-input')?.focus({ preventScroll: true });
    return (
        <div
            ref={menuRef}
            style={position}
            id="settings-menu"
            className={`${ui.menu ? 'visible' : ''}${choosingSources ? ' is-source-picker' : ''}`}
            role={choosingSources ? 'dialog' : 'menu'}
            aria-label={t(choosingSources ? 'composer_choose_webpages' : 'settings_menu_label')}
            onPointerDown={events.pin}
            onFocus={events.pin}
            onKeyDown={(event) => {
                if (choosingSources || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const items = [...event.currentTarget.querySelectorAll('[role="menuitem"]')].filter(
                    (item) => !item.closest('[hidden]') && item.getAttribute('aria-disabled') !== 'true'
                );
                const index = items.indexOf(document.activeElement);
                const next =
                    event.key === 'Home' || (index < 0 && event.key === 'ArrowDown')
                        ? 0
                        : event.key === 'End' || (index < 0 && event.key === 'ArrowUp')
                          ? items.length - 1
                          : (index + (event.key === 'ArrowUp' ? items.length - 1 : 1)) % items.length;
                items[next]?.focus({ preventScroll: true });
            }}
        >
            <div className="composer-menu-primary" hidden={choosingSources}>
                <MenuItem
                    id="composer-add-image"
                    label={t('composer_add_files')}
                    description={t('composer_add_files_hint')}
                    onClick={onAddImages}
                >
                    <Icon name="attachment" />
                </MenuItem>
                {sources.available && (
                    <>
                        <MenuItem
                            id="composer-current-page"
                            label={t('composer_current_page')}
                            description={
                                sources.current?.title ||
                                t(sources.loading ? 'webpage_tabs_loading' : 'composer_no_current_page')
                            }
                            disabled={!sources.current}
                            trailing={
                                sources.current && sources.switches[sources.current.id] === true ? (
                                    <Icon name="check" />
                                ) : null
                            }
                            onClick={async () => {
                                if (await sources.toggle([sources.current], true)) {
                                    events.close();
                                    focusEditor();
                                }
                            }}
                        >
                            <WebpageIcon tab={sources.current} />
                        </MenuItem>
                        <MenuItem
                            id="webpage-qa"
                            label={t('composer_choose_other_webpages')}
                            description={t('composer_choose_webpages_hint')}
                            onClick={events.openSources}
                            trailing={<Icon name="chevron-right" />}
                            aria-haspopup="dialog"
                            aria-controls="webpage-content-menu"
                        >
                            <Icon name="tabs" />
                        </MenuItem>
                    </>
                )}
                <div className="composer-menu-divider" role="separator" />
                <MenuItem id="new-chat" label={t('settings_new_chat')} onClick={onNewChat} />
                <MenuItem
                    id="chat-list"
                    label={t('settings_chat_list')}
                    onClick={() => onNavigate('history')}
                />
                <MenuItem
                    id="api-settings-toggle"
                    label={t('settings_api_settings')}
                    onClick={() => onNavigate('api')}
                />
                <MenuItem
                    id="preferences-toggle"
                    label={t('settings_preferences')}
                    onClick={() => onNavigate('preferences')}
                />
                <MenuItem
                    id="plugins-toggle"
                    label={t('settings_plugins')}
                    hidden={!developerMode}
                    onClick={() => onNavigate('plugins')}
                />
                <PluginMenuItems />
            </div>
            {ui.menu && choosingSources && (
                <WebpageMenu
                    sources={sources}
                    onBack={events.back}
                    onSelected={focusEditor}
                    onDone={() => {
                        events.close();
                        focusEditor();
                    }}
                />
            )}
        </div>
    );
}
