import { useEffect, useRef, useState } from 'react';
import { t } from '../../utils/i18n.js';
import { openPage } from '../state/ui-store.js';

function ShareDialog({ title, onClose, children }) {
    const ref = useRef(null);
    useEffect(() => {
        const previous = document.activeElement;
        ref.current?.focus();
        return () => {
            if (previous?.isConnected) previous.focus?.({ preventScroll: true });
        };
    }, []);
    return (
        <div
            className="navigation-dialog-backdrop"
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                ref={ref}
                className="navigation-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={title}
                tabIndex={-1}
                onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                        event.stopPropagation();
                        onClose();
                    }
                    if (event.key === 'Tab') {
                        const items = [...ref.current.querySelectorAll('input,button')];
                        if (!items.length) {
                            event.preventDefault();
                            return;
                        }
                        if (
                            event.shiftKey &&
                            (document.activeElement === items[0] || document.activeElement === ref.current)
                        ) {
                            event.preventDefault();
                            items.at(-1).focus();
                        } else if (
                            !event.shiftKey &&
                            (document.activeElement === items.at(-1) ||
                                document.activeElement === ref.current)
                        ) {
                            event.preventDefault();
                            items[0].focus();
                        }
                    }
                }}
            >
                <h2>{title}</h2>
                {children}
            </div>
        </div>
    );
}

export function SharedLinkDialog({ url, onClose }) {
    const [copied, setCopied] = useState(false);
    return (
        <ShareDialog title={t('share_copy_link')} onClose={onClose}>
            <input
                readOnly
                aria-label={t('share_copy_link')}
                value={url}
                onFocus={(event) => event.target.select()}
            />
            <div className="navigation-dialog-actions">
                <button onClick={onClose}>{t('nav_cancel')}</button>
                <button
                    onClick={() => {
                        void navigator.clipboard?.writeText(url)?.then(
                            () => setCopied(true),
                            () => {}
                        );
                    }}
                >
                    {t(copied ? 'share_copied' : 'share_copy_link')}
                </button>
            </div>
        </ShareDialog>
    );
}

export function useSharedConversation(session) {
    const [hash, setHash] = useState(location.hash),
        [attempt, setAttempt] = useState(0),
        [state, setState] = useState(null);
    useEffect(() => {
        const changed = () => setHash(location.hash);
        window.addEventListener('hashchange', changed);
        return () => window.removeEventListener('hashchange', changed);
    }, []);
    const close = () => {
        history.replaceState(null, '', location.pathname + location.search);
        setHash('');
        setState(null);
    };
    useEffect(() => {
        if (!session || !hash.startsWith('#/share/')) return;
        let active = true;
        let switching = false;
        let previewed = state?.hash === hash && !!state.chat;
        const controller = new AbortController();
        setState((previous) => ({ hash, chat: previous?.hash === hash ? previous.chat : null }));
        openPage(null);
        const navigated = () => {
            if (!switching) close();
        };
        document.addEventListener('cerebr:chatSwitched', navigated);
        void import('../../runtime/chat/conversation-share.js')
            .then(async ({ shareIdFromHash, importConversation }) => {
                const id = shareIdFromHash(hash);
                if (!id) throw new Error('share_unavailable');
                const chatId = await importConversation(id, {
                    signal: controller.signal,
                    onPreview: (chat) => {
                        previewed = true;
                        if (active) setState({ hash, chat });
                    },
                });
                if (!active) return;
                switching = true;
                await session.switchChat(chatId, { restoreReadingProgress: !previewed });
                if (active) close();
            })
            .catch((error) => {
                if (active)
                    setState((previous) => ({ ...previous, hash, error: t(error.message) }));
            });
        return () => {
            active = false;
            controller.abort();
            document.removeEventListener('cerebr:chatSwitched', navigated);
        };
    }, [hash, session, attempt]);
    const current = state?.hash === hash ? state : null;
    return {
        pending: hash.startsWith('#/share/'),
        chat: current?.chat,
        error: current?.error,
        close,
        retry: () => setAttempt((value) => value + 1),
    };
}

export function SharedConversationStatus({ shared }) {
    if (!shared.pending || (shared.chat && !shared.error)) return null;
    return (
        <div className={`shared-conversation-status${shared.chat ? ' has-preview' : ''}`}>
            {!shared.error ? (
                <div role="status" aria-label={t('share_loading')}>
                    <span className="pdf-preview-spinner" aria-hidden="true" />
                </div>
            ) : (
                <>
                    <p role="alert" className="navigation-error">{shared.error}</p>
                    <div className="shared-conversation-actions">
                        <button onClick={shared.close}>{t('nav_cancel')}</button>
                        <button onClick={shared.retry}>{t('share_retry')}</button>
                    </div>
                </>
            )}
        </div>
    );
}
