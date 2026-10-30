import { Fragment, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { CheckCircle, InfoCircle, WarningCircle } from 'iconoir-react';
import { chatManager } from '../../domain/chat/chat-store.js';
import { uiStore, notify } from '../state/ui-store.js';
import { t } from '../../utils/i18n.js';
import { Icon } from './Icon.jsx';
import { isReplyTarget, resolveMessageTarget } from '../message-actions.js';
import { copyMessageImage } from '../../render/message/message-clipboard.js';
import { contentText } from './Messages.jsx';
import { useImagePreviewGestures } from '../hooks/useImagePreviewGestures.js';

export function ContextMenu({ context, session }) {
    useSyncExternalStore(chatManager.subscribe, chatManager.getSnapshot);
    const state = useSyncExternalStore(uiStore.subscribe, uiStore.getSnapshot);
    const ref = useRef(null);
    const focusedContext = useRef(null);
    const resolved = resolveMessageTarget(chatManager.getCurrentChat(), context);
    const message = resolved?.message;
    const updating = !!resolved && isReplyTarget(resolved.chat, resolved.index, state);
    const visible = !!resolved && (!!message || updating);
    const canEdit = message && !updating && ['user', 'assistant'].includes(message.role);
    const canRegenerate =
        message &&
        !message.seedLocaleBound &&
        (message.role === 'user' ||
            (message.role === 'assistant' && resolved.chat.messages[resolved.index - 1]?.role === 'user'));
    useLayoutEffect(() => {
        if (!visible) {
            focusedContext.current = null;
            return;
        }
        const el = ref.current;
        const { width, height } = el.getBoundingClientRect();
        el.style.left = `${Math.max(8, Math.min(context.x, innerWidth - width - 8))}px`;
        el.style.top = `${Math.max(8, Math.min(context.y, innerHeight - height - 8))}px`;
        // 打开时仅聚焦菜单，不预选操作；流式状态变化时保留仍然存在的菜单项焦点。
        if (focusedContext.current !== context || !el.contains(document.activeElement)) {
            el.focus({ preventScroll: true });
        }
        focusedContext.current = context;
    }, [context, visible, updating]);
    const copy = async (text, success) => {
        await navigator.clipboard.writeText(text);
        notify(t(success), { type: 'success' });
    };
    const actions = [
        [
            'copy-message',
            'context_copy_message',
            !!message,
            () => copy(contentText(message.content), 'toast_copied_message'),
        ],
        ['edit-message', 'context_edit_message', canEdit, () => session?.startEdit(context)],
        [
            'copy-code',
            'context_copy_code',
            context?.code !== undefined,
            () => copy(context.code, 'toast_copied_code'),
        ],
        [
            'copy-image',
            'context_copy_image',
            !!context?.image,
            async () => {
                await copyMessageImage(context.image);
                notify(t('toast_copied_image'), { type: 'success' });
            },
        ],
        ['copy-math', 'context_copy_math', !!context?.math, () => copy(context.math, 'toast_copied_math')],
        [
            'regenerate-message',
            'context_regenerate',
            canRegenerate,
            () => session?.regenerateMessage(context),
        ],
        ['stop-update', 'context_stop_update', updating, () => session?.pipeline.abortActiveReply()],
        [
            'delete-message',
            'context_delete_message',
            !!message || updating,
            () => session?.deleteMessage(context),
        ],
    ].filter(([, , shown]) => shown);
    return (
        <div
            id="context-menu"
            className={visible ? 'visible' : ''}
            ref={ref}
            role="menu"
            tabIndex={-1}
            aria-label={t('context_menu_label')}
            onKeyDown={(e) => {
                const nodes = [...e.currentTarget.querySelectorAll('[role="menuitem"]')];
                if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
                    e.preventDefault();
                    const index = nodes.indexOf(document.activeElement);
                    const next =
                        e.key === 'Home' || (index < 0 && e.key === 'ArrowDown')
                            ? 0
                            : e.key === 'End' || (index < 0 && e.key === 'ArrowUp')
                              ? nodes.length - 1
                              : (index + (e.key === 'ArrowDown' ? 1 : nodes.length - 1)) % nodes.length;
                    nodes[next]?.focus({ preventScroll: true });
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    uiStore.set({ context: null });
                    context?.returnFocus?.focus?.({ preventScroll: true });
                }
            }}
        >
            {visible &&
                actions.map(([id, label, , handler], index) => (
                    <Fragment key={id}>
                        {id === 'delete-message' && index > 0 && (
                            <div className="context-menu-separator" role="separator" />
                        )}
                        <div
                            className="context-menu-item"
                            id={id}
                            role="menuitem"
                            tabIndex={0}
                            onClick={() => {
                                uiStore.set({ context: null });
                                try {
                                    Promise.resolve(handler()).catch((e) =>
                                        notify(e.message, { type: 'error' })
                                    );
                                } catch (error) {
                                    notify(error.message, { type: 'error' });
                                }
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    e.currentTarget.click();
                                }
                            }}
                        >
                            <Icon name={id} />
                            <span>{t(label)}</span>
                        </div>
                    </Fragment>
                ))}
        </div>
    );
}
export function ImagePreview({ image }) {
    const closeRef = useRef(null);
    const { viewportRef, imageRef, view, dragging, onClickCapture } = useImagePreviewGestures(image);
    // Restore focus after React's commit-time selection restoration has finished.
    useEffect(() => {
        if (!image) return;
        const old = document.activeElement;
        closeRef.current?.focus();
        return () => old?.isConnected && old.focus?.({ preventScroll: true });
    }, [image]);
    return (
        <div
            ref={viewportRef}
            className={`image-preview-modal${image ? ' visible' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-label={t('image_preview_label')}
            onClickCapture={onClickCapture}
            onClick={(e) => {
                if (e.target === e.currentTarget) uiStore.set({ image: null });
            }}
            onKeyDown={(e) => {
                if (e.key === 'Tab') {
                    e.preventDefault();
                    closeRef.current.focus();
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    uiStore.set({ image: null });
                }
            }}
        >
            <div className={`image-preview-content${dragging ? ' is-dragging' : ''}`} role="document">
                <img
                    ref={imageRef}
                    src={image || undefined}
                    alt={t('image_preview_alt')}
                    draggable={false}
                    style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }}
                />
                <button
                    ref={closeRef}
                    className="image-preview-close"
                    aria-label={t('image_preview_close_aria')}
                    onClick={() => uiStore.set({ image: null })}
                >
                    <svg viewBox="0 0 24 24" fill="none">
                        <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeLinecap="round" />
                    </svg>
                </button>
            </div>
        </div>
    );
}
export function Toasts({ toasts }) {
    return (
        <div
            id="toast-container"
            className="toast-container"
            role="status"
            aria-live="polite"
            aria-atomic="true"
        >
            {toasts.map((toast) => {
                const StatusIcon =
                    toast.type === 'success'
                        ? CheckCircle
                        : toast.type === 'error'
                          ? WarningCircle
                          : InfoCircle;
                return (
                    <div
                        key={toast.id}
                        className={`toast toast--${toast.type}${toast.hiding ? ' toast--hide' : ''}`}
                    >
                        <StatusIcon
                            className="toast__icon"
                            width={16}
                            height={16}
                            strokeWidth={1.8}
                            aria-hidden
                        />
                        <span className="toast__message">{toast.message}</span>
                    </div>
                );
            })}
        </div>
    );
}
