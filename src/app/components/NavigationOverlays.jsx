import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from '../../utils/i18n.js';
import { Icon } from './Icon.jsx';

export function NavigationMenu({
    target,
    folders,
    assigned,
    onClose,
    onMove,
    onCreateFolder,
    onRename,
    onDelete,
}) {
    const ref = useRef(null);
    const [moving, setMoving] = useState(false);
    useLayoutEffect(() => {
        const menu = ref.current;
        const height = window.visualViewport?.height || innerHeight;
        menu.style.left = `${Math.max(8, Math.min(target.x, innerWidth - menu.offsetWidth - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(target.y, height - menu.offsetHeight - 8))}px`;
        menu.focus({ preventScroll: true });
    }, [target, moving, folders.length]);
    useEffect(() => {
        const outside = (event) => {
            if (!ref.current?.contains(event.target)) onClose(false);
        };
        const close = (event) => {
            if (!ref.current?.contains(event.target)) onClose(false);
        };
        document.addEventListener('pointerdown', outside);
        document.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
        return () => {
            document.removeEventListener('pointerdown', outside);
            document.removeEventListener('scroll', close, true);
            window.removeEventListener('resize', close);
        };
    }, [onClose]);
    const action = (callback) => {
        onClose(false);
        callback();
    };
    return (
        <div
            ref={ref}
            className="navigation-menu"
            role="menu"
            tabIndex={-1}
            aria-label={t(moving ? 'nav_move_to_folder' : 'nav_chat_actions')}
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    event.stopPropagation();
                    event.preventDefault();
                    if (moving) setMoving(false);
                    else onClose(true);
                    return;
                }
                if (event.key === 'Tab') {
                    onClose(false);
                    return;
                }
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const items = [...ref.current.querySelectorAll('[role^="menuitem"]')];
                const i = items.indexOf(document.activeElement);
                const next =
                    event.key === 'Home' || (i < 0 && event.key === 'ArrowDown')
                        ? 0
                        : event.key === 'End' || (i < 0 && event.key === 'ArrowUp')
                          ? items.length - 1
                          : (i + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
                items[next]?.focus();
            }}
        >
            {moving ? (
                <>
                    <button role="menuitem" type="button" onClick={() => setMoving(false)}>
                        <Icon name="back" />
                        {t('nav_move_to_folder')}
                    </button>
                    <div className="navigation-menu-divider" role="separator" />
                    <button
                        role="menuitemradio"
                        aria-checked={!assigned}
                        type="button"
                        onClick={() => action(() => onMove(null))}
                    >
                        <Icon name="chat-list" />
                        <span>{t('nav_unfiled')}</span>
                        {!assigned && <Icon name="check" />}
                    </button>
                    {folders.map((folder) => (
                        <button
                            key={folder.id}
                            role="menuitemradio"
                            aria-checked={assigned === folder.id}
                            type="button"
                            onClick={() => action(() => onMove(folder.id))}
                        >
                            <Icon name="folder" />
                            <span>{folder.name}</span>
                            {assigned === folder.id && <Icon name="check" />}
                        </button>
                    ))}
                    <div className="navigation-menu-divider" role="separator" />
                    <button role="menuitem" type="button" onClick={() => action(onCreateFolder)}>
                        <Icon name="folder-plus" />
                        {t('nav_new_folder')}
                    </button>
                </>
            ) : (
                <>
                    {target.kind === 'chat' && (
                        <button role="menuitem" type="button" onClick={() => setMoving(true)}>
                            <Icon name="folder" />
                            <span>{t('nav_move_to_folder')}</span>
                            <Icon name="chevron-right" />
                        </button>
                    )}
                    <button role="menuitem" type="button" onClick={() => action(onRename)}>
                        <Icon name="edit-message" />
                        <span>{t('nav_rename')}</span>
                    </button>
                    <div className="navigation-menu-divider" role="separator" />
                    <button
                        className="navigation-destructive"
                        role="menuitem"
                        type="button"
                        onClick={() => action(onDelete)}
                    >
                        <Icon name="delete-message" />
                        <span>
                            {t(target.kind === 'chat' ? 'chat_delete_chat_aria' : 'nav_delete_folder')}
                        </span>
                    </button>
                </>
            )}
        </div>
    );
}

export function NavigationDialog({ dialog, onClose, onSubmit }) {
    const [value, setValue] = useState(dialog.name || '');
    const [error, setError] = useState(''),
        [busy, setBusy] = useState(false);
    const ref = useRef(null),
        inputRef = useRef(null),
        cancelRef = useRef(null);
    const deleting = dialog.type.startsWith('delete');
    const title = t(
        dialog.type === 'createFolder'
            ? 'nav_new_folder'
            : dialog.type === 'deleteFolder'
              ? 'nav_delete_folder'
              : dialog.type === 'deleteChat'
                ? 'chat_delete_chat_aria'
                : 'nav_rename'
    );
    useLayoutEffect(() => {
        const before = document.activeElement;
        (deleting ? cancelRef : inputRef).current?.focus();
        inputRef.current?.select();
        return () => {
            if (before?.isConnected) before.focus({ preventScroll: true });
        };
    }, []);
    return (
        <div
            className="navigation-dialog-backdrop"
            onClick={(event) => {
                if (event.target === event.currentTarget && !busy) onClose();
            }}
        >
            <form
                ref={ref}
                className="navigation-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="navigation-dialog-title"
                onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                        event.stopPropagation();
                        event.preventDefault();
                        if (!busy) onClose();
                    }
                    if (event.key === 'Tab') {
                        const items = [...ref.current.querySelectorAll('input, button')].filter(
                            (item) => !item.disabled
                        );
                        if (!items.length) {
                            event.preventDefault();
                            return;
                        }
                        if (event.shiftKey && document.activeElement === items[0]) {
                            event.preventDefault();
                            items.at(-1).focus();
                        } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
                            event.preventDefault();
                            items[0].focus();
                        }
                    }
                }}
                onSubmit={async (event) => {
                    event.preventDefault();
                    if (busy) return;
                    setBusy(true);
                    setError('');
                    try {
                        await onSubmit(value.trim());
                        onClose();
                    } catch (error) {
                        setError(t(error.message));
                        setBusy(false);
                    }
                }}
            >
                <h2 id="navigation-dialog-title">{title}</h2>
                {deleting ? (
                    <p>
                        {t(
                            dialog.type === 'deleteFolder'
                                ? 'nav_delete_folder_hint'
                                : 'nav_delete_chat_hint',
                            [dialog.name]
                        )}
                    </p>
                ) : (
                    <input
                        ref={inputRef}
                        aria-label={title}
                        value={value}
                        maxLength={80}
                        onChange={(event) => setValue(event.target.value)}
                        required
                        autoComplete="off"
                        disabled={busy}
                    />
                )}
                {error && (
                    <p className="navigation-error" role="alert">
                        {error}
                    </p>
                )}
                <div className="navigation-dialog-actions">
                    <button type="button" ref={cancelRef} disabled={busy} onClick={onClose}>
                        {t('nav_cancel')}
                    </button>
                    <button
                        className="navigation-dialog-confirm"
                        type="submit"
                        disabled={busy || (!deleting && !value.trim())}
                    >
                        {t(deleting ? 'nav_delete_confirm' : 'nav_save')}
                    </button>
                </div>
            </form>
        </div>
    );
}
